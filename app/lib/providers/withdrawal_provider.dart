import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/withdrawal_flow.dart';
import '../services/withdrawal_gateway.dart';
import '../services/withdrawal_recovery_store.dart';

enum WithdrawalFlowPhase {
  initial,
  loadingQuote,
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
  successful,
  reversed,
  unavailable,
}

class WithdrawalFlowState {
  const WithdrawalFlowState({
    this.phase = WithdrawalFlowPhase.initial,
    this.quote,
    this.bankAccounts = const [],
    this.selectedBankAccount,
    this.withdrawal,
    this.error,
    this.pollAttempt = 0,
  });

  final WithdrawalFlowPhase phase;
  final WithdrawalQuote? quote;
  final List<WithdrawalBankAccount> bankAccounts;
  final WithdrawalBankAccount? selectedBankAccount;
  final WithdrawalData? withdrawal;
  final String? error;
  final int pollAttempt;

  bool get isCreating => phase == WithdrawalFlowPhase.creating;

  WithdrawalFlowState copyWith({
    WithdrawalFlowPhase? phase,
    WithdrawalQuote? quote,
    List<WithdrawalBankAccount>? bankAccounts,
    WithdrawalBankAccount? selectedBankAccount,
    WithdrawalData? withdrawal,
    String? error,
    bool clearError = false,
    int? pollAttempt,
  }) => WithdrawalFlowState(
    phase: phase ?? this.phase,
    quote: quote ?? this.quote,
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

  Future<WithdrawalFlowPhase> requestQuote(int amountMinorUnits) async {
    if (state.phase == WithdrawalFlowPhase.loadingQuote) return state.phase;
    state = const WithdrawalFlowState(phase: WithdrawalFlowPhase.loadingQuote);
    try {
      final quote = await _gateway.createQuote(amountMinorUnits);
      if (_disposed) return state.phase;
      if (quote == null) {
        state = const WithdrawalFlowState(
          phase: WithdrawalFlowPhase.unavailable,
          error: 'Withdrawal details could not be verified.',
        );
        return state.phase;
      }
      final next = switch (quote.eligibility) {
        WithdrawalEligibility.eligible => WithdrawalFlowPhase.selectingBank,
        WithdrawalEligibility.verificationRequired =>
          WithdrawalFlowPhase.verificationRequired,
        WithdrawalEligibility.limitReached => WithdrawalFlowPhase.limitReached,
      };
      state = WithdrawalFlowState(phase: next, quote: quote);
      return next;
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
    required String bankName,
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
        bankName: bankName,
        accountNumber: accountNumber,
        idempotencyKey: state.quote?.idempotencyKey,
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
    final quote = state.quote;
    final bank = state.selectedBankAccount;
    if (quote == null || bank == null) return false;
    state = state.copyWith(
      phase: WithdrawalFlowPhase.creating,
      clearError: true,
    );
    try {
      final withdrawal = await _gateway.createWithdrawal(
        quote: quote,
        bankAccount: bank,
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
      await _recoveryStore.saveReference(withdrawal.reference);
      if (_disposed) return false;
      _applyWithdrawal(withdrawal);
      if (!withdrawal.isTerminal) _schedulePoll(withdrawal.reference);
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
    final reference = await _recoveryStore.readReference();
    if (_disposed || reference == null || reference.trim().isEmpty) {
      return false;
    }
    state = state.copyWith(
      phase: WithdrawalFlowPhase.pendingReview,
      clearError: true,
    );
    return _readStatus(reference, scheduleNext: true);
  }

  Future<bool> refreshStatus() async {
    _pollTimer?.cancel();
    final reference =
        state.withdrawal?.reference ?? await _recoveryStore.readReference();
    if (reference == null || reference.trim().isEmpty) return false;
    return _readStatus(reference, scheduleNext: false);
  }

  Future<bool> _readStatus(
    String reference, {
    required bool scheduleNext,
  }) async {
    if (_disposed) return false;
    try {
      final withdrawal = await _gateway.fetchStatus(
        reference,
        previous: state.withdrawal,
      );
      if (_disposed) return false;
      if (withdrawal == null) {
        _setPending('Withdrawal status is not available yet.');
        if (scheduleNext) _schedulePoll(reference);
        return false;
      }
      _applyWithdrawal(withdrawal);
      if (withdrawal.isTerminal) {
        _pollTimer?.cancel();
        await _recoveryStore.clearReference();
      } else if (scheduleNext) {
        _schedulePoll(reference);
      }
      return true;
    } catch (_) {
      if (_disposed) return false;
      _setPending(
        'We could not refresh this withdrawal. Its existing reference is still active.',
      );
      if (scheduleNext) _schedulePoll(reference);
      return false;
    }
  }

  void _applyWithdrawal(WithdrawalData withdrawal) {
    final phase = switch (withdrawal.status) {
      WithdrawalStatus.pendingReview => WithdrawalFlowPhase.pendingReview,
      WithdrawalStatus.processing => WithdrawalFlowPhase.processing,
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
      withdrawal: state.withdrawal?.copyWith(
        status: WithdrawalStatus.pendingReview,
      ),
      error: message,
    );
  }

  void _schedulePoll(String reference) {
    _pollTimer?.cancel();
    final attempt = state.pollAttempt;
    if (_disposed ||
        attempt >= _backoff.length ||
        state.withdrawal?.isTerminal == true) {
      return;
    }
    state = state.copyWith(pollAttempt: attempt + 1);
    _pollTimer = Timer(_backoff[attempt], () {
      _readStatus(reference, scheduleNext: true);
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
