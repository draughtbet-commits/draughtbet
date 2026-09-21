import 'package:draughts_arena/models/match_flow.dart';
import 'package:draughts_arena/providers/settlement_provider.dart';
import 'package:draughts_arena/screens/match_result_screen.dart';
import 'package:draughts_arena/screens/settlement_result_screens.dart';
import 'package:draughts_arena/services/settlement_gateway.dart';
import 'package:draughts_arena/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'settlement_fixtures.dart';

class FixtureSettlementGateway extends SettlementGateway {
  FixtureSettlementGateway({this.result, this.receipt});

  final MatchResultViewData? result;
  final MatchReceiptData? receipt;
  int statusReads = 0;
  int receiptReads = 0;

  @override
  Future<MatchResultViewData?> fetchStatus(String matchId) async {
    statusReads += 1;
    return result;
  }

  @override
  Future<MatchReceiptData?> fetchReceipt(String matchId) async {
    receiptReads += 1;
    return receipt;
  }
}

Widget testApp(
  Widget child, {
  SettlementGateway? gateway,
  MediaQueryData? mediaQuery,
}) {
  final content = mediaQuery == null
      ? child
      : MediaQuery(data: mediaQuery, child: child);
  return ProviderScope(
    overrides: [
      if (gateway != null) settlementGatewayProvider.overrideWithValue(gateway),
    ],
    child: MaterialApp(theme: AppTheme.dark, home: content),
  );
}

void setPhoneViewport(WidgetTester tester, Size size) {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

void main() {
  test('server parser rejects result payloads without explicit outcome', () {
    final parsed = MatchResultViewData.tryFromServer({
      'winnerId': 'player-1',
      'payoutMinorUnits': 390000,
      'opponent': {'id': 'player-2', 'username': 'KingMoves'},
    });

    expect(parsed, isNull);
  });

  test('server parser accepts explicit result and preserves exact amounts', () {
    final parsed = MatchResultViewData.tryFromServer({
      'result': {
        'kind': 'victory',
        'matchId': 'DB241567',
        'reason': 'Server confirmed capture win',
        'opponent': {'id': 'player-2', 'username': 'KingMoves'},
        'terms': {
          'stakeMinorUnits': 200000,
          'opponentStakeMinorUnits': 200000,
          'platformFeeMinorUnits': 12345,
          'totalPotMinorUnits': 400000,
        },
        'settlement': {
          'status': 'complete',
          'payoutMinorUnits': 376543,
          'reference': 'SET-1',
        },
      },
    });

    expect(parsed, isNotNull);
    expect(parsed!.serverVerified, isTrue);
    expect(parsed.payoutMinorUnits, 376543);
    expect(parsed.terms!.platformFeeMinorUnits, 12345);
  });

  test(
    'active backend settlement and receipt reads stay unavailable',
    () async {
      const gateway = SettlementGateway();

      expect(await gateway.fetchStatus('DB241567'), isNull);
      expect(await gateway.fetchReceipt('DB241567'), isNull);
    },
  );

  test('active match_ended payload maps only server-supplied money', () {
    final winner = MatchResultViewData.tryFromActiveMatchEnded(
      {'winnerId': 'player-1', 'reason': 'NO_LEGAL_MOVES', 'payout': '376543'},
      matchId: 'DB241567',
      currentUserId: 'player-1',
      opponentId: 'player-2',
    );
    final loser = MatchResultViewData.tryFromActiveMatchEnded(
      {'winnerId': 'player-1', 'reason': 'NO_LEGAL_MOVES', 'payout': '376543'},
      matchId: 'DB241567',
      currentUserId: 'player-2',
      opponentId: 'player-1',
    );

    expect(winner?.kind, ResultKind.victory);
    expect(winner?.settlement, SettlementPhase.confirmed);
    expect(winner?.payoutMinorUnits, 376543);
    expect(loser?.kind, ResultKind.defeat);
    expect(loser?.payoutMinorUnits, isNull);
  });

  for (final entry in <ResultKind, String>{
    ResultKind.victory: 'VICTORY',
    ResultKind.defeat: 'DEFEAT',
    ResultKind.draw: 'DRAW',
    ResultKind.timeout: 'TIMEOUT',
    ResultKind.resignation: 'VICTORY BY RESIGNATION',
    ResultKind.disconnectForfeit: 'VICTORY BY FORFEIT',
    ResultKind.cancelled: 'MATCH CANCELLED',
  }.entries) {
    testWidgets('renders authoritative ${entry.key.name} result', (
      tester,
    ) async {
      setPhoneViewport(tester, const Size(412, 915));
      await tester.pumpWidget(
        testApp(
          MatchResultScreen(
            result: settlementResult(entry.key),
            autoRefresh: false,
          ),
        ),
      );
      await tester.pump();

      expect(find.text(entry.value), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  }

  for (final entry in <SettlementPhase, String>{
    SettlementPhase.pending: 'SETTLEMENT PROCESSING',
    SettlementPhase.confirmed: 'SETTLEMENT COMPLETE',
    SettlementPhase.delayed: 'SETTLEMENT DELAYED',
  }.entries) {
    testWidgets('renders ${entry.key.name} settlement state', (tester) async {
      setPhoneViewport(tester, const Size(412, 915));
      await tester.pumpWidget(
        testApp(
          SettlementStatusScreen(
            result: settlementResult(ResultKind.victory, phase: entry.key),
            phase: entry.key,
            autoRefresh: false,
          ),
        ),
      );
      await tester.pump();

      expect(find.text(entry.value), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('receipt renders only supplied authoritative values', (
    tester,
  ) async {
    setPhoneViewport(tester, const Size(412, 915));
    await tester.pumpWidget(
      testApp(
        MatchReceiptScreen(
          matchId: settlementReceipt.matchId,
          initialReceipt: settlementReceipt,
          autoLoad: false,
        ),
      ),
    );
    await tester.pump();

    expect(find.text('MATCH RECEIPT'), findsOneWidget);
    expect(find.text('RCP-241567'), findsOneWidget);
    expect(find.text('₦3,900'), findsWidgets);
    expect(tester.takeException(), isNull);
  });

  testWidgets('safe refresh reads status and navigates to receipt', (
    tester,
  ) async {
    setPhoneViewport(tester, const Size(412, 915));
    final complete = settlementResult(ResultKind.victory);
    final gateway = FixtureSettlementGateway(
      result: complete,
      receipt: settlementReceipt,
    );
    final router = GoRouter(
      initialLocation: '/status',
      routes: [
        GoRoute(
          path: '/status',
          builder: (context, state) => SettlementStatusScreen(
            result: settlementResult(
              ResultKind.victory,
              phase: SettlementPhase.delayed,
            ),
            phase: SettlementPhase.delayed,
            autoRefresh: false,
          ),
        ),
        GoRoute(
          path: '/matches/:id/receipt',
          builder: (context, state) =>
              MatchReceiptScreen(matchId: state.pathParameters['id']!),
        ),
      ],
    );
    await tester.pumpWidget(
      ProviderScope(
        overrides: [settlementGatewayProvider.overrideWithValue(gateway)],
        child: MaterialApp.router(theme: AppTheme.dark, routerConfig: router),
      ),
    );
    await tester.pump();
    await tester.tap(find.text('Check status'));
    await tester.pumpAndSettle();

    expect(gateway.statusReads, 1);
    expect(find.text('SETTLEMENT COMPLETE'), findsOneWidget);
    await tester.tap(find.text('View receipt'));
    await tester.pumpAndSettle();
    expect(gateway.receiptReads, 1);
    expect(find.text('RCP-241567'), findsOneWidget);
  });

  testWidgets('missing verification hides every financial amount', (
    tester,
  ) async {
    const unverified = MatchResultViewData(
      kind: ResultKind.victory,
      opponent: settlementOpponent,
      terms: settlementTerms,
      payoutMinorUnits: 999999,
    );
    await tester.pumpWidget(
      testApp(const MatchResultScreen(result: unverified, autoRefresh: false)),
    );
    await tester.pump();

    expect(
      find.textContaining('Verified result details are unavailable'),
      findsOneWidget,
    );
    expect(find.textContaining('₦'), findsNothing);
  });

  testWidgets('Flutter does not calculate payout from total pot', (
    tester,
  ) async {
    final result = settlementResult(ResultKind.victory).copyWith();
    final withoutPayout = MatchResultViewData(
      kind: result.kind,
      opponent: result.opponent,
      terms: result.terms,
      matchId: result.matchId,
      reason: result.reason,
      settlement: SettlementPhase.confirmed,
      serverVerified: true,
    );
    await tester.pumpWidget(
      testApp(MatchResultScreen(result: withoutPayout, autoRefresh: false)),
    );
    await tester.pump();

    expect(find.text('Payout'), findsNothing);
    expect(find.text('Total pot'), findsOneWidget);
  });

  testWidgets('share result excludes financial and private references', (
    tester,
  ) async {
    final result = settlementResult(ResultKind.victory);
    final shareText = result.privacySafeShareText();
    expect(shareText, isNot(contains('₦')));
    expect(shareText, isNot(contains('SET-')));
    expect(shareText, isNot(contains('RCP-')));
    expect(shareText, isNot(contains('DB241567')));

    await tester.pumpWidget(testApp(ShareResultSheet(shareText: shareText)));
    await tester.pump();
    expect(find.text(shareText), findsOneWidget);
    expect(find.textContaining('Payout'), findsNothing);
    expect(find.textContaining('ledger'), findsNothing);
  });

  testWidgets('result layout stays overflow-free on a small scaled phone', (
    tester,
  ) async {
    setPhoneViewport(tester, const Size(320, 568));
    await tester.pumpWidget(
      testApp(
        MatchResultScreen(
          result: settlementResult(ResultKind.resignation),
          autoRefresh: false,
        ),
        mediaQuery: const MediaQueryData(
          size: Size(320, 568),
          textScaler: TextScaler.linear(1.25),
        ),
      ),
    );
    await tester.pump();

    expect(tester.takeException(), isNull);
    expect(find.text('VICTORY BY RESIGNATION'), findsOneWidget);
  });
}
