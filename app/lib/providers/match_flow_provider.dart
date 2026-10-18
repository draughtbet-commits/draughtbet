import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../config/backend_contract.dart';
import '../models/match_flow.dart';
import '../models/eligibility.dart';
import '../services/api_client.dart';
import 'eligibility_provider.dart';
import '../services/match_flow_gateway.dart';

String _describeDioFailure(DioException error) {
  return switch (error.type) {
    DioExceptionType.connectionError =>
      'Cannot reach the server. Check your connection and try again.',
    DioExceptionType.badCertificate => 'The server certificate was rejected.',
    DioExceptionType.cancel => 'The request was cancelled.',
    DioExceptionType.badResponse =>
      'The server rejected the request (${error.response?.statusCode}).',
    _ => 'The reservation could not be confirmed. Try again.',
  };
}

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
    this.activeMatches = const [],
    this.eligibilityDecision,
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
  final List<MatchLifecycleSnapshot> activeMatches;
  final EligibilityDecision? eligibilityDecision;

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
    List<MatchLifecycleSnapshot>? activeMatches,
    bool clearCurrentMatchId = false,
    bool clearSearchId = false,
    bool clearMessage = false,
    bool clearLifecycle = false,
    EligibilityDecision? eligibilityDecision,
    bool clearEligibilityDecision = false,
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
      lifecycle: clearLifecycle ? null : lifecycle ?? this.lifecycle,
      message: clearMessage ? null : message ?? this.message,
      activeMatches: activeMatches ?? this.activeMatches,
      eligibilityDecision: clearEligibilityDecision
          ? null
          : eligibilityDecision ?? this.eligibilityDecision,
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

  /// Refresh the caller's pre-start matches (OPEN / FUNDED / READY) surfaced
  /// on Home so stranded, still-locked matches are never invisible.
  Future<void> loadActiveMatches() async {
    try {
      final matches = await _gateway.loadActiveMatches();
      state = state.copyWith(
        activeMatches: matches,
        actionPhase: MatchActionPhase.idle,
      );
    } catch (_) {
      state = state.copyWith(activeMatches: const []);
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
      clearLifecycle: true,
      clearEligibilityDecision: true,
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
      MatchLifecycleSnapshot? privateSnapshot;
      if (intent.kind == MatchEntryKind.openMatch &&
          intent.openMatchId != null) {
        id = await _gateway.acceptOpenMatch(intent.openMatchId!);
      } else if (intent.kind == MatchEntryKind.created) {
        final created = await _gateway.createOpenMatch(intent.terms);
        // V2 creates the authoritative match directly. The active legacy
        // backend creates only a callout and supplies the match later.
        if (_gateway.isV2) {
          id = created?.id;
          // A private listing has no matchmaking queue to wait in; it parks on
          // the share-code screen until its one opponent redeems the code.
          if (intent.terms.privateRoom && created != null) {
            privateSnapshot = MatchLifecycleSnapshot(
              phase: MatchLifecyclePhase.privateRoom,
              terms: intent.terms,
              matchId: created.id,
              roomCode: created.roomCode,
              expiresAt: created.expiresAt,
            );
          }
        }
      } else {
        await _gateway.joinQueue(intent.terms);
      }
      final waitsForMatch =
          intent.kind == MatchEntryKind.quick ||
          (intent.kind == MatchEntryKind.created && !intent.terms.privateRoom);
      state = state.copyWith(
        actionPhase: MatchActionPhase.succeeded,
        searchPhase: waitsForMatch ? SearchPhase.searching : SearchPhase.found,
        currentMatchId: id,
        lifecycle: privateSnapshot,
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
          apiErrorMessage(error.response?.data) ?? _describeDioFailure(error);
      debugPrint(
        'matchFlow: create reservation rejected '
        '(status=${error.response?.statusCode}, type=${error.type}): $message',
      );
      final decision = eligibilityDecisionFromDio(error);
      state = state.copyWith(
        actionPhase: MatchActionPhase.failed,
        message: message,
        eligibilityDecision: decision,
      );
      return null;
    } catch (error, stackTrace) {
      debugPrint(
        'matchFlow: match reservation failed before/around the request: '
        '$error\n$stackTrace',
      );
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
      clearEligibilityDecision: true,
    );
  }

  /// Re-seeds the in-memory match context from a snapshot the app already
  /// holds.
  ///
  /// `currentMatchId` and `currentIntent` only ever get set by a live flow, so
  /// after a cold start into a pre-play room both are null while the UI renders
  /// a perfectly good snapshot. Every pre-play action then bailed out on
  /// `terms == null` before issuing a request, leaving a button that looked live
  /// but did nothing. The snapshot is server-derived, so it is a safe source for
  /// both the id and the terms.
  void adoptLifecycle(MatchLifecycleSnapshot snapshot) {
    final matchId = snapshot.matchId;
    if (matchId == null) return;
    state = state.copyWith(
      lifecycle: snapshot,
      currentMatchId: matchId,
      currentIntent:
          state.currentIntent ??
          MatchFlowIntent(kind: MatchEntryKind.quick, terms: snapshot.terms),
    );
  }

  Future<MatchLifecycleSnapshot?> refreshLifecycle() async {
    final matchId = state.currentMatchId;
    final terms = state.currentIntent?.terms ?? state.lifecycle?.terms;
    if (matchId == null || terms == null) return null;
    final snapshot = await _gateway.fetchMatch(matchId, terms);
    if (snapshot != null) applyLifecycle(snapshot);
    return snapshot;
  }

  /// Lifecycle snapshot for a specific match, without requiring an adopted
  /// lifecycle or a known current match id. The room screen resolves a match
  /// the player is not yet seated in.
  Future<MatchLifecycleSnapshot?> fetchLifecycleFor(
    String matchId, {
    MatchTerms? fallbackTerms,
  }) async {
    final terms =
        fallbackTerms ??
        state.currentIntent?.terms ??
        state.lifecycle?.terms ??
        const MatchTerms(stakeMinorUnits: 0);
    return _gateway.fetchMatch(matchId, terms);
  }

  Future<MatchLifecycleSnapshot?> markReady() async {
    final matchId = state.currentMatchId;
    final terms = state.currentIntent?.terms ?? state.lifecycle?.terms;
    if (matchId == null || terms == null) {
      // Never leave a live-looking button silently inert: without a match
      // context there is nothing to confirm, and the player must be told.
      state = state.copyWith(
        actionPhase: MatchActionPhase.failed,
        message:
            'This match is no longer ready to start. Return to the room list.',
      );
      return null;
    }
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

  /// Sends a directed challenge and lands in the sent state.
  Future<MatchLifecycleSnapshot?> createChallenge(
    MatchPlayer target,
    MatchTerms terms,
  ) async {
    if (state.actionPhase == MatchActionPhase.submitting) return null;
    state = state.copyWith(
      currentIntent: MatchFlowIntent(
        kind: MatchEntryKind.challenge,
        terms: terms,
        opponent: target,
      ),
      actionPhase: MatchActionPhase.submitting,
      currentMatchId: null,
      lifecycle: null,
      clearMessage: true,
    );
    try {
      final matchId = await _gateway.createChallenge(target.id, terms);
      if (matchId == null || matchId.isEmpty) {
        throw StateError('No match id returned by the challenge endpoint');
      }
      final snapshot = MatchLifecycleSnapshot(
        phase: MatchLifecyclePhase.challengeSent,
        terms: terms,
        matchId: matchId,
        opponent: target,
      );
      state = state.copyWith(
        actionPhase: MatchActionPhase.succeeded,
        currentMatchId: matchId,
        lifecycle: snapshot,
      );
      return snapshot;
    } on DioException catch (e) {
      if (e.type == DioExceptionType.connectionTimeout ||
          e.type == DioExceptionType.receiveTimeout ||
          e.type == DioExceptionType.sendTimeout) {
        state = state.copyWith(
          actionPhase: MatchActionPhase.unknown,
          message:
              'The server outcome is unknown. Check your challenges before retrying.',
        );
        return null;
      }
      state = state.copyWith(
        actionPhase: MatchActionPhase.failed,
        message:
            apiErrorMessage(e.response?.data) ??
            'The challenge could not be sent. Try again.',
      );
      return null;
    } catch (_) {
      state = state.copyWith(
        actionPhase: MatchActionPhase.failed,
        message: 'The challenge could not be sent. Try again.',
      );
      return null;
    }
  }

  /// Redeems a private room code from the lobby, seats the caller against the
  /// listing, and surfaces the resulting snapshot so it can be routed like any
  /// other funded match.
  Future<MatchLifecycleSnapshot?> joinPrivateRoom(
    String code, {
    MatchTerms terms = const MatchTerms(stakeMinorUnits: 0),
  }) async {
    try {
      final matchId = await _gateway.joinByCode(code);
      if (matchId == null) {
        state = state.copyWith(
          actionPhase: MatchActionPhase.failed,
          message: 'That room code could not be found.',
        );
        return null;
      }
      final snapshot = await _gateway.fetchMatch(matchId, terms);
      if (snapshot != null) applyLifecycle(snapshot);
      return snapshot;
    } on DioException catch (e) {
      state = state.copyWith(
        actionPhase: MatchActionPhase.failed,
        message:
            apiErrorMessage(e.response?.data) ??
            'That room code could not be found.',
      );
      return null;
    } catch (_) {
      state = state.copyWith(
        actionPhase: MatchActionPhase.failed,
        message: 'That room code could not be found.',
      );
      return null;
    }
  }

  /// Accepts an incoming challenge (join) and surfaces the funded snapshot.
  ///
  /// [matchId]/[terms] let a screen that was opened straight from a snapshot
  /// (home active-match card, notification) act without an adopted context.
  Future<MatchLifecycleSnapshot?> acceptChallenge({
    String? matchId,
    MatchTerms? terms,
  }) async {
    final resolvedMatchId = matchId ?? state.currentMatchId;
    final resolvedTerms = terms ?? state.currentIntent?.terms;
    if (resolvedMatchId == null || resolvedTerms == null) return null;
    try {
      await _gateway.acceptOpenMatch(resolvedMatchId);
      final snapshot = await _gateway.fetchMatch(resolvedMatchId, resolvedTerms);
      if (snapshot != null) applyLifecycle(snapshot);
      return snapshot;
    } on DioException catch (e) {
      state = state.copyWith(
        actionPhase: MatchActionPhase.failed,
        message:
            apiErrorMessage(e.response?.data) ??
            'The challenge could not be accepted. Try again.',
      );
      return null;
    } catch (_) {
      state = state.copyWith(
        actionPhase: MatchActionPhase.failed,
        message: 'The challenge could not be accepted. Try again.',
      );
      return null;
    }
  }

  /// Declines an incoming challenge; the match is cancelled server-side.
  Future<MatchLifecycleSnapshot?> declineChallenge({
    String? matchId,
    MatchTerms? terms,
  }) async {
    final resolvedMatchId = matchId ?? state.currentMatchId;
    final resolvedTerms = terms ?? state.currentIntent?.terms;
    if (resolvedMatchId == null || resolvedTerms == null) return null;
    try {
      final snapshot = await _gateway.declineChallenge(
        resolvedMatchId,
        resolvedTerms,
      );
      if (snapshot != null) applyLifecycle(snapshot);
      return snapshot;
    } on DioException catch (e) {
      state = state.copyWith(
        actionPhase: MatchActionPhase.failed,
        message:
            apiErrorMessage(e.response?.data) ??
            'The challenge could not be declined. Try again.',
      );
      return null;
    } catch (_) {
      state = state.copyWith(
        actionPhase: MatchActionPhase.failed,
        message: 'The challenge could not be declined. Try again.',
      );
      return null;
    }
  }

  /// Cancels a challenge the current user sent, while it is still pending.
  Future<MatchLifecycleSnapshot?> cancelSentChallenge({
    String? matchId,
    MatchTerms? terms,
  }) async {
    final resolvedMatchId = matchId ?? state.currentMatchId;
    final resolvedTerms = terms ?? state.currentIntent?.terms;
    if (resolvedMatchId == null || resolvedTerms == null) return null;
    try {
      final snapshot = await _gateway.cancelMatch(
        resolvedMatchId,
        resolvedTerms,
      );
      if (snapshot != null) applyLifecycle(snapshot);
      return snapshot;
    } catch (_) {
      state = state.copyWith(
        actionPhase: MatchActionPhase.failed,
        message: 'The challenge could not be cancelled. Try again.',
      );
      return null;
    }
  }

  /// Builds the incoming-challenge screen state from the players listing.
  Future<MatchLifecycleSnapshot?> handleIncomingChallenge(
    String matchId,
  ) async {
    try {
      final invite = await _gateway.fetchChallenge(matchId);
      if (invite == null) return null;
      state = state.copyWith(
        currentIntent: MatchFlowIntent(
          kind: MatchEntryKind.challenge,
          terms: invite.terms,
          opponent: invite.opponent,
        ),
        currentMatchId: matchId,
        lifecycle: MatchLifecycleSnapshot(
          phase: MatchLifecyclePhase.incomingChallenge,
          terms: invite.terms,
          matchId: matchId,
          opponent: invite.opponent,
        ),
        actionPhase: MatchActionPhase.idle,
        clearMessage: true,
      );
      return state.lifecycle;
    } catch (_) {
      return null;
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
