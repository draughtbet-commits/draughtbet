import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';
import '../models/game_state.dart';
import '../models/callout.dart';
import '../services/socket_service.dart';

enum MatchSyncState { synced, syncing, offline }

class MatchState {
  final GameState? gameState;
  final MatchSyncState syncState;
  final bool isFindingMatch;
  final String? currentMatchId;
  final List<Callout> openCallouts;

  const MatchState({
    this.gameState,
    this.syncState = MatchSyncState.synced,
    this.isFindingMatch = false,
    this.currentMatchId,
    this.openCallouts = const [],
  });

  MatchState copyWith({
    GameState? gameState,
    MatchSyncState? syncState,
    bool? isFindingMatch,
    String? currentMatchId,
    List<Callout>? openCallouts,
  }) {
    return MatchState(
      gameState: gameState ?? this.gameState,
      syncState: syncState ?? this.syncState,
      isFindingMatch: isFindingMatch ?? this.isFindingMatch,
      currentMatchId: currentMatchId ?? this.currentMatchId,
      openCallouts: openCallouts ?? this.openCallouts,
    );
  }
}

class MatchNotifier extends StateNotifier<MatchState> {
  final SocketService _socketService;
  final Dio _dio;
  
  // Keep track of the last attempted move for rollback
  Map<String, dynamic>? _lastAttemptedMove;
  bool _isReconnecting = false;
  bool _hasRetriedMove = false;
  
  MatchNotifier(this._socketService, this._dio) : super(const MatchState()) {
    _initListeners();
  }

  void _initListeners() {
    _socketService.onMatchFound.listen((data) {
      final matchId = data['id'];
      state = state.copyWith(
        isFindingMatch: false,
        currentMatchId: matchId,
      );
      _socketService.joinMatch(matchId);
    });

    _socketService.onCalloutCreated.listen((data) {
      final callout = Callout.fromJson(data);
      // We'll add it to the state; TierSelectScreen can filter by tier
      state = state.copyWith(
        openCallouts: [callout, ...state.openCallouts],
      );
    });

    _socketService.onGameState.listen((data) {
      final gameState = GameState.fromJson(data);
      state = state.copyWith(gameState: gameState, syncState: MatchSyncState.synced);
      _lastAttemptedMove = null;
    });

    _socketService.onMoveApplied.listen((data) {
      final event = MoveAppliedEvent.fromJson(data);
      if (state.gameState == null) return;
      
      final newState = state.gameState!.copyWith(
        board: event.board,
        currentTurn: event.nextTurn,
        status: event.gameEnded ? 'completed' : 'in_progress',
        legalMoves: event.legalMoves,
      );
      
      state = state.copyWith(gameState: newState, syncState: MatchSyncState.synced);
      _lastAttemptedMove = null;
      _hasRetriedMove = false;
    });

    _socketService.onMoveRejected.listen((data) async {
      print("Move rejected! hasRetried: $_hasRetriedMove, lastMove: $_lastAttemptedMove, reason: ${data['reason']}");
      // Immediate retry if we haven't retried yet and it wasn't an outright illegal move
      if (!_hasRetriedMove && _lastAttemptedMove != null && data['reason'] != 'illegal_move') {
        _hasRetriedMove = true;
        _socketService.attemptMove(
          state.currentMatchId!, 
          _lastAttemptedMove!['from'], 
          _lastAttemptedMove!['to']
        );
        return;
      }
      
      // If retry fails or move was illegal, show syncing and fetch state
      _hasRetriedMove = false;
      state = state.copyWith(syncState: MatchSyncState.syncing);
      
      if (state.currentMatchId != null) {
        await fetchGameState(state.currentMatchId!);
      }
    });

    Connectivity().onConnectivityChanged.listen((List<ConnectivityResult> result) {
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
      state = state.copyWith(syncState: MatchSyncState.syncing);
      final storage = const FlutterSecureStorage();
      final token = await storage.read(key: 'jwt');
      final backendUrl = dotenv.env['BACKEND_URL'] ?? 'http://localhost:3000';
      
      final response = await _dio.get(
        '$backendUrl/matches/$matchId/state',
        options: Options(headers: {'Authorization': 'Bearer $token'}),
      );
      
      if (response.statusCode == 200) {
        final gameState = GameState.fromJson(response.data);
        state = state.copyWith(gameState: gameState, syncState: MatchSyncState.synced);
      }
    } catch (e) {
      print('Failed to sync game state: $e');
      // Remain in syncing state or show error
    }
  }

  Future<void> joinQueue(String tier, int stakeMinorUnits) async {
    state = state.copyWith(isFindingMatch: true);
    try {
      final storage = const FlutterSecureStorage();
      final token = await storage.read(key: 'jwt');
      final backendUrl = dotenv.env['BACKEND_URL'] ?? 'http://localhost:3000';
      
      await _dio.post(
        '$backendUrl/matchmaking/join',
        data: {'stakeMinorUnits': stakeMinorUnits},
        options: Options(headers: {'Authorization': 'Bearer $token'}),
      );
    } catch (e) {
      state = state.copyWith(isFindingMatch: false);
      print('Failed to join queue: $e');
    }
  }

  Future<void> leaveQueue(String tier, int stakeMinorUnits) async {
    try {
      final storage = const FlutterSecureStorage();
      final token = await storage.read(key: 'jwt');
      final backendUrl = dotenv.env['BACKEND_URL'] ?? 'http://localhost:3000';
      
      await _dio.post(
        '$backendUrl/matchmaking/leave',
        data: {'stakeMinorUnits': stakeMinorUnits},
        options: Options(headers: {'Authorization': 'Bearer $token'}),
      );
      state = state.copyWith(isFindingMatch: false);
    } catch (e) {
      print('Failed to leave queue: $e');
    }
  }

  Future<void> fetchOpenCallouts() async {
    try {
      final storage = const FlutterSecureStorage();
      final token = await storage.read(key: 'jwt');
      final backendUrl = dotenv.env['BACKEND_URL'] ?? 'http://localhost:3000';
      
      final response = await _dio.get(
        '$backendUrl/callouts/open',
        options: Options(headers: {'Authorization': 'Bearer $token'}),
      );
      
      if (response.statusCode == 200) {
        final List<dynamic> data = response.data['callouts'] ?? [];
        final callouts = data.map((json) => Callout.fromJson(json)).toList();
        state = state.copyWith(openCallouts: callouts);
      }
    } catch (e) {
      print('Failed to fetch open callouts: $e');
    }
  }

  Future<void> createCallout(String tier, int stakeMinorUnits) async {
    try {
      final storage = const FlutterSecureStorage();
      final token = await storage.read(key: 'jwt');
      final backendUrl = dotenv.env['BACKEND_URL'] ?? 'http://localhost:3000';
      
      await _dio.post(
        '$backendUrl/callouts',
        data: {'stakeMinorUnits': stakeMinorUnits},
        options: Options(headers: {'Authorization': 'Bearer $token'}),
      );
      // The socket event will trigger prepending to the list.
    } catch (e) {
      print('Failed to create callout: $e');
      rethrow;
    }
  }

  Future<void> acceptCallout(String calloutId) async {
    try {
      final storage = const FlutterSecureStorage();
      final token = await storage.read(key: 'jwt');
      final backendUrl = dotenv.env['BACKEND_URL'] ?? 'http://localhost:3000';
      
      await _dio.post(
        '$backendUrl/callouts/$calloutId/accept',
        options: Options(headers: {'Authorization': 'Bearer $token'}),
      );
      // The server will emit match_found socket event which joins the match.
    } catch (e) {
      print('Failed to accept callout: $e');
      rethrow;
    }
  }
  
  void attemptMove(int from, int to) {
    if (state.currentMatchId == null || state.gameState == null) return;
    
    // Optimistic UI update could go here. For now, we trust the server.
    _lastAttemptedMove = {'from': from, 'to': to};
    _socketService.attemptMove(state.currentMatchId!, from, to);
  }
  
  void resign() {
    if (state.currentMatchId != null) {
      _socketService.resign(state.currentMatchId!);
    }
  }
}

final matchProvider = StateNotifierProvider<MatchNotifier, MatchState>((ref) {
  final dio = Dio();
  return MatchNotifier(socketService, dio);
});
