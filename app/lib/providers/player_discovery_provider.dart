import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../config/backend_contract.dart';
import '../models/match_flow.dart';
import '../services/api_client.dart';
import '../services/player_gateway.dart';

enum PlayerSearchPhase { idle, searching, results, empty, error }

class PlayerSearchState {
  const PlayerSearchState({
    this.phase = PlayerSearchPhase.idle,
    this.query = '',
    this.players = const [],
    this.message,
  });

  final PlayerSearchPhase phase;
  final String query;
  final List<MatchPlayer> players;
  final String? message;
}

class PlayerSearchNotifier extends StateNotifier<PlayerSearchState> {
  PlayerSearchNotifier(this._gateway) : super(const PlayerSearchState());

  final PlayerGateway _gateway;
  Timer? _debounce;

  static const _minChars = 2;
  static const _debounceDelay = Duration(milliseconds: 400);

  void updateQuery(String query) {
    _debounce?.cancel();
    if (query.trim().length < _minChars) {
      state = PlayerSearchState(query: query);
      return;
    }
    state = PlayerSearchState(query: query, phase: PlayerSearchPhase.searching);
    _debounce = Timer(
      _debounceDelay,
      () => _search(query.trim()),
    );
  }

  Future<void> _search(String query) async {
    state = PlayerSearchState(query: query, phase: PlayerSearchPhase.searching);
    try {
      final results = await _gateway.searchPlayers(query);
      if (!mounted || query != state.query) return;
      state = PlayerSearchState(
        query: query,
        phase: results.isEmpty
            ? PlayerSearchPhase.empty
            : PlayerSearchPhase.results,
        players: results,
      );
    } catch (_) {
      if (!mounted || query != state.query) return;
      state = PlayerSearchState(
        query: query,
        phase: PlayerSearchPhase.error,
        message: 'Could not load players. Check your connection and try again.',
      );
    }
  }

  void clear() {
    _debounce?.cancel();
    state = const PlayerSearchState();
  }

  // Seeds the directory with a fixed list (preview/dev harness or offline
  // fallback). A later query always replaces it.
  void setResults(List<MatchPlayer> players) {
    _debounce?.cancel();
    state = PlayerSearchState(
      phase: players.isEmpty
          ? PlayerSearchPhase.empty
          : PlayerSearchPhase.results,
      players: players,
    );
  }

  @override
  void dispose() {
    _debounce?.cancel();
    super.dispose();
  }
}

final playerGatewayProvider = Provider<PlayerGateway>(
  (ref) => PlayerGateway(
    ref.watch(apiClientProvider),
    contract: ref.watch(backendContractProvider),
  ),
);

final playerSearchProvider = StateNotifierProvider<PlayerSearchNotifier,
    PlayerSearchState>(
  (ref) => PlayerSearchNotifier(ref.watch(playerGatewayProvider)),
);