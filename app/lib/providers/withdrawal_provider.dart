import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/withdrawal_flow.dart';
import '../services/withdrawal_gateway.dart';
import '../services/withdrawal_recovery_store.dart';
import 'wallet_provider.dart';

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
  approved,
  processing,
  failed,
  reconciling,
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
    this.requestedAmountMinorUnits,
  });

  final WithdrawalFlowPhase phase;
  final WithdrawalQuote? quote;
  final List<WithdrawalBankAccount> bankAccounts;
  final WithdrawalBankAccount? selectedBankAccount;
  final WithdrawalData? withdrawal;
  final String? error;
  final int pollAttempt;
  final int? requestedAmountMinorUnits;

  bool get isCreating => phase == WithdrawalFlowPhase.creating;

  WithdrawalFlowState copyWith({
    WithdrawalFlowPhase? phase,
    WithdrawalQuote? quote,
    List<WithdrawalBankAccount>? bankAccounts,
    WithdrawalBankAccount? selectedBankAccount,
    bool clearSelectedBankAccount = false,
    WithdrawalData? withdrawal,
    String? error,
    bool clearError = false,
    int? pollAttempt,
    int? requestedAmountMinorUnits,
  }) => WithdrawalFlowState(
    phase: phase ?? this.phase,
    quote: quote ?? this.quote,
    bankAccounts: bankAccounts ?? this.bankAccounts,
    selectedBankAccount: clearSelectedBankAccount
        ? null
        : selectedBankAccount ?? this.selectedBankAccount,
    withdrawal: withdrawal ?? this.withdrawal,
    error: clearError ? null : error ?? this.error,
    pollAttempt: pollAttempt ?? this.pollAttempt,
    requestedAmountMinorUnits:
        requestedAmountMinorUnits ?? this.requestedAmountMinorUnits,
  );
}

class WithdrawalNotifier extends StateNotifier<WithdrawalFlowState> {
  WithdrawalNotifier(
    this._gateway,
    this._recoveryStore, {
    List<Duration>? backoff,
    Future<void> Function()? refreshWallet,
  }) : _backoff =
           backoff ??
           const [
             Duration(seconds: 1),
             Duration(seconds: 2),
             Duration(seconds: 4),
             Duration(seconds: 8),
             Duration(seconds: 16),
           ],
       _refreshWallet = refreshWallet,
       super(const WithdrawalFlowState());

  final WithdrawalGateway _gateway;
  final WithdrawalRecoveryStore _recoveryStore;
  final List<Duration> _backoff;
  final Future<void> Function()? _refreshWallet;
  Timer? _pollTimer;
  bool _disposed = false;

  Future<WithdrawalFlowPhase> requestQuote(int amountMinorUnits) async {
    if (state.phase == WithdrawalFlowPhase.loadingQuote) return state.phase;
    state = WithdrawalFlowState(
      phase: WithdrawalFlowPhase.loadingQuote,
      requestedAmountMinorUnits: amountMinorUnits,
    );
    try {
      final quote = await _gateway.createQuote(amountMinorUnits);
      if (_disposed) return state.phase;
      if (quote == null) {
        state = WithdrawalFlowState(
          phase: WithdrawalFlowPhase.unavailable,
          error:
              'Withdrawal details could not be confirmed by the server. No request was submitted.',
          requestedAmountMinorUnits: amountMinorUnits,
        );
        return state.phase;
      }
      final next = switch (quote.eligibility) {
        WithdrawalEligibility.eligible => WithdrawalFlowPhase.selectingBank,
        WithdrawalEligibility.verificationRequired =>
          WithdrawalFlowPhase.verificationRequired,
        WithdrawalEligibility.limitReached => WithdrawalFlowPhase.limitReached,
      };
      state = WithdrawalFlowState(
        phase: next,
        quote: quote,
        requestedAmountMinorUnits: amountMinorUnits,
      );
      return next;
    } catch (_) {
      if (!_disposed) {
        state = WithdrawalFlowState(
          phase: WithdrawalFlowPhase.unavailable,
          error: 'Withdrawal options are unavailable. Check your connection.',
          requestedAmountMinorUnits: amountMinorUnits,
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
      if (defaultAccount == null && accounts.isNotEmpty) {
        state = state.copyWith(
          phase: WithdrawalFlowPhase.unavailable,
          bankAccounts: accounts,
          clearSelectedBankAccount: true,
          error: 'No server-confirmed default payout destination is available.',
        );
      } else {
        state = state.copyWith(
          phase: WithdrawalFlowPhase.selectingBank,
          bankAccounts: accounts,
          selectedBankAccount: defaultAccount,
          clearSelectedBankAccount: defaultAccount == null,
          clearError: true,
        );
      }
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

  Future<bool> selectBankAccount(WithdrawalBankAccount account) async {
    if (!state.bankAccounts.any((item) => item.id == account.id)) return false;
    if (account.isDefault) {
      state = state.copyWith(
        selectedBankAccount: account,
        phase: WithdrawalFlowPhase.reviewing,
        clearError: true,
      );
      return true;
    }
    state = state.copyWith(
      phase: WithdrawalFlowPhase.loadingBanks,
      clearError: true,
    );
    try {
      final confirmed = await _gateway.setDefaultBankAccount(account);
      if (_disposed) return false;
      if (confirmed == null) {
        state = state.copyWith(
          phase: WithdrawalFlowPhase.selectingBank,
          error: 'The payout destination could not be confirmed.',
        );
        return false;
      }
      final accounts = state.bankAccounts
          .map(
            (item) => item.id == confirmed.id
                ? confirmed
                : item.copyWith(isDefault: false),
          )
          .toList(growable: false);
      state = state.copyWith(
        phase: WithdrawalFlowPhase.reviewing,
        bankAccounts: accounts,
        selectedBankAccount: confirmed,
        clearError: true,
      );
      return true;
    } catch (_) {
      if (!_disposed) {
        state = state.copyWith(
          phase: WithdrawalFlowPhase.selectingBank,
          error:
              'The server could not confirm this payout destination. Your previous default was kept.',
        );
      }
      return false;
    }
  }

  Future<bool> verifyBankAccount({
    required String gateway,
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
      final account = await _gateway.createBankAccount(
        gateway: gateway,
        bankCode: bankCode,
        bankName: bankName,
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
      final confirmed = await _gateway.setDefaultBankAccount(account);
      if (_disposed) return false;
      if (confirmed == null) {
        state = state.copyWith(
          phase: WithdrawalFlowPhase.bankVerificationFailed,
          error:
              'The account was verified, but the payout destination was not confirmed.',
        );
        return false;
      }
      final accounts =
          [
                ...state.bankAccounts.where((item) => item.id != account.id),
                confirmed,
              ]
              .map((item) => item.copyWith(isDefault: item.id == confirmed.id))
              .toList();
      state = state.copyWith(
        phase: WithdrawalFlowPhase.reviewing,
        bankAccounts: accounts,
        selectedBankAccount: confirmed,
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
    if (quote == null ||
        !quote.isCompleteForSubmission ||
        bank == null ||
        !bank.isDefault) {
      state = state.copyWith(
        phase: WithdrawalFlowPhase.unavailable,
        error:
            'Authoritative withdrawal terms and a confirmed payout destination are required.',
      );
      return false;
    }
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
      if (withdrawal.isTerminal) {
        await _completeTerminal(withdrawal);
      } else {
        _schedulePoll(withdrawal.reference);
      }
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
      phase: WithdrawalFlowPhase.reconciling,
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
        _setRefreshError('Withdrawal status is not available yet.');
        if (scheduleNext) _schedulePoll(reference);
        return false;
      }
      if (_isStale(withdrawal)) {
        if (scheduleNext) _schedulePoll(reference);
        return true;
      }
      _applyWithdrawal(withdrawal);
      if (withdrawal.isTerminal) {
        _pollTimer?.cancel();
        await _completeTerminal(withdrawal);
      } else if (scheduleNext) {
        _schedulePoll(reference);
      }
      return true;
    } catch (_) {
      if (_disposed) return false;
      _setRefreshError(
        'We could not refresh this withdrawal. Its existing reference is still active.',
      );
      if (scheduleNext) _schedulePoll(reference);
      return false;
    }
  }

  void _applyWithdrawal(WithdrawalData withdrawal) {
    final phase = switch (withdrawal.status) {
      WithdrawalStatus.pendingReview => WithdrawalFlowPhase.pendingReview,
      WithdrawalStatus.approved => WithdrawalFlowPhase.approved,
      WithdrawalStatus.processing => WithdrawalFlowPhase.processing,
      WithdrawalStatus.failed => WithdrawalFlowPhase.failed,
      WithdrawalStatus.unknown => WithdrawalFlowPhase.reconciling,
      WithdrawalStatus.successful => WithdrawalFlowPhase.successful,
      WithdrawalStatus.reversed => WithdrawalFlowPhase.reversed,
    };
    state = state.copyWith(
      phase: phase,
      withdrawal: withdrawal,
      clearError: true,
    );
  }

  void _setRefreshError(String message) {
    state = state.copyWith(
      phase: state.withdrawal == null
          ? WithdrawalFlowPhase.reconciling
          : state.phase,
      error: message,
    );
  }

  bool _isStale(WithdrawalData incoming) {
    final current = state.withdrawal;
    if (current == null || current.reference != incoming.reference) {
      return false;
    }
    if (current.isTerminal && !incoming.isTerminal) return true;
    final currentTime = current.updatedAt;
    final incomingTime = incoming.updatedAt;
    return currentTime != null &&
        incomingTime != null &&
        incomingTime.isBefore(currentTime);
  }

  Future<void> _completeTerminal(WithdrawalData withdrawal) async {
    try {
      await _recoveryStore.clearReference();
    } catch (_) {
      // Retaining a terminal reference is safe: the next recovery read will
      // observe the same authoritative terminal response and retry clearing.
    }
    if (withdrawal.status == WithdrawalStatus.reversed) {
      try {
        await _refreshWallet?.call();
      } catch (_) {
        // The withdrawal remains authoritatively released. Wallet UI already
        // has its own retry path if this read refresh is temporarily offline.
      }
    }
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
        refreshWallet: () async {
          final wallet = ref.read(walletProvider.notifier);
          await Future.wait([
            wallet.fetchBalance(silent: true),
            wallet.fetchTransactions(silent: true),
          ]);
        },
      );
    });
