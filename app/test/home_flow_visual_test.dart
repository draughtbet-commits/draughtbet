import 'package:draughts_arena/models/game_state.dart';
import 'package:draughts_arena/models/match_flow.dart';
import 'package:draughts_arena/providers/match_flow_provider.dart';
import 'package:draughts_arena/providers/match_provider.dart';
import 'package:draughts_arena/providers/notification_provider.dart';
import 'package:draughts_arena/providers/profile_provider.dart';
import 'package:draughts_arena/screens/arena_screen.dart';
import 'package:draughts_arena/screens/create_match_screen.dart';
import 'package:draughts_arena/screens/home_lobby_screen.dart';
import 'package:draughts_arena/screens/match_confirmation_screen.dart';
import 'package:draughts_arena/screens/match_result_screen.dart';
import 'package:draughts_arena/screens/match_room_screen.dart';
import 'package:draughts_arena/screens/match_screen.dart';
import 'package:draughts_arena/screens/matchmaking_screen.dart';
import 'package:draughts_arena/theme/app_theme.dart';
import 'package:draughts_arena/widgets/draught_board.dart';
import 'package:draughts_arena/widgets/main_layout.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'home_flow_screens_test.dart' as fixtures;

const _captureKey = ValueKey('home-flow-capture');

void _setViewport(WidgetTester tester) {
  tester.view.physicalSize = const Size(390, 844);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

Widget _captureApp(
  Widget child, {
  MatchFlowState flow = const MatchFlowState(),
  MatchState? match,
}) {
  return ProviderScope(
    overrides: [
      profileProvider.overrideWith((ref) => fixtures.StaticProfileNotifier()),
      matchFlowProvider.overrideWith(
        (ref) => fixtures.StaticFlowNotifier(flow),
      ),
      matchProvider.overrideWith(
        (ref) => fixtures.StaticMatchNotifier(match ?? const MatchState()),
      ),
      notificationProvider.overrideWith(
        (ref) => fixtures.StaticNotificationNotifier(),
      ),
    ],
    child: MaterialApp(
      theme: AppTheme.dark,
      home: RepaintBoundary(key: _captureKey, child: child),
    ),
  );
}

Widget _captureShellApp({
  required String initialLocation,
  required MatchFlowState flow,
  MatchState? match,
}) {
  final router = GoRouter(
    initialLocation: initialLocation,
    routes: [
      ShellRoute(
        builder: (context, state, child) => MainLayout(child: child),
        routes: [
          GoRoute(
            path: '/home',
            builder: (context, state) => const HomeLobbyScreen(),
          ),
          GoRoute(
            path: '/arena',
            builder: (context, state) => const ArenaScreen(),
          ),
          GoRoute(
            path: '/wallet',
            builder: (context, state) => const SizedBox.shrink(),
          ),
          GoRoute(
            path: '/profile',
            builder: (context, state) => const SizedBox.shrink(),
          ),
        ],
      ),
      GoRoute(
        path: '/play/create',
        builder: (context, state) => const CreateMatchScreen(),
      ),
      GoRoute(
        path: '/match/:id',
        builder: (context, state) =>
            MatchScreen(matchId: state.pathParameters['id']!),
      ),
    ],
  );
  return ProviderScope(
    overrides: [
      profileProvider.overrideWith((ref) => fixtures.StaticProfileNotifier()),
      matchFlowProvider.overrideWith(
        (ref) => fixtures.StaticFlowNotifier(flow),
      ),
      matchProvider.overrideWith(
        (ref) => fixtures.StaticMatchNotifier(match ?? const MatchState()),
      ),
      notificationProvider.overrideWith(
        (ref) => fixtures.StaticNotificationNotifier(),
      ),
    ],
    child: MaterialApp.router(
      theme: AppTheme.dark,
      routerConfig: router,
      builder: (context, child) => RepaintBoundary(
        key: _captureKey,
        child: child ?? const SizedBox.shrink(),
      ),
    ),
  );
}

Future<void> _settleCapture(WidgetTester tester, String name) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 180));
  expect(tester.takeException(), isNull);
  await expectLater(
    find.byKey(_captureKey),
    matchesGoldenFile('goldens/home_flow/$name.png'),
  );
}

void main() {
  setUpAll(() async {
    final inter = FontLoader('Inter')
      ..addFont(rootBundle.load('assets/fonts/Inter-Variable.ttf'));
    final sora = FontLoader('Sora')
      ..addFont(rootBundle.load('assets/fonts/Sora-Variable.ttf'));
    final lucide = FontLoader('packages/lucide_icons_flutter/Lucide')
      ..addFont(
        rootBundle.load('packages/lucide_icons_flutter/assets/lucide.ttf'),
      );
    await Future.wait([inter.load(), sora.load(), lucide.load()]);
  });

  setUp(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('plugins.it_nomads.com/flutter_secure_storage'),
          (call) async => call.method == 'read' ? 'player-1' : null,
        );
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('dev.fluttercommunity.plus/connectivity_status'),
          (call) async => null,
        );
  });

  testWidgets('capture 06 Home Lobby', (tester) async {
    _setViewport(tester);
    await tester.pumpWidget(
      _captureShellApp(
        initialLocation: '/home',
        flow: const MatchFlowState(arenaPhase: LoadPhase.ready),
        match: MatchState(
          currentMatchId: 'match-123',
          gameState: fixtures.gameFixture(),
        ),
      ),
    );
    await _settleCapture(tester, '06_home_lobby');
  });

  testWidgets('capture 07 Open Arena', (tester) async {
    _setViewport(tester);
    const openMatches = [
      OpenMatch(
        id: 'callout-1',
        host: fixtures.opponent,
        terms: fixtures.referenceTerms,
      ),
      OpenMatch(
        id: 'callout-2',
        host: MatchPlayer(
          id: 'player-3',
          name: 'QueenBee',
          avatarId: 'avatar_07',
          rank: 'PRO',
          rating: 1620,
          winRate: 65,
        ),
        terms: MatchTerms(
          stakeMinorUnits: 100000,
          timeControl: '10 minutes',
          gameType: 'Classic',
        ),
      ),
      OpenMatch(
        id: 'callout-3',
        host: MatchPlayer(
          id: 'player-4',
          name: 'BlackKing',
          avatarId: 'avatar_10',
          rank: 'AMATEUR',
          rating: 980,
          winRate: 52,
        ),
        terms: MatchTerms(
          stakeMinorUnits: 50000,
          timeControl: '5 minutes',
          gameType: 'Classic',
        ),
      ),
      OpenMatch(
        id: 'callout-4',
        host: MatchPlayer(
          id: 'player-5',
          name: 'SharpMind',
          avatarId: 'avatar_11',
          rank: 'PRO',
          rating: 1730,
          winRate: 68,
        ),
        terms: MatchTerms(
          stakeMinorUnits: 200000,
          timeControl: '10 minutes',
          gameType: 'Classic',
        ),
      ),
    ];
    await tester.pumpWidget(
      _captureShellApp(
        initialLocation: '/arena',
        flow: const MatchFlowState(
          arenaPhase: LoadPhase.ready,
          openMatches: openMatches,
        ),
      ),
    );
    await _settleCapture(tester, '07_open_arena');
  });

  testWidgets('capture 08 Create Match', (tester) async {
    _setViewport(tester);
    await tester.pumpWidget(_captureApp(const CreateMatchScreen()));
    await _settleCapture(tester, '08_create_match');
  });

  testWidgets('capture 09 Match Confirmation', (tester) async {
    _setViewport(tester);
    const intent = MatchFlowIntent(
      kind: MatchEntryKind.openMatch,
      terms: fixtures.referenceTerms,
      openMatchId: 'callout-1',
      opponent: fixtures.opponent,
    );
    await tester.pumpWidget(
      _captureApp(
        const MatchConfirmationScreen(),
        flow: const MatchFlowState(currentIntent: intent),
      ),
    );
    await _settleCapture(tester, '09_match_confirmation');
  });

  testWidgets('capture 10 Matchmaking', (tester) async {
    _setViewport(tester);
    const intent = MatchFlowIntent(
      kind: MatchEntryKind.quick,
      terms: fixtures.referenceTerms,
    );
    await tester.pumpWidget(
      _captureApp(
        const MatchmakingScreen(),
        flow: const MatchFlowState(
          currentIntent: intent,
          searchPhase: SearchPhase.searching,
        ),
      ),
    );
    await _settleCapture(tester, '10_matchmaking');
  });

  testWidgets('capture 11 Match Room', (tester) async {
    _setViewport(tester);
    const intent = MatchFlowIntent(
      kind: MatchEntryKind.openMatch,
      terms: fixtures.referenceTerms,
      opponent: fixtures.opponent,
    );
    await tester.pumpWidget(
      _captureApp(
        const MatchRoomScreen(matchId: '214567'),
        flow: const MatchFlowState(currentIntent: intent),
        match: MatchState(gameState: fixtures.gameFixture()),
      ),
    );
    await _settleCapture(tester, '11_match_room');
  });

  testWidgets('capture 12 Live Gameplay', (tester) async {
    _setViewport(tester);
    await tester.pumpWidget(
      _captureApp(
        const MatchScreen(matchId: '214567'),
        match: MatchState(
          currentMatchId: '214567',
          gameState: fixtures.gameFixture(),
        ),
      ),
    );
    await _settleCapture(tester, '12_live_gameplay');
  });

  testWidgets('capture 13 Move Selection', (tester) async {
    _setViewport(tester);
    await tester.pumpWidget(
      _captureApp(
        const MatchScreen(matchId: '214567'),
        match: MatchState(
          currentMatchId: '214567',
          gameState: fixtures.gameFixture(),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 100));
    final board = find.byType(DraughtBoard);
    final square = tester.getSize(board).width / 10;
    await tester.tapAt(
      tester.getTopLeft(board) + Offset(square * 1.5, square * 6.5),
    );
    await _settleCapture(tester, '13_move_selection');
  });

  testWidgets('capture 14 Flying King Capture', (tester) async {
    _setViewport(tester);
    final game = fixtures.gameFixture(
      legalMoves: const [
        LegalMove(from: 31, to: 13, capturedSquares: [27, 18]),
      ],
    );
    await tester.pumpWidget(
      _captureApp(
        const MatchScreen(matchId: '214567'),
        match: MatchState(currentMatchId: '214567', gameState: game),
      ),
    );
    await tester.pump(const Duration(milliseconds: 100));
    final board = find.byType(DraughtBoard);
    final square = tester.getSize(board).width / 10;
    await tester.tapAt(
      tester.getTopLeft(board) + Offset(square * 1.5, square * 6.5),
    );
    await _settleCapture(tester, '14_flying_king_capture');
  });

  testWidgets('capture 15 King Promotion', (tester) async {
    _setViewport(tester);
    await tester.pumpWidget(
      _captureApp(
        const MatchScreen(matchId: '214567'),
        match: MatchState(
          currentMatchId: '214567',
          gameState: fixtures.gameFixture(),
          promotionVisible: true,
        ),
      ),
    );
    await tester.pump();
    await tester.runAsync(() async {
      await precacheImage(
        const AssetImage('assets/images/king_promotion.png'),
        tester.element(find.byType(MatchScreen)),
      );
    });
    await tester.pump(const Duration(milliseconds: 260));
    expect(find.text('KING PROMOTION!'), findsOneWidget);
    await expectLater(
      find.byKey(_captureKey),
      matchesGoldenFile('goldens/home_flow/15_king_promotion.png'),
    );
    await tester.pump(const Duration(milliseconds: 1000));
  });

  testWidgets('capture 16 Opponent Thinking', (tester) async {
    _setViewport(tester);
    await tester.pumpWidget(
      _captureApp(
        const MatchScreen(matchId: '214567'),
        match: MatchState(
          currentMatchId: '214567',
          gameState: fixtures.gameFixture(turn: 'BLACK'),
        ),
      ),
    );
    await _settleCapture(tester, '16_opponent_thinking');
  });

  testWidgets('capture 17 Victory', (tester) async {
    _setViewport(tester);
    await tester.pumpWidget(
      _captureApp(
        const MatchResultScreen(
          result: MatchResultViewData(
            kind: ResultKind.victory,
            opponent: fixtures.opponent,
            terms: fixtures.referenceTerms,
            reason: 'You defeated KingMoves',
            settlement: SettlementPhase.confirmed,
            receiptReference: 'DB-214567',
          ),
        ),
      ),
    );
    await _settleCapture(tester, '17_victory');
  });

  testWidgets('capture 18 Defeat', (tester) async {
    _setViewport(tester);
    await tester.pumpWidget(
      _captureApp(
        const MatchResultScreen(
          result: MatchResultViewData(
            kind: ResultKind.defeat,
            opponent: fixtures.opponent,
            terms: fixtures.referenceTerms,
            reason: 'Better luck next time',
            settlement: SettlementPhase.confirmed,
            receiptReference: 'DB-214567',
          ),
        ),
      ),
    );
    await _settleCapture(tester, '18_defeat');
  });

  testWidgets('capture supporting no-opponent recovery state', (tester) async {
    _setViewport(tester);
    const intent = MatchFlowIntent(
      kind: MatchEntryKind.quick,
      terms: fixtures.referenceTerms,
    );
    await tester.pumpWidget(
      _captureApp(
        const MatchmakingScreen(),
        flow: const MatchFlowState(
          currentIntent: intent,
          searchPhase: SearchPhase.timeout,
        ),
      ),
    );
    await _settleCapture(tester, '27_no_opponent_found');
  });

  testWidgets('capture supporting pre-start disconnect state', (tester) async {
    _setViewport(tester);
    const intent = MatchFlowIntent(
      kind: MatchEntryKind.openMatch,
      terms: fixtures.referenceTerms,
      opponent: fixtures.opponent,
    );
    await tester.pumpWidget(
      _captureApp(
        const MatchRoomScreen(matchId: '214567'),
        flow: const MatchFlowState(currentIntent: intent),
        match: MatchState(
          gameState: fixtures.gameFixture(),
          opponentConnected: false,
          opponentGracePeriodMs: 60000,
        ),
      ),
    );
    await _settleCapture(tester, '43_opponent_disconnected_before_start');
  });

  testWidgets('capture supporting live disconnect countdown', (tester) async {
    _setViewport(tester);
    await tester.pumpWidget(
      _captureApp(
        const MatchScreen(matchId: '214567'),
        match: MatchState(
          currentMatchId: '214567',
          gameState: fixtures.gameFixture(turn: 'BLACK'),
          opponentConnected: false,
          opponentGracePeriodMs: 60000,
        ),
      ),
    );
    await _settleCapture(tester, '82_opponent_disconnect_countdown');
  });

  testWidgets('capture supporting settlement-processing state', (tester) async {
    _setViewport(tester);
    await tester.pumpWidget(
      _captureApp(
        const MatchScreen(matchId: '214567'),
        match: MatchState(
          currentMatchId: '214567',
          gameState: fixtures.gameFixture(status: 'settling'),
        ),
      ),
    );
    await _settleCapture(tester, '88_settlement_processing');
  });

  testWidgets('capture supporting settlement-delayed result', (tester) async {
    _setViewport(tester);
    await tester.pumpWidget(
      _captureApp(
        const MatchResultScreen(
          result: MatchResultViewData(
            kind: ResultKind.victory,
            opponent: fixtures.opponent,
            terms: fixtures.referenceTerms,
            reason: 'You defeated KingMoves',
            settlement: SettlementPhase.delayed,
            receiptReference: 'DB-214567',
          ),
        ),
      ),
    );
    await _settleCapture(tester, '90_settlement_delayed');
  });
}
