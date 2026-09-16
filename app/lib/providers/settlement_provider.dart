import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/match_flow.dart';
import '../services/api_client.dart';
import '../services/settlement_gateway.dart';

enum SettlementLoadPhase { initial, refreshing, ready, unavailable, error }

class SettlementUiState {
  const SettlementUiState({
    this.phase = SettlementLoadPhase.initial,
    this.result,
    this.receipt,
    this.message,
  });

  final SettlementLoadPhase phase;
  final MatchResultViewData? result;
  final MatchReceiptData? receipt;
  final String? message;

  SettlementUiState copyWith({
    SettlementLoadPhase? phase,
    MatchResultViewData? result,
    MatchReceiptData? receipt,
    String? message,
    bool clearMessage = false,
  }) {
    return SettlementUiState(
      phase: phase ?? this.phase,
      result: result ?? this.result,
      receipt: receipt ?? this.receipt,
      message: clearMessage ? null : message ?? this.message,
    );
  }
}

class SettlementNotifier extends StateNotifier<SettlementUiState> {
  SettlementNotifier(this._gateway, this.matchId)
    : super(const SettlementUiState());

  final SettlementGateway _gateway;
  final String matchId;

  bool get _busy => state.phase == SettlementLoadPhase.refreshing;

  Future<void> refreshStatus() async {
    if (_busy) return;
    state = state.copyWith(
      phase: SettlementLoadPhase.refreshing,
      clearMessage: true,
    );
    try {
      final result = await _gateway.fetchStatus(matchId);
      if (result == null || !result.serverVerified) {
        state = state.copyWith(
          phase: SettlementLoadPhase.unavailable,
          message: 'The server did not return a verified settlement status.',
        );
        return;
      }
      state = state.copyWith(
        phase: SettlementLoadPhase.ready,
        result: result,
        clearMessage: true,
      );
    } catch (_) {
      state = state.copyWith(
        phase: SettlementLoadPhase.error,
        message: 'Settlement status is temporarily unavailable.',
      );
    }
  }

  Future<void> loadReceipt() async {
    if (_busy) return;
    state = state.copyWith(
      phase: SettlementLoadPhase.refreshing,
      clearMessage: true,
    );
    try {
      final receipt = await _gateway.fetchReceipt(matchId);
      if (receipt == null) {
        state = state.copyWith(
          phase: SettlementLoadPhase.unavailable,
          message: 'A verified receipt is not available yet.',
        );
        return;
      }
      state = state.copyWith(
        phase: SettlementLoadPhase.ready,
        receipt: receipt,
        clearMessage: true,
      );
    } catch (_) {
      state = state.copyWith(
        phase: SettlementLoadPhase.error,
        message: 'The match receipt could not be loaded.',
      );
    }
  }
}

final settlementGatewayProvider = Provider<SettlementGateway>((ref) {
  return SettlementGateway(ref.watch(apiClientProvider));
});

final settlementProvider = StateNotifierProvider.autoDispose
    .family<SettlementNotifier, SettlementUiState, String>((ref, matchId) {
      return SettlementNotifier(ref.watch(settlementGatewayProvider), matchId);
    });
