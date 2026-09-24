import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/deposit_flow.dart';
import '../services/deposit_gateway.dart';
import '../services/deposit_recovery_store.dart';

enum DepositFlowPhase {
  initial,
  loadingQuote,
  selectingMethod,
  creatingIntent,
  checkoutReady,
  processing,
  pending,
  successful,
  failed,
  unavailable,
}

class DepositFlowState {
  const DepositFlowState({
    this.phase = DepositFlowPhase.initial,
    this.quote,
    this.selectedMethod,
    this.intent,
    this.error,
    this.pollAttempt = 0,
  });

  final DepositFlowPhase phase;
  final DepositQuote? quote;
  final DepositPaymentMethod? selectedMethod;
  final DepositIntentData? intent;
  final String? error;
  final int pollAttempt;

  bool get isCreating => phase == DepositFlowPhase.creatingIntent;
  bool get canPoll => intent != null && !(intent?.isTerminal ?? true);

  DepositFlowState copyWith({
    DepositFlowPhase? phase,
    DepositQuote? quote,
    DepositPaymentMethod? selectedMethod,
    DepositIntentData? intent,
    String? error,
    bool clearError = false,
    int? pollAttempt,
  }) => DepositFlowState(
    phase: phase ?? this.phase,
    quote: quote ?? this.quote,
    selectedMethod: selectedMethod ?? this.selectedMethod,
    intent: intent ?? this.intent,
    error: clearError ? null : error ?? this.error,
    pollAttempt: pollAttempt ?? this.pollAttempt,
  );
}

class DepositNotifier extends StateNotifier<DepositFlowState> {
  DepositNotifier(this._gateway, this._recoveryStore, {List<Duration>? backoff})
    : _backoff =
          backoff ??
          const [
            Duration(seconds: 1),
            Duration(seconds: 2),
            Duration(seconds: 4),
            Duration(seconds: 8),
            Duration(seconds: 16),
          ],
      super(const DepositFlowState());

  final DepositGateway _gateway;
  final DepositRecoveryStore _recoveryStore;
  final List<Duration> _backoff;
  Timer? _pollTimer;
  bool _disposed = false;

  Future<bool> requestQuote(int amountMinorUnits) async {
    if (state.phase == DepositFlowPhase.loadingQuote) return false;
    state = const DepositFlowState(phase: DepositFlowPhase.loadingQuote);
    try {
      final quote = await _gateway.createQuote(amountMinorUnits);
      if (_disposed) return false;
      if (quote == null) {
        state = const DepositFlowState(
          phase: DepositFlowPhase.unavailable,
          error: 'Deposit details could not be verified.',
        );
        return false;
      }
      state = DepositFlowState(
        phase: DepositFlowPhase.selectingMethod,
        quote: quote,
      );
      return true;
    } catch (_) {
      if (!_disposed) {
        state = const DepositFlowState(
          phase: DepositFlowPhase.unavailable,
          error: 'Deposit options are unavailable. Check your connection.',
        );
      }
      return false;
    }
  }

  void selectMethod(DepositPaymentMethod method) {
    final quote = state.quote;
    if (quote == null ||
        !quote.paymentMethods.any((item) => item.id == method.id)) {
      return;
    }
    state = state.copyWith(selectedMethod: method, clearError: true);
  }

  Future<bool> createIntent() async {
    if (state.isCreating) return false;
    final quote = state.quote;
    final method = state.selectedMethod;
    if (quote == null || method == null) return false;
    state = state.copyWith(
      phase: DepositFlowPhase.creatingIntent,
      clearError: true,
    );
    try {
      final intent = await _gateway.createIntent(quote: quote, method: method);
      if (_disposed) return false;
      if (intent == null || intent.authorizationUrl == null) {
        state = state.copyWith(
          phase: DepositFlowPhase.unavailable,
          error: 'Secure checkout is not available for this deposit.',
        );
        return false;
      }
      await _recoveryStore.saveReference(intent.reference);
      if (_disposed) return false;
      state = state.copyWith(
        phase: DepositFlowPhase.checkoutReady,
        intent: intent,
        pollAttempt: 0,
      );
      return true;
    } catch (_) {
      if (!_disposed) {
        state = state.copyWith(
          phase: DepositFlowPhase.unavailable,
          error: 'Secure checkout could not be created. Try again.',
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
      phase: DepositFlowPhase.processing,
      clearError: true,
    );
    return _readStatus(reference, scheduleNext: true);
  }

  Future<void> handleProviderReturn() async {
    final intent = state.intent;
    if (intent == null) return;
    state = state.copyWith(
      phase: DepositFlowPhase.processing,
      intent: intent.copyWith(status: DepositStatus.processing),
      pollAttempt: 0,
      clearError: true,
    );
    await _readStatus(intent.reference, scheduleNext: true);
  }

  Future<bool> refreshStatus() async {
    _pollTimer?.cancel();
    final intent = state.intent;
    final reference = intent?.reference ?? await _recoveryStore.readReference();
    if (reference == null || reference.isEmpty) return false;
    return _readStatus(reference, scheduleNext: false);
  }

  Future<bool> _readStatus(
    String reference, {
    required bool scheduleNext,
  }) async {
    if (_disposed) return false;
    try {
      final updated = await _gateway.fetchStatus(
        reference,
        previous: state.intent,
      );
      if (_disposed) return false;
      if (updated == null) {
        _setPending('Deposit confirmation is not available yet.');
        if (scheduleNext) _schedulePoll(reference);
        return false;
      }
      final phase = switch (updated.status) {
        DepositStatus.processing => DepositFlowPhase.processing,
        DepositStatus.pending => DepositFlowPhase.pending,
        DepositStatus.successful => DepositFlowPhase.successful,
        DepositStatus.failed => DepositFlowPhase.failed,
      };
      state = state.copyWith(phase: phase, intent: updated, clearError: true);
      if (updated.isTerminal) {
        _pollTimer?.cancel();
        await _recoveryStore.clearReference();
      } else if (scheduleNext) {
        _schedulePoll(reference);
      }
      return true;
    } catch (_) {
      if (_disposed) return false;
      _setPending(
        'We could not refresh this deposit. Your wallet is unchanged.',
      );
      if (scheduleNext) _schedulePoll(reference);
      return false;
    }
  }

  void _setPending(String error) {
    final intent = state.intent;
    state = state.copyWith(
      phase: DepositFlowPhase.pending,
      intent: intent?.copyWith(status: DepositStatus.pending),
      error: error,
    );
  }

  void _schedulePoll(String reference) {
    _pollTimer?.cancel();
    final attempt = state.pollAttempt;
    if (_disposed ||
        attempt >= _backoff.length ||
        state.intent?.isTerminal == true) {
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

final depositProvider =
    StateNotifierProvider<DepositNotifier, DepositFlowState>((ref) {
      return DepositNotifier(
        ref.watch(depositGatewayProvider),
        ref.watch(depositRecoveryStoreProvider),
      );
    });
