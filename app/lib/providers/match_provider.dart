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

// Server `error` codes that mean a `draw.offer` was refused; used to release
// the optimistic pending flag so the player can try again.
const Set<String> _drawRejectionCodes = {
  'not_your_turn',
  'stale_state',
  'draw_already_offered',
  'game_not_in_progress',
  'game_already_ended',
  'not_authorized',
  'invalid_payload',
};

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

  /// The served game has ended (settling or settled); the match is no longer
  /// playable even though the result/receipt flow may still be running.
  bool get isMatchOver =>
      gameState?.status == 'settling' || gameState?.status == 'completed';
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
          // The server folds the draw protocol into the canonical snapshot
          // (`pendingDrawOffer`) instead of emitting dedicated draw events, so
          // this is the only place an incoming offer or its resolution is ever
          // observed. Reconcile it here so both players stay in step across a
          // resync/reconnect, not only at the moment of the offer.
          final me = _currentUserId ?? state.currentUserId;
          final pending = data['pendingDrawOffer'];
          final pendingMap = pending is Map
              ? Map<String, dynamic>.from(pending)
              : const <String, dynamic>{};
          final pendingOfferId = pendingMap['offerId']?.toString() ?? '';
          final offeredBy = pendingMap['offeredByUserId']?.toString();
          final hasPending = pendingOfferId.isNotEmpty;
          final isMine = hasPending && me != null && offeredBy == me;
          final isTheirs = hasPending && !isMine;
          final hadPending = state.drawOfferPending;

          // A pending offer that is still visible and mine keeps the pending
          // latch; one that vanished while the match continued is the decline
          // signal (accept ends the match through the settlement path, so it is
          // excluded here and the terminal handling takes over).
          final pendingRejected =
              !hasPending && hadPending && gameState.status == 'in_progress';

          // Deliberately does NOT clear the rejection banner. This snapshot is
          // the remedy the stale-state path itself requests, so it lands
          // immediately after move_rejected and used to wipe the notice before
          // the player could ever see it. The banner is dismissed explicitly
          // (clearRejection) or by the next deliberate action.
          state = state.copyWith(
            gameState: gameState,
            syncState: MatchSyncState.synced,
            recoveryPhase: MatchRecoveryPhase.none,
            isMovePending: false,
            clearPendingMove: true,
            incomingDrawOffer: isTheirs ? DrawOffer(offerId: pendingOfferId) : null,
            clearDrawOffer: state.incomingDrawOffer != null && !isTheirs,
            drawOfferPending: hasPending ? isMine : (hadPending ? false : null),
            drawOfferRejected: pendingRejected ? true : (hasPending ? false : null),
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
          drawOfferRejected: response == 'decline' || response == 'rejected' || response == 'declined',
        );
      }),
    );
    // A rejected action arrives on the shared `error` event, not `match.state`.
    // Without this the optimistic `drawOfferPending` flag set by offerDraw would
    // never clear when the server refuses the offer (wrong turn, stale version).
    _subscriptions.add(
      _socketService.onError.listen((data) {
        if (!state.drawOfferPending) return;
        final code = data['code']?.toString();
        if (code != null && _drawRejectionCodes.contains(code)) {
          state = state.copyWith(drawOfferPending: false);
        }
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
        // Presence echo, not news. When the opponent is already known to be
        // present this notification is a duplicate of state we hold, and it must
        // not trigger a canonical resync: resyncing re-joins, the server sees
        // that as a join and notifies the opponent, who resyncs and re-joins --
        // a mutual loop that exhausts the match.join budget and stops both
        // players entering the room.
        if (state.opponentConnected) return;
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
      _socketService.onPreplayReleased.listen((data) {
        // The ready gate closed before play began. There is no settlement to
        // wait for, so mark the match terminal immediately — otherwise the room
        // sits on "Waiting for authoritative match state" for ever, because no
        // further clock.sync or match.state will arrive for a released match.
        final matchId = data['matchId']?.toString();
        if (matchId != null &&
            state.currentMatchId != null &&
            matchId != state.currentMatchId) {
          return;
        }
        final current = state.gameState;
        final endReason = data['reason']?.toString() ?? 'cancelled_pre_play';
        // The stored pointer outlives the app; leaving it set is what makes a
        // released match look live on the next launch.
        unawaited(_storage.clearActiveMatchId());
        _socketService.clearJoinedMatch();
        state = state.copyWith(
          gameState: current?.copyWith(status: 'completed'),
          isMovePending: false,
          resignPending: false,
          settlementPhase: SettlementPhase.confirmed,
          endReason: endReason,
          syncState: MatchSyncState.synced,
          recoveryPhase: MatchRecoveryPhase.none,
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
        final isBroadcastOutcome = data['winnerId'] != null;
        final result = isBroadcastOutcome
            ? (currentUserId == null || matchId == null
                  ? null
                  : MatchResultViewData.tryFromActiveMatchEnded(
                      data,
                      matchId: matchId,
                      currentUserId: currentUserId,
                      opponentId: opponentId,
                    ))
            : MatchResultViewData.tryFromServer(
                data,
                fallbackOpponent:
                    MatchPlayer(id: opponentId, name: 'Opponent'),
              );

        if (result == null && state.authoritativeResult != null) {
          // The winning settle emits match_ended (money fields) followed by a
          // money-less match.finished retransmission. Deriving nothing here is
          // expected — never overwrite the authoritative result already set.
          return;
        }

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
        if (result != null) {
          unawaited(_storage.clearActiveMatchId());
          _socketService.clearJoinedMatch();
        }
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

  /// Restores a match the app was last in, but only if the server still agrees
  /// it is live.
  ///
  /// The stored pointer survives restarts, and a match that ended while the app
  /// was closed (released by the ready gate, or settled on the other device)
  /// never emits anything afterwards — so trusting it alone strands the UI on
  /// "in play" for a match that no longer exists.
  ///
  /// Absence from `GET /matches/active` is NOT proof the match is gone: that
  /// endpoint only lists pre-start matches (OPEN / FUNDED / READY), so every
  /// in-play match is missing from it. Treating the omission as "ended" deleted
  /// the pointer on every mid-game reconnect, which left the player with no
  /// "Return to Match" at all. Only drop the pointer when the server positively
  /// reports the match as finished.
  Future<void> restoreActiveMatch() async {
    if (state.currentMatchId != null) return;
    final matchId = await _storage.activeMatchId;
    if (matchId == null || matchId.isEmpty) return;

    // Authoritative per-match check: this covers in-play, which /matches/active
    // omits by design.
    String? status;
    try {
      final response = await _dio.get<dynamic>('/matches/$matchId');
      final data = response.data;
      final body = data is Map && data['data'] is Map
          ? Map<String, dynamic>.from(data['data'] as Map)
          : null;
      if (body == null) {
        await fetchGameState(matchId);
        return;
      }
      final snapshotId = body['matchId']?.toString() ?? body['id']?.toString();
      if (snapshotId != null && snapshotId != matchId) {
        // Asked for one match and told about another: the stored pointer is
        // stale, so drop it rather than joining a room we did not ask for.
        await _storage.clearActiveMatchId();
        _socketService.clearJoinedMatch();
        return;
      }
      status = body['status']?.toString();
    } catch (error) {
      // 404 means the match is genuinely gone; anything else (offline, timeout,
      // 5xx) must not strand a match that really is live.
      if (_statusCodeOf(error) == 404) {
        await _storage.clearActiveMatchId();
        _socketService.clearJoinedMatch();
        return;
      }
      await fetchGameState(matchId);
      return;
    }

    if (_terminalMatchStatuses.contains(status)) {
      await _storage.clearActiveMatchId();
      _socketService.clearJoinedMatch();
      return;
    }
    await fetchGameState(matchId);
  }

  /// Statuses after which a match can never be resumed: the board is finished
  /// and any further state request would be rejected as stale.
  static const _terminalMatchStatuses = {
    'SETTLED',
    'RELEASED',
    'EXPIRED',
    'CANCELLED',
    'CANCELED',
    'FORFEITED',
  };

  /// HTTP status carried by a DioException, or null for anything else. Uses a
  /// runtime-safe read because the socket layer can surface non-Dio errors.
  int? _statusCodeOf(Object error) {
    try {
      final response = (error as dynamic).response;
      if (response == null) return null;
      final code = (response as dynamic).statusCode;
      return code is int ? code : null;
    } catch (_) {
      return null;
    }
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
      response: accept ? 'accept' : 'decline',
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
    _clockSyncTimer?.cancel();
    super.dispose();
  }
}

final matchProvider = StateNotifierProvider<MatchNotifier, MatchState>((ref) {
  return MatchNotifier(socketService, ref.watch(apiClientProvider));
});
