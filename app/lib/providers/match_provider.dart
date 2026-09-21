import 'dart:async';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:dio/dio.dart';
import '../models/game_state.dart';
import '../models/game_protocol.dart';
import '../models/callout.dart';
import '../services/api_client.dart';
import '../services/socket_service.dart';
import '../services/secure_storage.dart';
import '../models/match_flow.dart';

enum MatchSyncState { synced, syncing, offline }

class MatchState {
  final GameState? gameState;
  final MatchSyncState syncState;
  final bool isFindingMatch;
  final String? currentMatchId;
  final List<Callout> openCallouts;
  final bool isMovePending;
  final String? rejectionReason;
  final MoveRejection? moveRejection;
  final String? pendingClientMoveId;
  final DrawOffer? incomingDrawOffer;
  final bool drawOfferPending;
  final bool drawOfferRejected;
  final bool resignPending;
  final bool promotionVisible;
  final List<int> lastCapturedSquares;
  final bool opponentConnected;
  final DateTime? opponentDisconnectedAt;
  final int? opponentGracePeriodMs;
  final SettlementPhase settlementPhase;
  final int? confirmedPayoutMinorUnits;
  final String? endReason;
  final MatchResultViewData? authoritativeResult;

  const MatchState({
    this.gameState,
    this.syncState = MatchSyncState.synced,
    this.isFindingMatch = false,
    this.currentMatchId,
    this.openCallouts = const [],
    this.isMovePending = false,
    this.rejectionReason,
    this.moveRejection,
    this.pendingClientMoveId,
    this.incomingDrawOffer,
    this.drawOfferPending = false,
    this.drawOfferRejected = false,
    this.resignPending = false,
    this.promotionVisible = false,
    this.lastCapturedSquares = const [],
    this.opponentConnected = true,
    this.opponentDisconnectedAt,
    this.opponentGracePeriodMs,
    this.settlementPhase = SettlementPhase.pending,
    this.confirmedPayoutMinorUnits,
    this.endReason,
    this.authoritativeResult,
  });

  MatchState copyWith({
    GameState? gameState,
    MatchSyncState? syncState,
    bool? isFindingMatch,
    String? currentMatchId,
    List<Callout>? openCallouts,
    bool? isMovePending,
    String? rejectionReason,
    MoveRejection? moveRejection,
    String? pendingClientMoveId,
    bool clearPendingMove = false,
    DrawOffer? incomingDrawOffer,
    bool clearDrawOffer = false,
    bool? drawOfferPending,
    bool? drawOfferRejected,
    bool? resignPending,
    bool clearRejection = false,
    bool? promotionVisible,
    List<int>? lastCapturedSquares,
    bool? opponentConnected,
    DateTime? opponentDisconnectedAt,
    bool clearOpponentDisconnect = false,
    int? opponentGracePeriodMs,
    SettlementPhase? settlementPhase,
    int? confirmedPayoutMinorUnits,
    String? endReason,
    MatchResultViewData? authoritativeResult,
    bool clearResult = false,
  }) {
    return MatchState(
      gameState: gameState ?? this.gameState,
      syncState: syncState ?? this.syncState,
      isFindingMatch: isFindingMatch ?? this.isFindingMatch,
      currentMatchId: currentMatchId ?? this.currentMatchId,
      openCallouts: openCallouts ?? this.openCallouts,
      isMovePending: isMovePending ?? this.isMovePending,
      rejectionReason: clearRejection
          ? null
          : rejectionReason ?? this.rejectionReason,
      moveRejection: clearRejection
          ? null
          : moveRejection ?? this.moveRejection,
      pendingClientMoveId: clearPendingMove
          ? null
          : pendingClientMoveId ?? this.pendingClientMoveId,
      incomingDrawOffer: clearDrawOffer
          ? null
          : incomingDrawOffer ?? this.incomingDrawOffer,
      drawOfferPending: drawOfferPending ?? this.drawOfferPending,
      drawOfferRejected: drawOfferRejected ?? this.drawOfferRejected,
      resignPending: resignPending ?? this.resignPending,
      promotionVisible: promotionVisible ?? this.promotionVisible,
      lastCapturedSquares: lastCapturedSquares ?? this.lastCapturedSquares,
      opponentConnected: opponentConnected ?? this.opponentConnected,
      opponentDisconnectedAt: clearOpponentDisconnect
          ? null
          : opponentDisconnectedAt ?? this.opponentDisconnectedAt,
      opponentGracePeriodMs: clearOpponentDisconnect
          ? null
          : opponentGracePeriodMs ?? this.opponentGracePeriodMs,
      settlementPhase: settlementPhase ?? this.settlementPhase,
      confirmedPayoutMinorUnits: clearResult
          ? null
          : confirmedPayoutMinorUnits ?? this.confirmedPayoutMinorUnits,
      endReason: clearResult ? null : endReason ?? this.endReason,
      authoritativeResult: clearResult
          ? null
          : authoritativeResult ?? this.authoritativeResult,
    );
  }
}

class MatchNotifier extends StateNotifier<MatchState> {
  final SocketService _socketService;
  final Dio _dio;
  final SecureStorageService _storage = SecureStorageService();

  bool _isReconnecting = false;
  int _actionSequence = 0;
  String? _currentUserId;
  final List<StreamSubscription<Map<String, dynamic>>> _subscriptions = [];
  StreamSubscription<List<ConnectivityResult>>? _connectivitySubscription;

  MatchNotifier(this._socketService, this._dio) : super(const MatchState()) {
    unawaited(_loadCurrentUserId());
    _initListeners();
  }

  Future<void> _loadCurrentUserId() async {
    _currentUserId = await _storage.userId;
  }

  void _initListeners() {
    _subscriptions.add(
      _socketService.onMatchFound.listen((data) {
        final matchId = data['id']?.toString();
        if (matchId == null || matchId.isEmpty) return;
        state = state.copyWith(
          isFindingMatch: false,
          currentMatchId: matchId,
          settlementPhase: SettlementPhase.pending,
          clearResult: true,
        );
        unawaited(_storage.setActiveMatchId(matchId));
        _socketService.joinMatch(matchId);
      }),
    );

    _subscriptions.add(
      _socketService.onCalloutCreated.listen((data) {
        final callout = Callout.fromJson(data);
        // We'll add it to the state; TierSelectScreen can filter by tier
        state = state.copyWith(openCallouts: [callout, ...state.openCallouts]);
      }),
    );

    _subscriptions.add(
      _socketService.onGameState.listen((data) {
        try {
          final gameState = GameState.fromJson(data);
          state = state.copyWith(
            gameState: gameState,
            syncState: MatchSyncState.synced,
            isMovePending: false,
            clearPendingMove: true,
            clearRejection: true,
          );
        } catch (_) {
          state = state.copyWith(syncState: MatchSyncState.syncing);
          final matchId = state.currentMatchId;
          if (matchId != null) unawaited(fetchGameState(matchId));
        }
      }),
    );

    _subscriptions.add(
      _socketService.onMoveApplied.listen((data) {
        MoveAppliedEvent event;
        try {
          event = MoveAppliedEvent.fromJson(data);
        } catch (_) {
          state = state.copyWith(
            isMovePending: false,
            clearPendingMove: true,
            syncState: MatchSyncState.syncing,
          );
          final matchId = state.currentMatchId;
          if (matchId != null) unawaited(fetchGameState(matchId));
          return;
        }
        if (state.gameState == null) return;

        final pendingId = state.pendingClientMoveId;
        if (event.clientMoveId != null &&
            pendingId != null &&
            event.clientMoveId != pendingId) {
          return;
        }

        // V2 acknowledgements may omit the board. Never calculate it locally;
        // request the canonical snapshot instead.
        if (event.board.isEmpty) {
          state = state.copyWith(
            isMovePending: false,
            clearPendingMove: true,
            syncState: MatchSyncState.syncing,
          );
          final matchId = state.currentMatchId;
          if (matchId != null) unawaited(fetchGameState(matchId));
          return;
        }

        final newState = state.gameState!.copyWith(
          board: event.board,
          currentTurn: event.nextTurn,
          // `move_applied` intentionally does not include winner/payout truth.
          // Keep the UI in a terminal-pending state until `match_ended` arrives.
          status: event.gameEnded ? 'settling' : 'in_progress',
          legalMoves: event.legalMoves,
        );

        state = state.copyWith(
          gameState: newState,
          syncState: MatchSyncState.synced,
          isMovePending: false,
          clearPendingMove: true,
          promotionVisible: event.promoted,
          lastCapturedSquares: event.captured,
          settlementPhase: event.gameEnded
              ? SettlementPhase.pending
              : state.settlementPhase,
          endReason: event.reason,
          clearRejection: true,
        );
      }),
    );

    _subscriptions.add(
      _socketService.onMoveRejected.listen((data) async {
        final rejection = MoveRejection.fromServer(data);
        state = state.copyWith(
          isMovePending: false,
          clearPendingMove: true,
          rejectionReason: rejection.rawCode,
          moveRejection: rejection,
          syncState: rejection.requiresResync
              ? MatchSyncState.syncing
              : MatchSyncState.synced,
        );
        if (rejection.requiresResync && state.currentMatchId != null) {
          await fetchGameState(state.currentMatchId!);
        }
      }),
    );

    _subscriptions.add(
      _socketService.onDrawOffer.listen((data) {
        final offer = DrawOffer.fromServer(data);
        if (offer.offerId.isEmpty) return;
        state = state.copyWith(incomingDrawOffer: offer);
      }),
    );
    _subscriptions.add(
      _socketService.onDrawResponse.listen((data) {
        final response = data['response']?.toString().toLowerCase();
        state = state.copyWith(
          drawOfferPending: false,
          drawOfferRejected: response == 'rejected' || response == 'declined',
        );
      }),
    );

    _subscriptions.add(
      _socketService.onOpponentDisconnected.listen((data) {
        state = state.copyWith(
          opponentConnected: false,
          opponentDisconnectedAt: DateTime.now(),
          opponentGracePeriodMs: int.tryParse(
            data['gracePeriodMs']?.toString() ?? '',
          ),
        );
      }),
    );
    _subscriptions.add(
      _socketService.onOpponentReconnected.listen((_) {
        state = state.copyWith(
          opponentConnected: true,
          clearOpponentDisconnect: true,
        );
      }),
    );
    _subscriptions.add(
      _socketService.onMatchEndedResign.listen((data) {
        final current = state.gameState;
        if (current == null) return;
        state = state.copyWith(
          gameState: current.copyWith(status: 'settling'),
          isMovePending: false,
          resignPending: false,
          settlementPhase: SettlementPhase.pending,
          endReason: 'resign',
        );
      }),
    );

    _subscriptions.add(
      _socketService.onMatchEnded.listen((data) {
        final current = state.gameState;
        if (current == null) return;
        final currentUserId = _currentUserId;
        final matchId = state.currentMatchId;
        final opponentId = currentUserId == current.player1
            ? current.player2
            : current.player1;
        final result =
            MatchResultViewData.tryFromServer(data) ??
            (currentUserId == null || matchId == null
                ? null
                : MatchResultViewData.tryFromActiveMatchEnded(
                    data,
                    matchId: matchId,
                    currentUserId: currentUserId,
                    opponentId: opponentId,
                  ));
        state = state.copyWith(
          gameState: current.copyWith(
            status: result == null ? 'settling' : 'completed',
          ),
          isMovePending: false,
          resignPending: false,
          settlementPhase: result?.settlement ?? SettlementPhase.pending,
          confirmedPayoutMinorUnits: result?.payoutMinorUnits,
          endReason: result?.reason,
          authoritativeResult: result,
        );
        if (result != null) unawaited(_storage.clearActiveMatchId());
      }),
    );

    _connectivitySubscription = Connectivity().onConnectivityChanged.listen((
      List<ConnectivityResult> result,
    ) {
      if (!result.contains(ConnectivityResult.none)) {
        if (!_isReconnecting && state.currentMatchId != null) {
          _isReconnecting = true;
          fetchGameState(state.currentMatchId!).then((_) {
            _isReconnecting = false;
          });
        }
      } else {
        state = state.copyWith(syncState: MatchSyncState.offline);
      }
    });
  }

  Future<void> fetchGameState(String matchId) async {
    try {
      state = state.copyWith(
        currentMatchId: matchId,
        syncState: MatchSyncState.syncing,
      );
      final response = await _dio.get('/matches/$matchId/state');

      if (response.statusCode == 200) {
        final gameState = GameState.fromJson(response.data);
        state = state.copyWith(
          gameState: gameState,
          syncState: MatchSyncState.synced,
        );
      }
    } catch (e) {
      state = state.copyWith(syncState: MatchSyncState.offline);
    }
  }

  Future<void> restoreActiveMatch() async {
    if (state.currentMatchId != null) return;
    final matchId = await _storage.activeMatchId;
    if (matchId == null || matchId.isEmpty) return;
    await fetchGameState(matchId);
  }

  Future<void> joinQueue(String tier, int stakeMinorUnits) async {
    state = state.copyWith(isFindingMatch: true);
    try {
      await _dio.post(
        '/matchmaking/join',
        data: {'stakeMinorUnits': stakeMinorUnits},
      );
    } catch (_) {
      state = state.copyWith(isFindingMatch: false);
    }
  }

  Future<void> leaveQueue(String tier, int stakeMinorUnits) async {
    try {
      await _dio.post(
        '/matchmaking/leave',
        data: {'stakeMinorUnits': stakeMinorUnits},
      );
      state = state.copyWith(isFindingMatch: false);
    } catch (_) {}
  }

  Future<void> fetchOpenCallouts() async {
    try {
      final response = await _dio.get('/callouts/open');

      if (response.statusCode == 200) {
        final List<dynamic> data = response.data['callouts'] ?? [];
        final callouts = data.map((json) => Callout.fromJson(json)).toList();
        state = state.copyWith(openCallouts: callouts);
      }
    } catch (_) {}
  }

  Future<void> createCallout(String tier, int stakeMinorUnits) async {
    try {
      await _dio.post('/callouts', data: {'stakeMinorUnits': stakeMinorUnits});
      // The socket event will trigger prepending to the list.
    } catch (_) {
      rethrow;
    }
  }

  Future<void> acceptCallout(String calloutId) async {
    try {
      await _dio.post('/callouts/$calloutId/accept');
      // The server will emit match_found socket event which joins the match.
    } catch (_) {
      rethrow;
    }
  }

  void attemptMove(int from, int to, {List<int>? path}) {
    if (state.currentMatchId == null ||
        state.gameState == null ||
        state.isMovePending ||
        state.syncState != MatchSyncState.synced) {
      return;
    }

    // Optimistic UI update could go here. For now, we trust the server.
    final game = state.gameState!;
    final clientMoveId = _newActionId('move');
    state = state.copyWith(
      isMovePending: true,
      pendingClientMoveId: clientMoveId,
      clearRejection: true,
    );
    if (game.protocolVersion >= 2) {
      _socketService.submitMoveV2(
        matchId: state.currentMatchId!,
        clientMoveId: clientMoveId,
        expectedStateVersion: game.stateVersion,
        from: from,
        path: path == null || path.isEmpty ? <int>[to] : path,
      );
    } else {
      _socketService.attemptMove(state.currentMatchId!, from, to);
    }
  }

  void joinMatch(String matchId) {
    state = state.copyWith(
      currentMatchId: matchId,
      settlementPhase: SettlementPhase.pending,
      clearResult: true,
    );
    unawaited(_storage.setActiveMatchId(matchId));
    _socketService.joinMatch(matchId);
  }

  void dismissPromotion() {
    state = state.copyWith(promotionVisible: false);
  }

  void clearRejection() {
    state = state.copyWith(clearRejection: true);
  }

  bool offerDraw() {
    final matchId = state.currentMatchId;
    final game = state.gameState;
    if (matchId == null ||
        game == null ||
        game.protocolVersion < 2 ||
        state.drawOfferPending) {
      return false;
    }
    state = state.copyWith(drawOfferPending: true, drawOfferRejected: false);
    _socketService.offerDraw(
      matchId: matchId,
      actionId: _newActionId('draw'),
      expectedStateVersion: game.stateVersion,
    );
    return true;
  }

  void respondToDraw(bool accept) {
    final matchId = state.currentMatchId;
    final offer = state.incomingDrawOffer;
    if (matchId == null || offer == null) return;
    state = state.copyWith(clearDrawOffer: true);
    _socketService.respondToDraw(
      matchId: matchId,
      actionId: _newActionId('draw-response'),
      offerId: offer.offerId,
      response: accept ? 'accepted' : 'rejected',
    );
  }

  void clearDrawRejected() {
    state = state.copyWith(drawOfferRejected: false);
  }

  void resign() {
    final matchId = state.currentMatchId;
    final game = state.gameState;
    if (matchId == null || game == null || state.resignPending) return;
    state = state.copyWith(resignPending: true);
    if (game.protocolVersion >= 2) {
      _socketService.resignV2(
        matchId: matchId,
        actionId: _newActionId('resign'),
        expectedStateVersion: game.stateVersion,
      );
    } else {
      _socketService.resign(matchId);
    }
  }

  String _newActionId(String prefix) {
    _actionSequence += 1;
    return '$prefix-${DateTime.now().microsecondsSinceEpoch}-$_actionSequence';
  }

  @override
  void dispose() {
    for (final subscription in _subscriptions) {
      subscription.cancel();
    }
    _connectivitySubscription?.cancel();
    super.dispose();
  }
}

final matchProvider = StateNotifierProvider<MatchNotifier, MatchState>((ref) {
  return MatchNotifier(socketService, ref.watch(apiClientProvider));
});
