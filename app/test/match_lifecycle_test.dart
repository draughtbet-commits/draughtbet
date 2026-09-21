import 'dart:async';
import 'package:dio/dio.dart';
import 'package:draughts_arena/models/match_flow.dart';
import 'package:draughts_arena/providers/match_flow_provider.dart';
import 'package:draughts_arena/screens/match_lifecycle_screens.dart';
import 'package:draughts_arena/services/match_flow_gateway.dart';
import 'package:draughts_arena/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

const lifecycleOpponent = MatchPlayer(
  id: 'player-2',
  name: 'KingMoves',
  avatarId: 'avatar_04',
  rank: 'MASTER',
  rating: 1780,
);

const lifecycleTerms = MatchTerms(
  stakeMinorUnits: 200000,
  opponentStakeMinorUnits: 200000,
  platformFeeMinorUnits: 10000,
  totalPrizeMinorUnits: 390000,
  serverQuoted: true,
);

MatchLifecycleSnapshot lifecycleSnapshot(
  MatchLifecyclePhase phase, {
  AuthoritativeProgress release = AuthoritativeProgress.unknown,
}) => MatchLifecycleSnapshot(
  phase: phase,
  terms: lifecycleTerms,
  matchId: '2415678',
  roomCode: 'DB-2415',
  opponent: lifecycleOpponent,
  availableBalanceMinorUnits: 85000,
  limitMinorUnits: 100000,
  playerStake: AuthoritativeProgress.confirmed,
  playerReady: AuthoritativeProgress.confirmed,
  release: release,
  reason: 'This stake exceeds your current server limit.',
);

class TimeoutGateway extends MatchFlowGateway {
  TimeoutGateway() : super(Dio());

  @override
  Future<void> joinQueue(MatchTerms terms) => throw DioException(
    requestOptions: RequestOptions(path: '/matchmaking/join'),
    type: DioExceptionType.receiveTimeout,
  );
}

class CreatedCalloutGateway extends MatchFlowGateway {
  CreatedCalloutGateway() : super(Dio());

  var calls = 0;

  @override
  Future<String?> createOpenMatch(MatchTerms terms) async {
    calls += 1;
    return 'callout-not-a-match';
  }
}

void main() {
  test(
    'timed-out stake mutation remains unknown and is not reported failed',
    () async {
      final notifier = MatchFlowNotifier(TimeoutGateway());
      notifier.review(
        const MatchFlowIntent(
          kind: MatchEntryKind.quick,
          terms: lifecycleTerms,
        ),
      );
      await notifier.confirm();
      expect(notifier.state.actionPhase, MatchActionPhase.unknown);
      expect(notifier.state.message, contains('unknown'));
    },
  );

  test(
    'created callout waits for match_found before exposing a match ID',
    () async {
      final gateway = CreatedCalloutGateway();
      final notifier = MatchFlowNotifier(gateway);
      notifier.review(
        const MatchFlowIntent(
          kind: MatchEntryKind.created,
          terms: lifecycleTerms,
        ),
      );

      final returnedId = await notifier.confirm();

      expect(gateway.calls, 1);
      expect(returnedId, isNull);
      expect(notifier.state.currentMatchId, isNull);
      expect(notifier.state.searchPhase, SearchPhase.searching);

      notifier.matchFound('authoritative-match');
      expect(notifier.state.currentMatchId, 'authoritative-match');
      expect(notifier.state.searchPhase, SearchPhase.found);
    },
  );

  testWidgets('ready confirmation prevents duplicate submission', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(412, 915);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final completer = Completer<void>();
    var calls = 0;
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: ReadyCheckScreen(
          snapshot: lifecycleSnapshot(MatchLifecyclePhase.readyCheck),
          onReady: () {
            calls++;
            return completer.future;
          },
        ),
      ),
    );
    await tester.tap(find.text('I am ready'));
    await tester.pump();
    await tester.tap(find.text('Confirming readiness'));
    await tester.pump();
    expect(calls, 1);
    completer.complete();
    await tester.pump();
  });

  testWidgets('ready timeout distinguishes release processing', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: ReadyTimeoutScreen(
          snapshot: lifecycleSnapshot(MatchLifecyclePhase.readyTimeout),
        ),
      ),
    );
    expect(find.textContaining('still processing'), findsOneWidget);
    expect(find.textContaining('has not been changed locally'), findsOneWidget);
  });

  testWidgets('already-filled match never claims a stake lock', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: const MatchUnavailableScreen(alreadyFilled: true),
      ),
    );
    expect(find.textContaining('already filled'), findsOneWidget);
    expect(find.textContaining('No stake lock was confirmed'), findsOneWidget);
  });
}
