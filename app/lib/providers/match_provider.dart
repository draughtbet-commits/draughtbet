import 'dart:async';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:dio/dio.dart';
import '../models/game_state.dart';
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
  final bool promotionVisible;
  final List<int> lastCapturedSquares;
  final bool opponentConnected;
  final DateTime? opponentDisconnectedAt;
  final int? opponentGracePeriodMs;
  final bool? playerReadyConfirmed;
  final bool? opponentReadyConfirmed;
  final SettlementPhase settlementPhase;
  final int? confirmedPayoutMinorUnits;
  final String? endReason;

  const MatchState({
    this.gameState,
    this.syncState = MatchSyncState.synced,
    this.isFindingMatch = false,
    this.currentMatchId,
    this.openCallouts = const [],
    this.isMovePending = false,
    this.rejectionReason,
    this.promotionVisible = false,
    this.lastCapturedSquares = const [],
    this.opponentConnected = true,
    this.opponentDisconnectedAt,
    this.opponentGracePeriodMs,
    this.playerReadyConfirmed,
    this.opponentReadyConfirmed,
    this.settlementPhase = SettlementPhase.pending,
    this.confirmedPayoutMinorUnits,
    this.endReason,
  });

  MatchState copyWith({
    GameState? gameState,
    MatchSyncState? syncState,
    bool? isFindingMatch,
    String? currentMatchId,
    List<Callout>? openCallouts,
    bool? isMovePending,
    String? rejectionReason,
    bool clearRejection = false,
    bool? promotionVisible,
    List<int>? lastCapturedSquares,
    bool? opponentConnected,
    DateTime? opponentDisconnectedAt,
    bool clearOpponentDisconnect = false,
    int? opponentGracePeriodMs,
    bool? playerReadyConfirmed,
    bool? opponentReadyConfirmed,
    SettlementPhase? settlementPhase,
    int? confirmedPayoutMinorUnits,
    String? endReason,
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
      promotionVisible: promotionVisible ?? this.promotionVisible,
      lastCapturedSquares: lastCapturedSquares ?? this.lastCapturedSquares,
      opponentConnected: opponentConnected ?? this.opponentConnected,
      opponentDisconnectedAt: clearOpponentDisconnect
          ? null
          : opponentDisconnectedAt ?? this.opponentDisconnectedAt,
      opponentGracePeriodMs: clearOpponentDisconnect
          ? null
          : opponentGracePeriodMs ?? this.opponentGracePeriodMs,
      playerReadyConfirmed:
          playerReadyConfirmed ?? this.playerReadyConfirmed,
      opponentReadyConfirmed:
          opponentReadyConfirmed ?? this.opponentReadyConfirmed,
      settlementPhase: settlementPhase ?? this.settlementPhase,
      confirmedPayoutMinorUnits: clearResult
          ? null
          : confirmedPayoutMinorUnits ?? this.confirmedPayoutMinorUnits,
      endReason: clearResult ? null : endReason ?? this.endReason,
    );
  }
}

class MatchNotifier extends StateNotifier<MatchState> {
  final SocketService _socketService;
  final Dio _dio;
  final SecureStorageService _storage = SecureStorageService();

  bool _isReconnecting = false;
  String? _myUserId;
  final List<StreamSubscription<Map<String, dynamic>>> _subscriptions = [];
  StreamSubscription<List<ConnectivityResult>>? _connectivitySubscription;
  StreamSubscription<void>? _reconnectSubscription;

  MatchNotifier(this._socketService, this._dio) : super(const MatchState()) {
    _initListeners();
    _storage.userId.then((value) => _myUserId = value);
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
      _socketService.onMatchState.listen((data) {
        _applyCanonicalPayload(data);
      }),
    );

    _subscriptions.add(
      _socketService.onGameState.listen((data) {
        _applyCanonicalPayload(data);
      }),
    );

    _subscriptions.add(
      _socketService.onMoveApplied.listen((data) {
        final event = MoveAppliedEvent.fromJson(data);
        if (state.gameState == null) return;

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
        final reason = data['reason']?.toString() ?? 'move_rejected';
        state = state.copyWith(
          isMovePending: false,
          rejectionReason: reason,
          syncState: reason == 'illegal_move'
              ? MatchSyncState.synced
              : MatchSyncState.syncing,
        );
        if (reason != 'illegal_move' && state.currentMatchId != null) {
          await fetchGameState(state.currentMatchId!);
        }
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
          gameState: current.copyWith(
            status: 'completed',
            winnerId: data['winnerId']?.toString(),
          ),
          isMovePending: false,
          settlementPhase: SettlementPhase.pending,
          endReason: 'resign',
        );
      }),
    );

    _subscriptions.add(
      _socketService.onMatchEnded.listen((data) {
        final current = state.gameState;
        if (current == null) return;
        final winnerId = data['winnerId']?.toString();
        final payout = int.tryParse(data['payout']?.toString() ?? '');
        state = state.copyWith(
          gameState: current.copyWith(
            status: winnerId == null || winnerId.isEmpty ? 'draw' : 'completed',
            winnerId: winnerId,
          ),
          isMovePending: false,
          settlementPhase: SettlementPhase.confirmed,
          confirmedPayoutMinorUnits: payout,
          endReason: data['reason']?.toString(),
        );
        unawaited(_storage.clearActiveMatchId());
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

    // A re-established socket must rejoin the match room and resync so the
    // play/room projection stays live after a backend drop or reconnect.
    _reconnectSubscription = _socketService.onReconnected.listen((_) {
      final matchId = state.currentMatchId;
      if (matchId == null || matchId.isEmpty) return;
      _socketService.joinMatch(matchId);
      unawaited(fetchGameState(matchId));
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

  void attemptMove(int from, int to) {
    if (state.currentMatchId == null ||
        state.gameState == null ||
        state.isMovePending ||
        state.syncState != MatchSyncState.synced) {
      return;
    }

    // Optimistic UI update could go here. For now, we trust the server.
    state = state.copyWith(isMovePending: true, clearRejection: true);
    _socketService.attemptMove(state.currentMatchId!, from, to);
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

  void markReady() {
    final matchId = state.currentMatchId;
    if (matchId == null) return;
    _socketService.markReady(matchId);
  }

  /// Applies a canonical `match.state` payload (socket `match.state`/`game_state`
  /// resync) into the projection. Derives per-player readiness from the
  /// `participants[]` array and opponent presence from `connection[]`.
  void _applyCanonicalPayload(Map<String, dynamic> data) {
    var payload = Map<String, dynamic>.from(data);
    bool? myReady;
    bool? oppReady;
    String? lightId;
    String? darkId;
    if (payload['participants'] is List && _myUserId != null) {
      for (final raw in payload['participants'] as List) {
        final entry = raw is Map ? Map<String, dynamic>.from(raw) : null;
        if (entry == null) continue;
        final userId = entry['userId']?.toString();
        final ready = entry['ready'] == true;
        if (entry['side']?.toString() == 'LIGHT' && userId != null) {
          lightId = userId;
        }
        if (entry['side']?.toString() == 'DARK' && userId != null) {
          darkId = userId;
        }
        if (userId == _myUserId) {
          myReady = ready;
        } else if (userId != null && userId.isNotEmpty) {
          oppReady = ready;
        }
      }
    }
    bool opponentConnected = state.opponentConnected;
    if (payload['connection'] is List && _myUserId != null) {
      for (final raw in payload['connection'] as List) {
        final entry = raw is Map ? Map<String, dynamic>.from(raw) : null;
        if (entry == null) continue;
        if (entry['userId']?.toString() == _myUserId) continue;
        opponentConnected = entry['status']?.toString() != 'disconnected';
      }
    }

    // `match.state` carries participants, not player ids; map sides back so
    // GameState can derive player1/player2 for turn ownership checks.
    if (lightId != null || darkId != null) {
      payload['players'] = <String, dynamic>{
        'light': lightId ?? payload['player1'] ?? '',
        'dark': darkId ?? payload['player2'] ?? '',
      };
    }

    GameState? gameState;
    try {
      gameState = GameState.fromJson(payload);
    } catch (_) {
      return;
    }
    state = state.copyWith(
      gameState: gameState,
      syncState: MatchSyncState.synced,
      isMovePending: false,
      clearRejection: true,
      playerReadyConfirmed: myReady ?? state.playerReadyConfirmed,
      opponentReadyConfirmed: oppReady ?? state.opponentReadyConfirmed,
      opponentConnected: opponentConnected,
    );
  }

  void dismissPromotion() {
    state = state.copyWith(promotionVisible: false);
  }

  void clearRejection() {
    state = state.copyWith(clearRejection: true);
  }

  void resign() {
    if (state.currentMatchId != null) {
      _socketService.resign(state.currentMatchId!);
    }
  }

  @override
  void dispose() {
    for (final subscription in _subscriptions) {
      subscription.cancel();
    }
    _connectivitySubscription?.cancel();
    _reconnectSubscription?.cancel();
    super.dispose();
  }
}

final matchProvider = StateNotifierProvider<MatchNotifier, MatchState>((ref) {
  return MatchNotifier(socketService, ref.watch(apiClientProvider));
});
