import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/withdrawal_flow.dart';
import '../config/backend_contract.dart';
import '../services/withdrawal_gateway.dart';
import '../services/withdrawal_recovery_store.dart';

enum WithdrawalFlowPhase {
  initial,
  checkingEligibility,
  selectingBank,
  loadingBanks,
  verifyingBank,
  bankVerificationFailed,
  reviewing,
  creating,
  verificationRequired,
  limitReached,
  pendingReview,
  processing,
  payoutFailed,
  successful,
  reversed,
  unavailable,
}

class WithdrawalFlowState {
  const WithdrawalFlowState({
    this.phase = WithdrawalFlowPhase.initial,
    this.intent,
    this.bankAccounts = const [],
    this.selectedBankAccount,
    this.withdrawal,
    this.error,
    this.pollAttempt = 0,
  });

  final WithdrawalFlowPhase phase;
  final WithdrawalIntent? intent;
  final List<WithdrawalBankAccount> bankAccounts;
  final WithdrawalBankAccount? selectedBankAccount;
  final WithdrawalData? withdrawal;
  final String? error;
  final int pollAttempt;

  bool get isCreating => phase == WithdrawalFlowPhase.creating;

  WithdrawalFlowState copyWith({
    WithdrawalFlowPhase? phase,
    WithdrawalIntent? intent,
    List<WithdrawalBankAccount>? bankAccounts,
    WithdrawalBankAccount? selectedBankAccount,
    WithdrawalData? withdrawal,
    String? error,
    bool clearError = false,
    int? pollAttempt,
  }) => WithdrawalFlowState(
    phase: phase ?? this.phase,
    intent: intent ?? this.intent,
    bankAccounts: bankAccounts ?? this.bankAccounts,
    selectedBankAccount: selectedBankAccount ?? this.selectedBankAccount,
    withdrawal: withdrawal ?? this.withdrawal,
    error: clearError ? null : error ?? this.error,
    pollAttempt: pollAttempt ?? this.pollAttempt,
  );
}

class WithdrawalNotifier extends StateNotifier<WithdrawalFlowState> {
  WithdrawalNotifier(
    this._gateway,
    this._recoveryStore, {
    List<Duration>? backoff,
  }) : _backoff =
           backoff ??
           const [
             Duration(seconds: 1),
             Duration(seconds: 2),
             Duration(seconds: 4),
             Duration(seconds: 8),
             Duration(seconds: 16),
           ],
       super(const WithdrawalFlowState());

  final WithdrawalGateway _gateway;
  final WithdrawalRecoveryStore _recoveryStore;
  final List<Duration> _backoff;
  Timer? _pollTimer;
  bool _disposed = false;

  /// Runs the contract §4 eligibility gate for the requested amount. The
  /// contract has no withdrawal quote, so this read is the only
  /// server-authoritative answer to "can this player withdraw right now?".
  Future<WithdrawalFlowPhase> checkEligibility(int amountMinorUnits) async {
    if (state.phase == WithdrawalFlowPhase.checkingEligibility) {
      return state.phase;
    }
    state = const WithdrawalFlowState(
      phase: WithdrawalFlowPhase.checkingEligibility,
    );
    try {
      final report = await _gateway.fetchEligibility(amountMinorUnits);
      if (_disposed) return state.phase;
      if (report == null) {
        state = const WithdrawalFlowState(
          phase: WithdrawalFlowPhase.unavailable,
          error:
              'We could not check whether you can withdraw right now. '
              'Check your connection and try again.',
        );
        return state.phase;
      }
      if (!report.allowed) {
        final next = switch (report.outcome) {
          WithdrawalEligibility.verificationRequired =>
            WithdrawalFlowPhase.verificationRequired,
          WithdrawalEligibility.limitReached =>
            WithdrawalFlowPhase.limitReached,
          // Restrictions (self-exclusion, break, banned, country) are not a
          // verification problem and must not be dressed up as one. Surface the
          // server's own reason instead.
          WithdrawalEligibility.eligible => WithdrawalFlowPhase.unavailable,
        };
        state = WithdrawalFlowState(
          phase: next,
          error:
              report.message ??
              'A withdrawal is not available for this account right now.',
        );
        return next;
      }
      final intent = WithdrawalIntent(
        amountMinorUnits: amountMinorUnits,
        currency: 'NGN',
        idempotencyKey: ClientRequestId.create('withdrawal'),
      );
      state = WithdrawalFlowState(
        phase: WithdrawalFlowPhase.selectingBank,
        intent: intent,
      );
      return WithdrawalFlowPhase.selectingBank;
    } catch (_) {
      if (!_disposed) {
        state = const WithdrawalFlowState(
          phase: WithdrawalFlowPhase.unavailable,
          error: 'Withdrawal options are unavailable. Check your connection.',
        );
      }
      return state.phase;
    }
  }

  Future<bool> loadBankAccounts() async {
    if (state.phase == WithdrawalFlowPhase.loadingBanks) return false;
    state = state.copyWith(
      phase: WithdrawalFlowPhase.loadingBanks,
      clearError: true,
    );
    try {
      final accounts = await _gateway.fetchBankAccounts();
      if (_disposed) return false;
      if (accounts == null) {
        state = state.copyWith(
          phase: WithdrawalFlowPhase.unavailable,
          error: 'Saved bank accounts are unavailable.',
        );
        return false;
      }
      final defaultAccount = accounts
          .where((item) => item.isDefault)
          .firstOrNull;
      state = state.copyWith(
        phase: WithdrawalFlowPhase.selectingBank,
        bankAccounts: accounts,
        selectedBankAccount: state.selectedBankAccount ?? defaultAccount,
        clearError: true,
      );
      return true;
    } catch (_) {
      if (!_disposed) {
        state = state.copyWith(
          phase: WithdrawalFlowPhase.unavailable,
          error: 'Bank accounts could not be loaded. Check your connection.',
        );
      }
      return false;
    }
  }

  void selectBankAccount(WithdrawalBankAccount account) {
    if (!state.bankAccounts.any((item) => item.id == account.id)) return;
    state = state.copyWith(
      selectedBankAccount: account,
      phase: WithdrawalFlowPhase.reviewing,
      clearError: true,
    );
  }

  Future<bool> verifyBankAccount({
    required String bankCode,
    required String accountNumber,
  }) async {
    if (state.phase == WithdrawalFlowPhase.verifyingBank) return false;
    state = state.copyWith(
      phase: WithdrawalFlowPhase.verifyingBank,
      clearError: true,
    );
    try {
      final account = await _gateway.verifyBankAccount(
        bankCode: bankCode,
        accountNumber: accountNumber,
      );
      if (_disposed) return false;
      if (account == null) {
        state = state.copyWith(
          phase: WithdrawalFlowPhase.bankVerificationFailed,
          error: 'We could not verify this bank account.',
        );
        return false;
      }
      final accounts = [
        ...state.bankAccounts.where((item) => item.id != account.id),
        account,
      ];
      state = state.copyWith(
        phase: WithdrawalFlowPhase.reviewing,
        bankAccounts: accounts,
        selectedBankAccount: account,
        clearError: true,
      );
      return true;
    } catch (_) {
      if (!_disposed) {
        state = state.copyWith(
          phase: WithdrawalFlowPhase.bankVerificationFailed,
          error: 'Bank verification is unavailable. No account was added.',
        );
      }
      return false;
    }
  }

  Future<bool> createWithdrawal() async {
    if (state.isCreating) return false;
    final intent = state.intent;
    final bank = state.selectedBankAccount;
    if (intent == null || bank == null) return false;
    // The idempotency key must be a real unique key. A previous fallback
    // synthesised 'withdrawal-null' when the id was absent, which would make
    // every withdrawal replay the first one.
    final idempotencyKey =
        intent.idempotencyKey ?? ClientRequestId.create('withdrawal');
    state = state.copyWith(
      phase: WithdrawalFlowPhase.creating,
      clearError: true,
    );
    try {
      final withdrawal = await _gateway.createWithdrawal(
        intent: intent,
        bankAccount: bank,
        idempotencyKey: idempotencyKey,
      );
      if (_disposed) return false;
      if (withdrawal == null) {
        state = state.copyWith(
          phase: WithdrawalFlowPhase.unavailable,
          error:
              'The withdrawal response could not be verified. Do not submit again.',
        );
        return false;
      }
      await _recoveryStore.saveWithdrawalId(withdrawal.id);
      if (_disposed) return false;
      _applyWithdrawal(withdrawal);
      if (!withdrawal.isTerminal) _schedulePoll(withdrawal.id);
      return true;
    } catch (_) {
      if (!_disposed) {
        state = state.copyWith(
          phase: WithdrawalFlowPhase.unavailable,
          error:
              'Withdrawal confirmation is unavailable. Do not submit another request.',
        );
      }
      return false;
    }
  }

  Future<bool> recover() async {
    final withdrawalId = await _recoveryStore.readWithdrawalId();
    if (_disposed || withdrawalId == null || withdrawalId.trim().isEmpty) {
      return false;
    }
    state = state.copyWith(
      phase: WithdrawalFlowPhase.pendingReview,
      clearError: true,
    );
    return _readStatus(withdrawalId, scheduleNext: true);
  }

  Future<bool> refreshStatus() async {
    final withdrawalId =
        state.withdrawal?.id ?? await _recoveryStore.readWithdrawalId();
    if (withdrawalId == null || withdrawalId.trim().isEmpty) return false;
    // Never cancel the confirmation chain here: the status screen refreshes on
    // mount, and cancelling it left every withdrawal stuck on its first poll.
    state = state.copyWith(pollAttempt: 0);
    return _readStatus(withdrawalId, scheduleNext: true);
  }

  Future<bool> _readStatus(
    String withdrawalId, {
    required bool scheduleNext,
  }) async {
    if (_disposed) return false;
    try {
      final withdrawal = await _gateway.fetchStatus(
        withdrawalId,
        previous: state.withdrawal,
      );
      if (_disposed) return false;
      if (withdrawal == null) {
        _setPending('We could not read this withdrawal status yet.');
        if (scheduleNext) _schedulePoll(withdrawalId);
        return false;
      }
      _applyWithdrawal(withdrawal);
      if (withdrawal.isTerminal) {
        _pollTimer?.cancel();
        await _recoveryStore.clearWithdrawalId();
      } else if (scheduleNext) {
        _schedulePoll(withdrawalId);
      }
      return true;
    } catch (_) {
      if (_disposed) return false;
      _setPending(
        'We could not refresh this withdrawal. It is still active — do not '
        'submit another request.',
      );
      if (scheduleNext) _schedulePoll(withdrawalId);
      return false;
    }
  }

  void _applyWithdrawal(WithdrawalData withdrawal) {
    final phase = switch (withdrawal.status) {
      WithdrawalStatus.pendingReview => WithdrawalFlowPhase.pendingReview,
      WithdrawalStatus.processing => WithdrawalFlowPhase.processing,
      // Not terminal: the provider refused the payout but the funds stay
      // reserved until an admin retries or releases them.
      WithdrawalStatus.payoutFailed => WithdrawalFlowPhase.payoutFailed,
      WithdrawalStatus.successful => WithdrawalFlowPhase.successful,
      WithdrawalStatus.reversed => WithdrawalFlowPhase.reversed,
    };
    state = state.copyWith(
      phase: phase,
      withdrawal: withdrawal,
      clearError: true,
    );
  }

  void _setPending(String message) {
    state = state.copyWith(
      phase: WithdrawalFlowPhase.pendingReview,
      error: message,
    );
  }

  void _schedulePoll(String withdrawalId) {
    _pollTimer?.cancel();
    final attempt = state.pollAttempt;
    if (_disposed ||
        attempt >= _backoff.length ||
        state.withdrawal?.isTerminal == true) {
      return;
    }
    state = state.copyWith(pollAttempt: attempt + 1);
    _pollTimer = Timer(_backoff[attempt], () {
      _readStatus(withdrawalId, scheduleNext: true);
    });
  }

  @override
  void dispose() {
    _disposed = true;
    _pollTimer?.cancel();
    super.dispose();
  }
}

final withdrawalProvider =
    StateNotifierProvider<WithdrawalNotifier, WithdrawalFlowState>((ref) {
      return WithdrawalNotifier(
        ref.watch(withdrawalGatewayProvider),
        ref.watch(withdrawalRecoveryStoreProvider),
      );
    });
