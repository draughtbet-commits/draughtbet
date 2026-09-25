import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:draughts_arena/config/backend_contract.dart';
import 'package:draughts_arena/models/match_flow.dart';
import 'package:draughts_arena/providers/player_discovery_provider.dart';
import 'package:draughts_arena/services/player_gateway.dart';
import 'package:flutter_test/flutter_test.dart';

const v2 = BackendContractConfig(BackendContractMode.v2);

class RecordingAdapter implements HttpClientAdapter {
  final List<RequestOptions> requests = [];
  final List<dynamic> _responses = [];

  void enqueue(dynamic body) => _responses.add(body);

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requests.add(options);
    return ResponseBody.fromString(
      jsonEncode(_responses.removeAt(0)),
      200,
      headers: {
        Headers.contentTypeHeader: ['application/json'],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

class _StubGateway extends PlayerGateway {
  _StubGateway(this._onSearch) : super(Dio(), contract: v2);

  final Future<List<MatchPlayer>> Function() _onSearch;

  @override
  Future<List<MatchPlayer>> searchPlayers(String query, {int limit = 10}) {
    return _onSearch();
  }
}

void main() {
  group('PlayerGateway V2 contract', () {
    test('searches the directory with the documented path and shape', () async {
      final adapter = RecordingAdapter();
      final dio = Dio(BaseOptions(baseUrl: 'https://api.example.test'));
      dio.httpClientAdapter = adapter;
      adapter.enqueue({
        'data': {
          'players': [
            {
              'id': 'usr_2',
              'username': 'QueenBee',
              'displayName': null,
              'avatar': 'avatar_07',
              'tier': 'MASTER',
              'rating': 1620,
              'wins': 40,
              'losses': 18,
              'draws': 2,
              'totalMatches': 60,
              'winRate': 67,
            },
          ],
        },
      });

      final players = await PlayerGateway(
        dio,
        contract: v2,
      ).searchPlayers('que');

      final request = adapter.requests.single;
      expect(request.path, '/players/search');
      expect(request.queryParameters['username'], 'que');
      expect(request.queryParameters['limit'], 10);

      final player = players.single;
      expect(player.id, 'usr_2');
      expect(player.name, 'QueenBee');
      expect(player.avatarId, 'avatar_07');
      expect(player.rank, 'MASTER');
      expect(player.rating, 1620);
      expect(player.winRate, 67);
      expect(player.level, isNull);
    });

    test('fetches the public profile by id', () async {
      final adapter = RecordingAdapter();
      final dio = Dio(BaseOptions(baseUrl: 'https://api.example.test'));
      dio.httpClientAdapter = adapter;
      adapter.enqueue({
        'data': {
          'player': {
            'id': 'usr_2',
            'username': 'QueenBee',
            'avatar': 'avatar_07',
            'tier': 'PRO',
            'rating': 1500,
            'winRate': 55,
          },
        },
      });

      final player = await PlayerGateway(
        dio,
        contract: v2,
      ).fetchProfile('usr_2');

      expect(adapter.requests.single.path, '/players/usr_2');
      expect(player?.rating, 1500);
      expect(player?.winRate, 55);
    });
  });

  group('PlayerSearchNotifier', () {
    test('ignores single-character queries', () {
      final notifier = PlayerSearchNotifier(
        _StubGateway(() async => const []),
      );
      notifier.updateQuery('a');
      expect(notifier.state.phase, PlayerSearchPhase.idle);
      notifier.dispose();
    });

    test('debounces and surfaces results', () async {
      final notifier = PlayerSearchNotifier(
        _StubGateway(
          () async => const [
            MatchPlayer(id: 'usr_2', name: 'QueenBee', rank: 'MASTER'),
          ],
        ),
      );
      notifier.updateQuery('que');
      expect(notifier.state.phase, PlayerSearchPhase.searching);
      await Future<void>.delayed(const Duration(milliseconds: 500));
      expect(notifier.state.phase, PlayerSearchPhase.results);
      expect(notifier.state.players.single.name, 'QueenBee');
      notifier.dispose();
    });

    test('surfaces an empty directory state', () async {
      final notifier = PlayerSearchNotifier(
        _StubGateway(() async => const []),
      );
      notifier.updateQuery('seed');
      await Future<void>.delayed(const Duration(milliseconds: 500));
      expect(notifier.state.phase, PlayerSearchPhase.empty);
      notifier.dispose();
    });
  });
}