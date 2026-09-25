import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:draughts_arena/config/backend_contract.dart';
import 'package:draughts_arena/models/match_flow.dart';
import 'package:draughts_arena/providers/match_flow_provider.dart';
import 'package:draughts_arena/services/match_flow_gateway.dart';
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

class _StubGateway extends MatchFlowGateway {
  _StubGateway(this._handlers) : super(Dio(), contract: v2);

  final Map<String, dynamic> _handlers;

  Future<String?> get _createChallenge =>
      _handlers['createChallenge'] as Future<String?>? ??
      Future<String?>.value('match-1');

  @override
  Future<String?> createChallenge(String targetId, MatchTerms terms) =>
      _createChallenge;

  @override
  Future<MatchLifecycleSnapshot?> fetchMatch(
    String matchId,
    MatchTerms fallbackTerms,
  ) =>
      _handlers['fetchMatch'] as Future<MatchLifecycleSnapshot?>? ??
      Future<MatchLifecycleSnapshot?>.value(null);

  @override
  Future<ChallengeInvite?> fetchChallenge(String matchId) =>
      _handlers['fetchChallenge'] as Future<ChallengeInvite?>? ??
      Future<ChallengeInvite?>.value(null);

  @override
  Future<String?> acceptOpenMatch(String matchId) async => matchId;

  @override
  Future<MatchLifecycleSnapshot?> declineChallenge(
    String matchId,
    MatchTerms fallbackTerms,
  ) =>
      _handlers['declineChallenge'] as Future<MatchLifecycleSnapshot?>? ??
      Future<MatchLifecycleSnapshot?>.value(null);

  @override
  Future<MatchLifecycleSnapshot?> cancelMatch(
    String matchId,
    MatchTerms fallbackTerms,
  ) =>
      _handlers['cancelMatch'] as Future<MatchLifecycleSnapshot?>? ??
      Future<MatchLifecycleSnapshot?>.value(null);
}

const target = MatchPlayer(id: 'usr_2', name: 'Rival', rank: 'MASTER');

const terms = MatchTerms(
  stakeMinorUnits: 1000000,
  timeControl: '10 minutes',
  gameType: 'Classic',
  visibility: 'Anyone',
);

void main() {
  group('MatchFlowGateway challenge contract', () {
    test('createChallenge posts to the players surface with remapped terms',
        () async {
      final adapter = RecordingAdapter();
      final dio = Dio(BaseOptions(baseUrl: 'https://api.example.test'));
      dio.httpClientAdapter = adapter;
      adapter.enqueue({'data': {'id': 'match-9'}});

      final id = await MatchFlowGateway(
        dio,
        contract: v2,
      ).createChallenge('usr_2', terms);

      final request = adapter.requests.single;
      expect(request.path, '/players/usr_2/challenge');
      final body = request.data as Map<String, dynamic>;
      expect(body['stakeMinor'], 1000000);
      expect(body['timeControlSeconds'], 600);
      expect(body['ruleset'], 'INTERNATIONAL_10X10');
      expect(
        request.headers['Idempotency-Key'],
        isNotEmpty,
        reason: 'create must be idempotent-safe',
      );
      expect(id, 'match-9');
    });

    test('declineChallenge calls the decline route and maps to unavailable',
        () async {
      final adapter = RecordingAdapter();
      final dio = Dio(BaseOptions(baseUrl: 'https://api.example.test'));
      dio.httpClientAdapter = adapter;
      adapter.enqueue({
        'data': {'id': 'match-9', 'status': 'CANCELLED', 'declined': true},
      });

      final snapshot = await MatchFlowGateway(
        dio,
        contract: v2,
      ).declineChallenge('match-9', terms);

      expect(adapter.requests.single.path, '/matches/match-9/decline');
      expect(snapshot?.matchId, 'match-9');
      expect(snapshot?.phase, MatchLifecyclePhase.unavailable);
    });

    test('fetchChallenge builds terms and opponent for the invitee', () async {
      final adapter = RecordingAdapter();
      final dio = Dio(BaseOptions(baseUrl: 'https://api.example.test'));
      dio.httpClientAdapter = adapter;
      adapter.enqueue({
        'data': {
          'challenges': [
            {
              'id': 'c1',
              'matchId': 'match-9',
              'direction': 'received',
              'status': 'PENDING',
              'stakeMinorUnits': 1000000,
              'timeControlSeconds': 600,
              'ruleset': 'INTERNATIONAL_10X10',
              'opponent': {
                'id': 'usr_2',
                'username': 'Rival',
                'avatarId': 'avatar_03',
                'tier': 'MASTER',
              },
            },
          ],
        },
      });

      final invite = await MatchFlowGateway(
        dio,
        contract: v2,
      ).fetchChallenge('match-9');

      expect(invite, isNotNull);
      expect(adapter.requests.single.path, '/players/challenges');
      expect(invite!.matchId, 'match-9');
      expect(invite.direction, 'received');
      expect(invite.opponent.name, 'Rival');
      expect(invite.terms.stakeMinorUnits, 1000000);
      expect(invite.terms.timeControl, '10 minutes');
    });

    test('fetchMatch surfaces the opponent from the snapshot', () async {
      final adapter = RecordingAdapter();
      final dio = Dio(BaseOptions(baseUrl: 'https://api.example.test'));
      dio.httpClientAdapter = adapter;
      adapter.enqueue({
        'data': {
          'id': 'match-9',
          'status': 'FUNDED',
          'stakeMinor': 1000000,
          'opponent': {
            'id': 'usr_2',
            'username': 'Rival',
            'avatarId': 'avatar_03',
            'tier': 'MASTER',
          },
        },
      });

      final snapshot = await MatchFlowGateway(
        dio,
        contract: v2,
      ).fetchMatch('match-9', terms);

      expect(snapshot?.phase, MatchLifecyclePhase.readyCheck);
      expect(snapshot?.opponent?.name, 'Rival');
      expect(snapshot?.opponent?.rank, 'MASTER');
    });
  });

  group('MatchFlowNotifier challenge flow', () {
    test('createChallenge lands in the sent state with the match id', () async {
      final notifier = MatchFlowNotifier(_StubGateway({}));
      final snapshot = await notifier.createChallenge(target, terms);

      expect(snapshot?.phase, MatchLifecyclePhase.challengeSent);
      expect(snapshot?.matchId, 'match-1');
      expect(snapshot?.opponent?.id, 'usr_2');
      expect(notifier.state.currentMatchId, 'match-1');
      expect(notifier.state.currentIntent?.kind, MatchEntryKind.challenge);
      notifier.dispose();
    });

    test('acceptChallenge advances to the funded snapshot', () async {
      final snapshot = MatchLifecycleSnapshot(
        phase: MatchLifecyclePhase.readyCheck,
        terms: terms,
        matchId: 'match-1',
      );
      final notifier = MatchFlowNotifier(
        _StubGateway({'fetchMatch': Future.value(snapshot)}),
      );
      await notifier.createChallenge(target, terms);
      final accepted = await notifier.acceptChallenge();

      expect(accepted?.phase, MatchLifecyclePhase.readyCheck);
      expect(accepted?.matchId, 'match-1');
      notifier.dispose();
    });

    test('an incoming notification builds the challenge state', () async {
      final invite = ChallengeInvite(
        matchId: 'match-9',
        challengeId: 'c1',
        opponent: target,
        terms: terms,
        direction: 'received',
      );
      final notifier = MatchFlowNotifier(
        _StubGateway({'fetchChallenge': Future<ChallengeInvite?>.value(invite)}),
      );

      final snapshot = await notifier.handleIncomingChallenge('match-9');

      expect(snapshot?.phase, MatchLifecyclePhase.incomingChallenge);
      expect(snapshot?.opponent?.name, 'Rival');
      expect(notifier.state.currentIntent?.kind, MatchEntryKind.challenge);
      notifier.dispose();
    });

    test('declining leaves the flow in a cancelled state', () async {
      final cancelled = MatchLifecycleSnapshot(
        phase: MatchLifecyclePhase.unavailable,
        terms: terms,
        matchId: 'match-9',
      );
      final notifier = MatchFlowNotifier(
        _StubGateway({
          'fetchChallenge': Future<ChallengeInvite?>.value(
            ChallengeInvite(
              matchId: 'match-9',
              challengeId: 'c1',
              opponent: target,
              terms: terms,
              direction: 'received',
            ),
          ),
          'declineChallenge': Future.value(cancelled),
        }),
      );
      await notifier.handleIncomingChallenge('match-9');
      final result = await notifier.declineChallenge();

      expect(result?.phase, MatchLifecyclePhase.unavailable);
      expect(result?.matchId, 'match-9');
      notifier.dispose();
    });

    test('a failed create surfaces a readable message', () async {
      final notifier = MatchFlowNotifier(
        _StubGateway({
          'createChallenge': Future<String?>.value(null),
        }),
      );
      final snapshot = await notifier.createChallenge(target, terms);

      expect(snapshot, isNull);
      expect(notifier.state.actionPhase, MatchActionPhase.failed);
      notifier.dispose();
    });
  });
}