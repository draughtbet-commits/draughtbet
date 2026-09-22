import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
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
import 'package:draughts_arena/services/match_flow_gateway.dart';
import 'package:draughts_arena/services/socket_service.dart';
import 'package:draughts_arena/theme/app_theme.dart';
import 'package:draughts_arena/widgets/draught_board.dart';
import 'package:draughts_arena/widgets/main_layout.dart';

const player = UserProfile(
  id: 'player-1',
  username: 'Wisdom',
  avatar: 'avatar_01',
  tier: 'MASTER',
  walletBalanceMinorUnits: 3245000,
);

const opponent = MatchPlayer(
  id: 'player-2',
  name: 'KingMoves',
  avatarId: 'avatar_04',
  rank: 'MASTER',
  rating: 1780,
  winRate: 71,
);

const referenceTerms = MatchTerms(
  stakeMinorUnits: 200000,
  opponentStakeMinorUnits: 200000,
  platformFeeMinorUnits: 10000,
  totalPrizeMinorUnits: 390000,
  serverQuoted: true,
);

class StaticProfileNotifier extends ProfileNotifier {
  StaticProfileNotifier() : super(Dio()) {
    state = const ProfileState(profile: player);
  }

  @override
  Future<void> load() async {}
}

class FixtureGateway extends MatchFlowGateway {
  FixtureGateway() : super(Dio());

  @override
  Future<List<OpenMatch>> loadOpenMatches() async => const [];
}

class StaticFlowNotifier extends MatchFlowNotifier {
  StaticFlowNotifier(MatchFlowState initial) : super(FixtureGateway()) {
    state = initial;
  }

  @override
  Future<void> loadArena() async {}
}

class NavigationFlowNotifier extends MatchFlowNotifier {
  NavigationFlowNotifier(MatchFlowState initial) : super(FixtureGateway()) {
    state = initial;
  }

  @override
  Future<void> loadArena() async {}

  @override
  Future<String?> confirm() async {
    if (state.actionPhase == MatchActionPhase.submitting ||
        state.currentIntent == null) {
      return null;
    }
    final kind = state.currentIntent!.kind;
    final id = kind == MatchEntryKind.created ? null : 'match-123';
    state = state.copyWith(
      actionPhase: MatchActionPhase.succeeded,
      searchPhase: kind == MatchEntryKind.created
          ? SearchPhase.searching
          : SearchPhase.found,
      currentMatchId: id,
    );
    return id;
  }
}

class SilentSocketService extends SocketService {
  @override
  Stream<Map<String, dynamic>> get onMatchFound => const Stream.empty();
  @override
  Stream<Map<String, dynamic>> get onGameState => const Stream.empty();
  @override
  Stream<Map<String, dynamic>> get onMoveApplied => const Stream.empty();
  @override
  Stream<Map<String, dynamic>> get onMoveRejected => const Stream.empty();
  @override
  Stream<Map<String, dynamic>> get onCalloutCreated => const Stream.empty();
  @override
  Stream<Map<String, dynamic>> get onOpponentDisconnected =>
      const Stream.empty();
  @override
  Stream<Map<String, dynamic>> get onOpponentReconnected =>
      const Stream.empty();
  @override
  Stream<Map<String, dynamic>> get onMatchEndedResign => const Stream.empty();
  @override
  Stream<Map<String, dynamic>> get onMatchEnded => const Stream.empty();
  @override
  void joinMatch(String matchId) {}
  @override
  void attemptMove(String matchId, int from, int to) {}
}

class StaticMatchNotifier extends MatchNotifier {
  StaticMatchNotifier(MatchState initial)
    : super(SilentSocketService(), Dio()) {
    state = initial;
  }

  @override
  Future<void> fetchGameState(String matchId) async {}

  @override
  void joinMatch(String matchId) {}
}

class StaticNotificationNotifier extends NotificationNotifier {
  StaticNotificationNotifier()
    : super(Dio(), SilentSocketService(), initialize: false) {
    state = NotificationState(
      notifications: const [],
      unreadCount: 0,
      isLoading: false,
    );
  }
}

GameState gameFixture({
  String turn = 'WHITE',
  List<LegalMove> legalMoves = const [LegalMove(from: 31, to: 26)],
  String status = 'in_progress',
  String? winnerId,
}) {
  final board = List<int>.filled(50, 0);
  for (var square = 1; square <= 20; square++) {
    board[square - 1] = -1;
  }
  for (var square = 31; square <= 50; square++) {
    board[square - 1] = 1;
  }
  return GameState(
    board: board,
    currentTurn: turn,
    player1: 'player-1',
    player2: 'player-2',
    status: status,
    moveCount: 0,
    consecutiveKingMoves: 0,
    winnerId: winnerId,
    legalMoves: legalMoves,
  );
}

Widget appFor(
  Widget child, {
  MatchFlowState flow = const MatchFlowState(),
  MatchState? match,
}) {
  return ProviderScope(
    overrides: [
      profileProvider.overrideWith((ref) => StaticProfileNotifier()),
      matchFlowProvider.overrideWith((ref) => StaticFlowNotifier(flow)),
      matchProvider.overrideWith(
        (ref) => StaticMatchNotifier(match ?? const MatchState()),
      ),
      notificationProvider.overrideWith((ref) => StaticNotificationNotifier()),
    ],
    child: MaterialApp(theme: AppTheme.dark, home: child),
  );
}

Widget navigationApp({
  required String initialLocation,
  MatchFlowState flow = const MatchFlowState(),
  MatchState? match,
  MatchResultViewData? result,
  bool renderGameplay = false,
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
            builder: (context, state) => const Scaffold(body: Text('Wallet')),
          ),
          GoRoute(
            path: '/profile',
            builder: (context, state) => const Scaffold(body: Text('Profile')),
          ),
        ],
      ),
      GoRoute(
        path: '/play/create',
        builder: (context, state) => const CreateMatchScreen(),
      ),
      GoRoute(
        path: '/play/confirm',
        builder: (context, state) => const MatchConfirmationScreen(),
      ),
      GoRoute(
        path: '/play/search',
        builder: (context, state) => const MatchmakingScreen(),
      ),
      GoRoute(
        path: '/play/room/:id',
        builder: (context, state) =>
            MatchRoomScreen(matchId: state.pathParameters['id']!),
      ),
      GoRoute(
        path: '/match/:id',
        builder: (context, state) => renderGameplay
            ? MatchScreen(matchId: state.pathParameters['id']!)
            : const Scaffold(body: Center(child: Text('Gameplay destination'))),
      ),
      GoRoute(
        path: '/play/result',
        builder: (context, state) =>
            MatchResultScreen(result: state.extra! as MatchResultViewData),
      ),
      GoRoute(
        path: '/result',
        builder: (context, state) => MatchResultScreen(result: result!),
      ),
    ],
  );
  return ProviderScope(
    overrides: [
      profileProvider.overrideWith((ref) => StaticProfileNotifier()),
      matchFlowProvider.overrideWith((ref) => NavigationFlowNotifier(flow)),
      matchProvider.overrideWith(
        (ref) => StaticMatchNotifier(match ?? const MatchState()),
      ),
      notificationProvider.overrideWith((ref) => StaticNotificationNotifier()),
    ],
    child: MaterialApp.router(theme: AppTheme.dark, routerConfig: router),
  );
}

void usePhoneViewport(WidgetTester tester) {
  tester.view.physicalSize = const Size(390, 844);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

void invokeButton(WidgetTester tester, String label) {
  final finder = find.ancestor(
    of: find.text(label),
    matching: find.byWidgetPredicate((widget) => widget is ButtonStyleButton),
  );
  expect(finder, findsOneWidget);
  final button = tester.widget<ButtonStyleButton>(finder);
  expect(button.onPressed, isNotNull);
  button.onPressed!();
}

void main() {
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

  testWidgets('Home mirrors approved lobby hierarchy and quick stakes', (
    tester,
  ) async {
    await tester.pumpWidget(
      appFor(
        const HomeLobbyScreen(),
        match: MatchState(
          currentMatchId: 'match-123',
          gameState: gameFixture(),
        ),
      ),
    );
    await tester.pump();
    expect(find.text('FIND A MATCH'), findsOneWidget);
    expect(find.text('Quick Match'), findsOneWidget);
    expect(find.text('₦2K'), findsOneWidget);
    expect(find.text('MATCH IN PROGRESS'), findsOneWidget);
  });

  testWidgets('Arena renders approved open-match card content', (tester) async {
    const open = OpenMatch(
      id: 'callout-1',
      host: opponent,
      terms: referenceTerms,
    );
    await tester.pumpWidget(
      appFor(
        const ArenaScreen(),
        flow: const MatchFlowState(
          arenaPhase: LoadPhase.ready,
          openMatches: [open],
        ),
      ),
    );
    await tester.pump();
    expect(find.text('Open Arena'), findsOneWidget);
    expect(find.text('KingMoves'), findsOneWidget);
    expect(find.text('JOIN'), findsOneWidget);
  });

  testWidgets('Create Match exposes required server-backed fields', (
    tester,
  ) async {
    await tester.pumpWidget(appFor(const CreateMatchScreen()));
    expect(find.text('Create Match'), findsOneWidget);
    expect(find.text('Stake Amount'), findsOneWidget);
    expect(find.text('Time Control'), findsOneWidget);
    expect(find.text('Game Type'), findsOneWidget);
    expect(find.text('Who can join?'), findsOneWidget);
  });

  testWidgets('Confirmation shows quote and prevents ambiguous fee display', (
    tester,
  ) async {
    const intent = MatchFlowIntent(
      kind: MatchEntryKind.openMatch,
      terms: referenceTerms,
      openMatchId: 'callout-1',
      opponent: opponent,
    );
    await tester.pumpWidget(
      appFor(
        const MatchConfirmationScreen(),
        flow: const MatchFlowState(currentIntent: intent),
      ),
    );
    expect(find.text('Match Confirmation'), findsOneWidget);
    expect(find.text('Confirm & Lock Stake'), findsOneWidget);
    expect(find.text('Total prize'), findsOneWidget);
  });

  testWidgets('Matchmaking renders searching and found states', (tester) async {
    const intent = MatchFlowIntent(
      kind: MatchEntryKind.quick,
      terms: referenceTerms,
      opponent: opponent,
    );
    await tester.pumpWidget(
      appFor(
        const MatchmakingScreen(),
        flow: const MatchFlowState(
          currentIntent: intent,
          searchPhase: SearchPhase.searching,
        ),
      ),
    );
    expect(find.text('Finding your opponent...'), findsOneWidget);
    expect(find.text('Cancel Search'), findsOneWidget);
  });

  testWidgets('Matchmaking timeout has retry and Home recovery actions', (
    tester,
  ) async {
    const intent = MatchFlowIntent(
      kind: MatchEntryKind.quick,
      terms: referenceTerms,
    );
    await tester.pumpWidget(
      appFor(
        const MatchmakingScreen(),
        flow: const MatchFlowState(
          currentIntent: intent,
          searchPhase: SearchPhase.timeout,
        ),
      ),
    );
    expect(find.text('No opponent found'), findsOneWidget);
    expect(find.text('Try Again'), findsOneWidget);
    expect(find.text('Back to Home'), findsOneWidget);
  });

  testWidgets('Match Room waits for canonical state before entry', (
    tester,
  ) async {
    const intent = MatchFlowIntent(
      kind: MatchEntryKind.openMatch,
      terms: referenceTerms,
      opponent: opponent,
    );
    await tester.pumpWidget(
      appFor(
        const MatchRoomScreen(matchId: 'match-123'),
        flow: const MatchFlowState(currentIntent: intent),
        match: MatchState(gameState: gameFixture()),
      ),
    );
    expect(find.text('Canonical match state received'), findsOneWidget);
    expect(find.text('Enter Match'), findsOneWidget);
  });

  testWidgets('Gameplay exposes board, legal move semantics and action rail', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    await tester.pumpWidget(
      appFor(
        const MatchScreen(matchId: 'match-123'),
        match: MatchState(
          currentMatchId: 'match-123',
          gameState: gameFixture(),
        ),
      ),
    );
    await tester.pump();
    expect(find.byType(CustomPaint), findsWidgets);
    expect(find.text('Resign'), findsOneWidget);
    expect(find.text('Offer Draw'), findsOneWidget);
    expect(
      find.bySemanticsLabel(RegExp('International draughts board')),
      findsOneWidget,
    );
    semantics.dispose();
  });

  testWidgets('Gameplay renders selected multi-capture and flying-king path', (
    tester,
  ) async {
    final game = gameFixture(
      legalMoves: const [
        LegalMove(from: 31, to: 13, capturedSquares: [27, 18]),
      ],
    );
    await tester.pumpWidget(
      appFor(
        const MatchScreen(matchId: 'match-123'),
        match: MatchState(currentMatchId: 'match-123', gameState: game),
      ),
    );
    await tester.pump();
    final board = find.bySemanticsLabel(RegExp('International draughts board'));
    final size = tester.getSize(board).width / 10;
    await tester.tapAt(
      tester.getTopLeft(board) + Offset(size * 1.5, size * 6.5),
    );
    await tester.pump(const Duration(milliseconds: 160));
    expect(find.text('Capture path selected'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp('Move to square 13')), findsOneWidget);
  });

  testWidgets('Gameplay renders authoritative king promotion', (tester) async {
    await tester.pumpWidget(
      appFor(
        const MatchScreen(matchId: 'match-123'),
        match: MatchState(
          currentMatchId: 'match-123',
          gameState: gameFixture(),
          promotionVisible: true,
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 260));
    expect(find.text('KING PROMOTION!'), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 1000));
  });

  testWidgets('Gameplay freezes input for opponent turn and resync', (
    tester,
  ) async {
    await tester.pumpWidget(
      appFor(
        const MatchScreen(matchId: 'match-123'),
        match: MatchState(
          currentMatchId: 'match-123',
          gameState: gameFixture(turn: 'BLACK'),
          syncState: MatchSyncState.syncing,
          opponentConnected: false,
          rejectionReason: 'STATE_VERSION_CONFLICT',
        ),
      ),
    );
    await tester.pump();
    expect(
      find.text('Opponent disconnected · waiting for reconnect'),
      findsOneWidget,
    );
    expect(find.text('State refreshed'), findsOneWidget);
    expect(find.text('Opponent’s turn'), findsOneWidget);
    expect(find.text('OPPONENT DISCONNECTED'), findsOneWidget);
    expect(find.text('60'), findsOneWidget);
  });

  testWidgets('Gameplay uses approved draw and resign confirmations', (
    tester,
  ) async {
    await tester.pumpWidget(
      appFor(
        const MatchScreen(matchId: 'match-123'),
        match: MatchState(
          currentMatchId: 'match-123',
          gameState: gameFixture(),
        ),
      ),
    );
    await tester.pump();

    await tester.tap(find.text('Offer Draw'));
    await tester.pumpAndSettle();
    expect(find.text('OFFER A DRAW'), findsOneWidget);
    expect(find.text('Offer draw'), findsOneWidget);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Resign'));
    await tester.pumpAndSettle();
    expect(find.text('RESIGN MATCH?'), findsOneWidget);
    expect(find.text('Confirm resignation'), findsOneWidget);
  });

  testWidgets('Gameplay holds terminal board until settlement event', (
    tester,
  ) async {
    await tester.pumpWidget(
      appFor(
        const MatchScreen(matchId: 'match-123'),
        match: MatchState(
          currentMatchId: 'match-123',
          gameState: gameFixture(status: 'settling'),
        ),
      ),
    );
    await tester.pump();
    expect(find.text('SETTLEMENT PROCESSING'), findsOneWidget);
    expect(find.text('VICTORY'), findsNothing);
  });

  testWidgets('Gameplay routes authoritative terminal state to result', (
    tester,
  ) async {
    await tester.pumpWidget(
      navigationApp(
        initialLocation: '/match/match-123',
        renderGameplay: true,
        match: MatchState(
          currentMatchId: 'match-123',
          gameState: gameFixture(status: 'completed', winnerId: 'player-1'),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 100));
    await tester.pump(const Duration(milliseconds: 100));
    await tester.pump();
    expect(find.text('VICTORY'), findsOneWidget);
  });

  testWidgets('Victory and defeat keep result separate from settlement', (
    tester,
  ) async {
    for (final kind in [ResultKind.victory, ResultKind.defeat]) {
      await tester.pumpWidget(
        appFor(
          MatchResultScreen(
            result: MatchResultViewData(
              kind: kind,
              opponent: opponent,
              terms: referenceTerms,
              settlement: SettlementPhase.pending,
            ),
          ),
        ),
      );
      expect(
        find.text(kind == ResultKind.victory ? 'VICTORY' : 'DEFEAT'),
        findsOneWidget,
      );
      expect(find.text('Settlement processing'), findsOneWidget);
    }
  });

  testWidgets('Home has no overflow at 320 by 568', (tester) async {
    tester.view.physicalSize = const Size(320, 568);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(appFor(const HomeLobbyScreen()));
    await tester.pump();
    expect(tester.takeException(), isNull);
  });

  testWidgets('Create Match remains usable at 360 wide with scaled text', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(360, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      appFor(
        const MediaQuery(
          data: MediaQueryData(textScaler: TextScaler.linear(1.4)),
          child: CreateMatchScreen(),
        ),
      ),
    );
    await tester.pump();
    expect(tester.takeException(), isNull);
    expect(find.text('Review Match'), findsOneWidget);
  });

  testWidgets('Gameplay remains centered without overflow at tablet width', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(600, 960);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      appFor(
        const MatchScreen(matchId: 'match-123'),
        match: MatchState(
          currentMatchId: 'match-123',
          gameState: gameFixture(),
        ),
      ),
    );
    await tester.pump();
    expect(tester.takeException(), isNull);
    expect(
      tester.getSize(find.byType(DraughtBoard)).width,
      lessThanOrEqualTo(560),
    );
  });

  testWidgets('Flow A navigates quick match from Home into gameplay', (
    tester,
  ) async {
    usePhoneViewport(tester);
    await tester.pumpWidget(
      navigationApp(
        initialLocation: '/home',
        match: MatchState(gameState: gameFixture()),
      ),
    );
    await tester.pumpAndSettle();
    invokeButton(tester, 'Find Opponent');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    final container = ProviderScope.containerOf(
      tester.element(find.byType(HomeLobbyScreen)),
    );
    expect(
      container.read(matchFlowProvider).actionPhase,
      MatchActionPhase.succeeded,
    );
    expect(find.text('Opponent found'), findsOneWidget);
    invokeButton(tester, 'Continue to Match Room');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('Canonical match state received'), findsOneWidget);
    invokeButton(tester, 'Enter Match');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('Gameplay destination'), findsOneWidget);
  });

  testWidgets('Flow B navigates Arena join through confirmation and room', (
    tester,
  ) async {
    usePhoneViewport(tester);
    const open = OpenMatch(
      id: 'callout-1',
      host: opponent,
      terms: referenceTerms,
    );
    await tester.pumpWidget(
      navigationApp(
        initialLocation: '/arena',
        flow: const MatchFlowState(
          arenaPhase: LoadPhase.ready,
          openMatches: [open],
        ),
        match: MatchState(gameState: gameFixture()),
      ),
    );
    await tester.pumpAndSettle();
    invokeButton(tester, 'JOIN');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('Match Confirmation'), findsOneWidget);
    invokeButton(tester, 'Confirm & Lock Stake');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('Enter Match'), findsOneWidget);
  });

  testWidgets('Flow C raised Play action creates and reviews a match', (
    tester,
  ) async {
    usePhoneViewport(tester);
    await tester.pumpWidget(navigationApp(initialLocation: '/home'));
    await tester.pumpAndSettle();
    tester.widget<BottomNavigationBar>(find.byType(BottomNavigationBar)).onTap!(
      2,
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('Create Match'), findsOneWidget);
    invokeButton(tester, 'Review Match');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('Confirm & Create Match'), findsOneWidget);
    invokeButton(tester, 'Confirm & Create Match');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('Finding your opponent...'), findsOneWidget);
  });

  testWidgets('Flow D resumes the pinned active match', (tester) async {
    usePhoneViewport(tester);
    await tester.pumpWidget(
      navigationApp(
        initialLocation: '/home',
        match: MatchState(
          currentMatchId: 'match-123',
          gameState: gameFixture(),
        ),
      ),
    );
    await tester.pumpAndSettle();
    invokeButton(tester, 'Return to Match');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('Gameplay destination'), findsOneWidget);
  });

  testWidgets('Flow E delayed settlement keeps a route back to Home', (
    tester,
  ) async {
    usePhoneViewport(tester);
    const result = MatchResultViewData(
      kind: ResultKind.victory,
      opponent: opponent,
      terms: referenceTerms,
      settlement: SettlementPhase.delayed,
      receiptReference: 'DB-123',
    );
    await tester.pumpWidget(
      navigationApp(initialLocation: '/result', result: result),
    );
    expect(
      find.text('Settlement delayed — your result is safe'),
      findsOneWidget,
    );
    invokeButton(tester, 'Back to Home');
    await tester.pumpAndSettle();
    expect(find.text('FIND A MATCH'), findsOneWidget);
  });
}
