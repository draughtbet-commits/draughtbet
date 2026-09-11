import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models/match_flow.dart';
import '../services/api_client.dart';
import '../services/match_flow_gateway.dart';

class MatchFlowState {
  const MatchFlowState({
    this.arenaPhase = LoadPhase.initial,
    this.openMatches = const [],
    this.actionPhase = MatchActionPhase.idle,
    this.searchPhase = SearchPhase.idle,
    this.currentIntent,
    this.currentMatchId,
    this.message,
  });

  final LoadPhase arenaPhase;
  final List<OpenMatch> openMatches;
  final MatchActionPhase actionPhase;
  final SearchPhase searchPhase;
  final MatchFlowIntent? currentIntent;
  final String? currentMatchId;
  final String? message;

  MatchFlowState copyWith({
    LoadPhase? arenaPhase,
    List<OpenMatch>? openMatches,
    MatchActionPhase? actionPhase,
    SearchPhase? searchPhase,
    MatchFlowIntent? currentIntent,
    String? currentMatchId,
    String? message,
    bool clearMessage = false,
  }) {
    return MatchFlowState(
      arenaPhase: arenaPhase ?? this.arenaPhase,
      openMatches: openMatches ?? this.openMatches,
      actionPhase: actionPhase ?? this.actionPhase,
      searchPhase: searchPhase ?? this.searchPhase,
      currentIntent: currentIntent ?? this.currentIntent,
      currentMatchId: currentMatchId ?? this.currentMatchId,
      message: clearMessage ? null : message ?? this.message,
    );
  }
}

class MatchFlowNotifier extends StateNotifier<MatchFlowState> {
  MatchFlowNotifier(this._gateway) : super(const MatchFlowState());

  final MatchFlowGateway _gateway;

  Future<void> loadArena() async {
    if (state.arenaPhase == LoadPhase.loading) return;
    state = state.copyWith(arenaPhase: LoadPhase.loading, clearMessage: true);
    try {
      final matches = await _gateway.loadOpenMatches();
      state = state.copyWith(
        arenaPhase: matches.isEmpty ? LoadPhase.empty : LoadPhase.ready,
        openMatches: matches,
      );
    } on DioException catch (error) {
      state = state.copyWith(
        arenaPhase: error.type == DioExceptionType.connectionError
            ? LoadPhase.offline
            : LoadPhase.error,
        message: 'We could not refresh the Arena. Try again.',
      );
    } catch (_) {
      state = state.copyWith(
        arenaPhase: LoadPhase.error,
        message: 'We could not refresh the Arena. Try again.',
      );
    }
  }

  void review(MatchFlowIntent intent) {
    state = state.copyWith(
      currentIntent: intent,
      actionPhase: MatchActionPhase.idle,
      clearMessage: true,
    );
  }

  Future<String?> confirm() async {
    if (state.actionPhase == MatchActionPhase.submitting) return null;
    final intent = state.currentIntent;
    if (intent == null) return null;
    state = state.copyWith(
      actionPhase: MatchActionPhase.submitting,
      clearMessage: true,
    );
    try {
      String? id;
      if (intent.kind == MatchEntryKind.openMatch &&
          intent.openMatchId != null) {
        id = await _gateway.acceptOpenMatch(intent.openMatchId!);
      } else if (intent.kind == MatchEntryKind.created) {
        id = await _gateway.createOpenMatch(intent.terms);
      } else {
        await _gateway.joinQueue(intent.terms);
      }
      state = state.copyWith(
        actionPhase: MatchActionPhase.succeeded,
        searchPhase:
            intent.kind == MatchEntryKind.quick ||
                intent.kind == MatchEntryKind.created
            ? SearchPhase.searching
            : SearchPhase.found,
        currentMatchId: id,
      );
      return id;
    } on DioException catch (error) {
      final body = error.response?.data;
      final message = body is Map && body['error'] is String
          ? body['error'] as String
          : 'The reservation could not be confirmed. Try again.';
      state = state.copyWith(
        actionPhase: MatchActionPhase.failed,
        message: message,
      );
      return null;
    } catch (_) {
      state = state.copyWith(
        actionPhase: MatchActionPhase.failed,
        message: 'The reservation could not be confirmed. Try again.',
      );
      return null;
    }
  }

  void matchFound(String id) {
    state = state.copyWith(searchPhase: SearchPhase.found, currentMatchId: id);
  }

  Future<bool> cancelSearch() async {
    if (state.searchPhase == SearchPhase.cancelling) return false;
    final intent = state.currentIntent;
    if (intent == null) return false;
    state = state.copyWith(searchPhase: SearchPhase.cancelling);
    try {
      if (intent.kind == MatchEntryKind.quick) {
        await _gateway.leaveQueue(intent.terms);
      }
      state = state.copyWith(searchPhase: SearchPhase.cancelled);
      return true;
    } catch (_) {
      state = state.copyWith(
        searchPhase: SearchPhase.degraded,
        message: 'Cancellation is not confirmed yet. Check your connection.',
      );
      return false;
    }
  }

  void resetAction() {
    state = state.copyWith(
      actionPhase: MatchActionPhase.idle,
      searchPhase: SearchPhase.idle,
      clearMessage: true,
    );
  }
}

final matchFlowGatewayProvider = Provider<MatchFlowGateway>((ref) {
  return MatchFlowGateway(ref.watch(apiClientProvider));
});

final matchFlowProvider =
    StateNotifierProvider<MatchFlowNotifier, MatchFlowState>((ref) {
      return MatchFlowNotifier(ref.watch(matchFlowGatewayProvider));
    });
