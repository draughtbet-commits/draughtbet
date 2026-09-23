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

enum MatchRecoveryPhase {
  none,
  connectionLost,
  reconnecting,
  appResumed,
  resyncing,
}

class ServerClockSnapshot {
  const ServerClockSnapshot({
    required this.matchId,
    required this.serverNowMs,
    required this.remainingMs,
    this.deadlineAt,
    this.turnStartedAtServer,
    this.timeControlSeconds,
    this.currentTurn,
    this.currentTurnUserId,
    this.status,
    this.version,
  });

  final String matchId;
  final int serverNowMs;
  final int remainingMs;
  final int? deadlineAt;
  final int? turnStartedAtServer;
  final int? timeControlSeconds;
  final String? currentTurn;
  final String? currentTurnUserId;
  final String? status;
  final int? version;

  static ServerClockSnapshot? tryFromServer(Map<String, dynamic> data) {
    final matchId = data['matchId']?.toString().trim();
    final serverNowMs = int.tryParse(data['serverNowMs']?.toString() ?? '');
    final remainingMs = int.tryParse(data['remainingMs']?.toString() ?? '');
    if (matchId == null ||
        matchId.isEmpty ||
        serverNowMs == null ||
        remainingMs == null ||
        remainingMs < 0) {
      return null;
    }
    return ServerClockSnapshot(
      matchId: matchId,
      serverNowMs: serverNowMs,
      remainingMs: remainingMs,
      deadlineAt: int.tryParse(data['deadlineAt']?.toString() ?? ''),
      turnStartedAtServer: int.tryParse(
        data['turnStartedAtServer']?.toString() ?? '',
      ),
      timeControlSeconds: int.tryParse(
        data['timeControlSeconds']?.toString() ?? '',
      ),
      currentTurn: data['currentTurn']?.toString(),
      currentTurnUserId: data['currentTurnUserId']?.toString(),
      status: data['status']?.toString(),
      version: int.tryParse(
        (data['version'] ?? data['stateVersion'])?.toString() ?? '',
      ),
    );
  }
}

class MatchState {
  final GameState? gameState;
  final String? currentUserId;
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
  final int? opponentGracePeriodMs;
  final int opponentDisconnectSequence;
  final SettlementPhase settlementPhase;
  final int? confirmedPayoutMinorUnits;
  final String? endReason;
  final MatchResultViewData? authoritativeResult;
  final ServerClockSnapshot? serverClock;
  final int clockRevision;
  final MatchRecoveryPhase recoveryPhase;

  const MatchState({
    this.gameState,
    this.currentUserId,
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
    this.opponentGracePeriodMs,
    this.opponentDisconnectSequence = 0,
    this.settlementPhase = SettlementPhase.pending,
    this.confirmedPayoutMinorUnits,
    this.endReason,
    this.authoritativeResult,
    this.serverClock,
    this.clockRevision = 0,
    this.recoveryPhase = MatchRecoveryPhase.none,
  });

  MatchState copyWith({
    GameState? gameState,
    String? currentUserId,
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
    bool clearOpponentDisconnect = false,
    int? opponentGracePeriodMs,
    int? opponentDisconnectSequence,
    SettlementPhase? settlementPhase,
    int? confirmedPayoutMinorUnits,
    String? endReason,
    MatchResultViewData? authoritativeResult,
    bool clearResult = false,
    ServerClockSnapshot? serverClock,
    bool clearServerClock = false,
    int? clockRevision,
    MatchRecoveryPhase? recoveryPhase,
  }) {
    return MatchState(
      gameState: gameState ?? this.gameState,
      currentUserId: currentUserId ?? this.currentUserId,
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
      opponentGracePeriodMs: clearOpponentDisconnect
          ? null
          : opponentGracePeriodMs ?? this.opponentGracePeriodMs,
      opponentDisconnectSequence:
          opponentDisconnectSequence ?? this.opponentDisconnectSequence,
      settlementPhase: settlementPhase ?? this.settlementPhase,
      confirmedPayoutMinorUnits: clearResult
          ? null
          : confirmedPayoutMinorUnits ?? this.confirmedPayoutMinorUnits,
      endReason: clearResult ? null : endReason ?? this.endReason,
      authoritativeResult: clearResult
          ? null
          : authoritativeResult ?? this.authoritativeResult,
      serverClock: clearServerClock ? null : serverClock ?? this.serverClock,
      clockRevision: clockRevision ?? this.clockRevision,
      recoveryPhase: recoveryPhase ?? this.recoveryPhase,
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
  final List<StreamSubscription<dynamic>> _subscriptions = [];
  StreamSubscription<List<ConnectivityResult>>? _connectivitySubscription;
  Timer? _clockSyncTimer;
  bool _hasConnectedSocket = false;

  MatchNotifier(this._socketService, this._dio) : super(const MatchState()) {
    _initListeners();
  }

  void setCurrentUserId(String? userId) {
    if (userId != null && userId.trim().isNotEmpty) {
      _currentUserId = userId;
      state = state.copyWith(currentUserId: userId);
    }
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
            recoveryPhase: MatchRecoveryPhase.none,
            isMovePending: false,
            clearPendingMove: true,
            clearRejection: true,
          );
        } catch (_) {
          state = state.copyWith(syncState: MatchSyncState.syncing);
          // The contract intentionally leaves the final compact board
          // encoding unresolved. Do not loop or invent a board when a V2
          // snapshot uses an unsupported encoding.
          if (!_socketService.isV2) {
            final matchId = state.currentMatchId;
            if (matchId != null) unawaited(fetchGameState(matchId));
          }
        }
      }),
    );

    _subscriptions.add(
      _socketService.onMoveApplied.listen((data) {
        final eventMatchId = data['matchId']?.toString();
        if (eventMatchId != null &&
            eventMatchId.isNotEmpty &&
            eventMatchId != state.currentMatchId) {
          return;
        }
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

        final currentVersion = state.gameState!.stateVersion;
        final incomingVersion = event.stateVersion;
        if (incomingVersion != null && incomingVersion <= currentVersion) {
          // Duplicate or stale accepted event. The canonical board already
          // includes it, so never apply it a second time.
          return;
        }
        if (incomingVersion != null && incomingVersion > currentVersion + 1) {
          state = state.copyWith(syncState: MatchSyncState.syncing);
          final matchId = state.currentMatchId;
          if (matchId != null) unawaited(fetchGameState(matchId));
          return;
        }

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
          stateVersion: incomingVersion ?? currentVersion + 1,
          moveCount: incomingVersion ?? state.gameState!.moveCount + 1,
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
        final explicitGrace = int.tryParse(
          data['gracePeriodMs']?.toString() ?? '',
        );
        state = state.copyWith(
          opponentConnected: false,
          opponentGracePeriodMs: explicitGrace,
          opponentDisconnectSequence: state.opponentDisconnectSequence + 1,
        );
      }),
    );
    _subscriptions.add(
      _socketService.onOpponentReconnected.listen((_) {
        final matchId = state.currentMatchId;
        state = state.copyWith(
          opponentConnected: true,
          clearOpponentDisconnect: true,
          syncState: matchId == null ? state.syncState : MatchSyncState.syncing,
          recoveryPhase: matchId == null
              ? state.recoveryPhase
              : MatchRecoveryPhase.resyncing,
        );
        if (matchId != null) _requestAuthoritativeMatchState(matchId);
      }),
    );
    _subscriptions.add(
      _socketService.onClockSync.listen((data) {
        final snapshot = ServerClockSnapshot.tryFromServer(data);
        if (snapshot == null || snapshot.matchId != state.currentMatchId) {
          return;
        }
        state = state.copyWith(
          serverClock: snapshot,
          clockRevision: state.clockRevision + 1,
        );
      }),
    );
    _subscriptions.add(
      _socketService.onConnectionPhase.listen((phase) {
        switch (phase) {
          case SocketConnectionPhase.connected:
            final recovering =
                _hasConnectedSocket ||
                state.recoveryPhase != MatchRecoveryPhase.none;
            _hasConnectedSocket = true;
            final matchId = state.currentMatchId;
            if (recovering && matchId != null) {
              state = state.copyWith(
                syncState: MatchSyncState.syncing,
                recoveryPhase: MatchRecoveryPhase.resyncing,
              );
              _requestAuthoritativeMatchState(matchId);
            }
          case SocketConnectionPhase.disconnected:
          case SocketConnectionPhase.failed:
            state = state.copyWith(
              syncState: MatchSyncState.offline,
              recoveryPhase: MatchRecoveryPhase.connectionLost,
            );
          case SocketConnectionPhase.reconnecting:
            state = state.copyWith(
              syncState: MatchSyncState.syncing,
              recoveryPhase: MatchRecoveryPhase.reconnecting,
            );
        }
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
            MatchResultViewData.tryFromServer(
              data,
              fallbackOpponent: MatchPlayer(id: opponentId, name: 'Opponent'),
            ) ??
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
    _subscriptions.add(
      _socketService.onSettlementCompleted.listen((data) {
        final eventMatchId = data['matchId']?.toString();
        if (eventMatchId == null || eventMatchId != state.currentMatchId) {
          return;
        }
        final result = state.authoritativeResult;
        state = state.copyWith(
          settlementPhase: SettlementPhase.confirmed,
          authoritativeResult: result?.copyWith(
            settlement: SettlementPhase.confirmed,
            receiptReference: data['receiptId']?.toString(),
          ),
        );
      }),
    );

    _connectivitySubscription = Connectivity().onConnectivityChanged.listen((
      List<ConnectivityResult> result,
    ) {
      if (!result.contains(ConnectivityResult.none)) {
        if (!_isReconnecting && state.currentMatchId != null) {
          _isReconnecting = true;
          state = state.copyWith(
            syncState: MatchSyncState.syncing,
            recoveryPhase: MatchRecoveryPhase.reconnecting,
          );
          _socketService.reconnect().then((_) {
            _isReconnecting = false;
          });
        }
      } else {
        state = state.copyWith(
          syncState: MatchSyncState.offline,
          recoveryPhase: MatchRecoveryPhase.connectionLost,
        );
      }
    });
  }

  void _requestAuthoritativeMatchState(String matchId) {
    _socketService.requestCanonicalState(matchId);
    _socketService.requestClockSync(matchId);
  }

  Future<void> fetchGameState(String matchId) async {
    state = state.copyWith(
      currentMatchId: matchId,
      syncState: MatchSyncState.syncing,
    );
    if (_socketService.isV2) {
      _requestAuthoritativeMatchState(matchId);
      return;
    }
    try {
      final response = await _dio.get('/matches/$matchId/state');

      if (response.statusCode == 200) {
        final gameState = GameState.fromJson(response.data);
        state = state.copyWith(
          gameState: gameState,
          syncState: MatchSyncState.synced,
          recoveryPhase: MatchRecoveryPhase.none,
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
    _socketService.requestClockSync(matchId);
    _clockSyncTimer?.cancel();
    if (_socketService.isV2) {
      _clockSyncTimer = Timer.periodic(const Duration(seconds: 15), (_) {
        if (state.currentMatchId == matchId &&
            state.syncState == MatchSyncState.synced) {
          _socketService.requestClockSync(matchId);
        }
      });
    }
  }

  void handleAppResumed(String matchId) {
    if (state.currentMatchId != matchId) return;
    state = state.copyWith(
      syncState: MatchSyncState.syncing,
      recoveryPhase: MatchRecoveryPhase.appResumed,
    );
    _requestAuthoritativeMatchState(matchId);
  }

  Future<void> retryConnection() async {
    final matchId = state.currentMatchId;
    if (matchId == null) return;
    state = state.copyWith(
      syncState: MatchSyncState.syncing,
      recoveryPhase: MatchRecoveryPhase.reconnecting,
    );
    await _socketService.reconnect();
    _requestAuthoritativeMatchState(matchId);
  }

  void dismissPromotion() {
    state = state.copyWith(promotionVisible: false);
  }

  void clearRejection() {
    state = state.copyWith(clearRejection: true);
  }

  bool offerDraw() {
    return false;
  }

  void respondToDraw(bool accept) {
    if (state.incomingDrawOffer == null) return;
    state = state.copyWith(clearDrawOffer: true);
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
    _clockSyncTimer?.cancel();
    super.dispose();
  }
}

final matchProvider = StateNotifierProvider<MatchNotifier, MatchState>((ref) {
  return MatchNotifier(socketService, ref.watch(apiClientProvider));
});
