import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../config/backend_contract.dart';
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
    this.searchId,
    this.lifecycle,
    this.message,
  });

  final LoadPhase arenaPhase;
  final List<OpenMatch> openMatches;
  final MatchActionPhase actionPhase;
  final SearchPhase searchPhase;
  final MatchFlowIntent? currentIntent;
  final String? currentMatchId;
  final String? searchId;
  final MatchLifecycleSnapshot? lifecycle;
  final String? message;

  MatchFlowState copyWith({
    LoadPhase? arenaPhase,
    List<OpenMatch>? openMatches,
    MatchActionPhase? actionPhase,
    SearchPhase? searchPhase,
    MatchFlowIntent? currentIntent,
    String? currentMatchId,
    String? searchId,
    MatchLifecycleSnapshot? lifecycle,
    String? message,
    bool clearCurrentMatchId = false,
    bool clearSearchId = false,
    bool clearMessage = false,
  }) {
    return MatchFlowState(
      arenaPhase: arenaPhase ?? this.arenaPhase,
      openMatches: openMatches ?? this.openMatches,
      actionPhase: actionPhase ?? this.actionPhase,
      searchPhase: searchPhase ?? this.searchPhase,
      currentIntent: currentIntent ?? this.currentIntent,
      currentMatchId: clearCurrentMatchId
          ? null
          : currentMatchId ?? this.currentMatchId,
      searchId: clearSearchId ? null : searchId ?? this.searchId,
      lifecycle: lifecycle ?? this.lifecycle,
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
      searchPhase: SearchPhase.idle,
      clearCurrentMatchId: true,
      clearSearchId: true,
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
        final createdId = await _gateway.createOpenMatch(intent.terms);
        // V2 creates the authoritative match directly. The active legacy
        // backend creates only a callout and supplies the match later.
        if (_gateway.isV2) id = createdId;
      } else {
        await _gateway.joinQueue(intent.terms);
      }
      final waitsForMatch =
          intent.kind == MatchEntryKind.quick ||
          intent.kind == MatchEntryKind.created;
      state = state.copyWith(
        actionPhase: MatchActionPhase.succeeded,
        searchPhase: waitsForMatch ? SearchPhase.searching : SearchPhase.found,
        currentMatchId: id,
        searchId: _gateway.lastSearchId,
      );
      return id;
    } on DioException catch (error) {
      if (error.type == DioExceptionType.connectionTimeout ||
          error.type == DioExceptionType.receiveTimeout ||
          error.type == DioExceptionType.sendTimeout) {
        state = state.copyWith(
          actionPhase: MatchActionPhase.unknown,
          message:
              'The server outcome is unknown. Refresh authoritative match state before retrying.',
        );
        return null;
      }
      final message =
          apiErrorMessage(error.response?.data) ??
          'The reservation could not be confirmed. Try again.';
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

  void applyLifecycle(MatchLifecycleSnapshot snapshot) {
    state = state.copyWith(
      lifecycle: snapshot,
      currentMatchId: snapshot.matchId,
      clearMessage: true,
    );
  }

  Future<MatchLifecycleSnapshot?> refreshLifecycle() async {
    final matchId = state.currentMatchId;
    final terms = state.currentIntent?.terms;
    if (matchId == null || terms == null) return null;
    final snapshot = await _gateway.fetchMatch(matchId, terms);
    if (snapshot != null) applyLifecycle(snapshot);
    return snapshot;
  }

  Future<MatchLifecycleSnapshot?> markReady() async {
    final matchId = state.currentMatchId;
    final terms = state.currentIntent?.terms;
    if (matchId == null || terms == null) return null;
    final snapshot = await _gateway.markReady(matchId, terms);
    if (snapshot != null) applyLifecycle(snapshot);
    return snapshot;
  }

  Future<bool> cancelSearch() async {
    if (state.searchPhase == SearchPhase.cancelling) return false;
    final intent = state.currentIntent;
    if (intent == null) return false;
    state = state.copyWith(searchPhase: SearchPhase.cancelling);
    try {
      if (intent.kind == MatchEntryKind.quick) {
        await _gateway.leaveQueue(intent.terms, searchId: state.searchId);
      } else if (intent.kind == MatchEntryKind.created &&
          state.currentMatchId != null) {
        await _gateway.cancelMatch(state.currentMatchId!, intent.terms);
      }
      state = state.copyWith(
        searchPhase: SearchPhase.cancelled,
        clearSearchId: true,
      );
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
      clearCurrentMatchId: true,
      clearSearchId: true,
      clearMessage: true,
    );
  }
}

final matchFlowGatewayProvider = Provider<MatchFlowGateway>((ref) {
  return MatchFlowGateway(
    ref.watch(apiClientProvider),
    contract: ref.watch(backendContractProvider),
  );
});

final matchFlowProvider =
    StateNotifierProvider<MatchFlowNotifier, MatchFlowState>((ref) {
      return MatchFlowNotifier(ref.watch(matchFlowGatewayProvider));
    });
