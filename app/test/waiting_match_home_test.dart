import 'dart:async';

import 'package:dio/dio.dart';
import 'package:draughts_arena/models/match_flow.dart';
import 'package:draughts_arena/providers/match_flow_provider.dart';
import 'package:draughts_arena/providers/match_provider.dart';
import 'package:draughts_arena/providers/notification_provider.dart';
import 'package:draughts_arena/providers/profile_provider.dart';
import 'package:draughts_arena/screens/home_lobby_screen.dart';
import 'package:draughts_arena/screens/match_lifecycle_screens.dart';
import 'package:draughts_arena/services/match_flow_gateway.dart';
import 'package:draughts_arena/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'home_flow_screens_test.dart' as fixtures;

const waitingTerms = MatchTerms(
  stakeMinorUnits: 200000,
  timeControl: '10 minutes',
  gameType: 'Classic',
  serverQuoted: true,
);

const waitingIntent = MatchFlowIntent(
  kind: MatchEntryKind.created,
  terms: waitingTerms,
);

const waitingSnapshot = MatchLifecycleSnapshot(
  phase: MatchLifecyclePhase.waitingOpponentStake,
  terms: waitingTerms,
  matchId: 'match-wait-5678',
  playerStake: AuthoritativeProgress.confirmed,
  opponentStake: AuthoritativeProgress.pending,
);

MatchFlowState waitingFlow({
  SearchPhase searchPhase = SearchPhase.searching,
  MatchLifecycleSnapshot lifecycle = waitingSnapshot,
}) => MatchFlowState(
  arenaPhase: LoadPhase.ready,
  actionPhase: MatchActionPhase.succeeded,
  searchPhase: searchPhase,
  currentIntent: waitingIntent,
  currentMatchId: lifecycle.matchId,
  lifecycle: lifecycle,
);

class RecordingGateway extends MatchFlowGateway {
  RecordingGateway() : super(Dio());

  int leaveQueueCalls = 0;
  int cancelMatchCalls = 0;

  @override
  Future<void> leaveQueue(MatchTerms terms, {String? searchId}) async {
    leaveQueueCalls++;
  }

  @override
  Future<MatchLifecycleSnapshot?> cancelMatch(
    String matchId,
    MatchTerms fallbackTerms,
  ) async {
    cancelMatchCalls++;
    return null;
  }
}

class RecordingFlowNotifier extends MatchFlowNotifier {
  RecordingFlowNotifier(this.gateway, MatchFlowState initial) : super(gateway) {
    state = initial;
  }

  final RecordingGateway gateway;
  int cancelSearchCalls = 0;
  int refreshCalls = 0;
  bool failRefresh = false;
  Completer<MatchLifecycleSnapshot?>? refreshCompleter;

  @override
  Future<void> loadArena() async {}

  @override
  Future<bool> cancelSearch() {
    cancelSearchCalls++;
    return super.cancelSearch();
  }

  @override
  Future<MatchLifecycleSnapshot?> refreshLifecycle() async {
    refreshCalls++;
    if (failRefresh) throw StateError('authoritative status unavailable');
    final pending = refreshCompleter;
    if (pending != null) return pending.future;
    return state.lifecycle;
  }

  void setLifecycle(MatchLifecycleSnapshot snapshot) =>
      applyLifecycle(snapshot);

  void setSearchPhase(SearchPhase phase) {
    state = state.copyWith(searchPhase: phase);
  }
}

class MutableMatchNotifier extends fixtures.StaticMatchNotifier {
  MutableMatchNotifier(super.initial);

  void announceMatch(String matchId) {
    state = state.copyWith(currentMatchId: matchId);
  }

  void setOffline() {
    state = state.copyWith(
      syncState: MatchSyncState.offline,
      recoveryPhase: MatchRecoveryPhase.connectionLost,
    );
  }
}

class WaitingHarness {
  WaitingHarness({
    required this.router,
    required this.flow,
    required this.match,
    required this.app,
    required this.waitingBuilds,
  });

  final GoRouter router;
  final RecordingFlowNotifier flow;
  final MutableMatchNotifier match;
  final Widget app;
  final ValueNotifier<int> waitingBuilds;

  void dispose() {
    router.dispose();
    waitingBuilds.dispose();
  }
}

WaitingHarness waitingHarness({
  String initialLocation = '/home',
  MatchFlowState? flowState,
  MatchState matchState = const MatchState(),
  bool failRefresh = false,
  Completer<MatchLifecycleSnapshot?>? refreshCompleter,
}) {
  final gateway = RecordingGateway();
  final flow = RecordingFlowNotifier(gateway, flowState ?? waitingFlow())
    ..failRefresh = failRefresh
    ..refreshCompleter = refreshCompleter;
  final match = MutableMatchNotifier(matchState);
  final waitingBuilds = ValueNotifier<int>(0);
  final router = GoRouter(
    initialLocation: initialLocation,
    routes: [
      GoRoute(
        path: '/home',
        builder: (context, state) => const HomeLobbyScreen(),
      ),
      GoRoute(
        path: '/play/waiting-stake',
        builder: (context, state) {
          waitingBuilds.value++;
          return WaitingOpponentStakeScreen(
            snapshot: state.extra as MatchLifecycleSnapshot? ?? waitingSnapshot,
          );
        },
      ),
      GoRoute(
        path: '/play/room/:id',
        builder: (context, state) =>
            Scaffold(body: Text('Room ${state.pathParameters['id']}')),
      ),
      GoRoute(
        path: '/match/:id',
        builder: (context, state) =>
            Scaffold(body: Text('Gameplay ${state.pathParameters['id']}')),
      ),
      GoRoute(
        path: '/arena',
        builder: (context, state) => const SizedBox.shrink(),
      ),
      GoRoute(
        path: '/wallet',
        builder: (context, state) => const SizedBox.shrink(),
      ),
    ],
  );
  final app = ProviderScope(
    overrides: [
      profileProvider.overrideWith((ref) => fixtures.StaticProfileNotifier()),
      matchFlowProvider.overrideWith((ref) => flow),
      matchProvider.overrideWith((ref) => match),
      notificationProvider.overrideWith(
        (ref) => fixtures.StaticNotificationNotifier(),
      ),
    ],
    child: MaterialApp.router(theme: AppTheme.dark, routerConfig: router),
  );
  return WaitingHarness(
    router: router,
    flow: flow,
    match: match,
    app: app,
    waitingBuilds: waitingBuilds,
  );
}

void useCompactViewport(WidgetTester tester, {double textScale = 1}) {
  tester.view.physicalSize = const Size(320, 568);
  tester.view.devicePixelRatio = 1;
  tester.platformDispatcher.textScaleFactorTestValue = textScale;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
}

void main() {
  setUp(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('plugins.it_nomads.com/flutter_secure_storage'),
          (call) async => call.method == 'read' ? null : null,
        );
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('dev.fluttercommunity.plus/connectivity_status'),
          (call) async => null,
        );
  });

  testWidgets(
    'Back to Home preserves match identity without cancel or queue leave',
    (tester) async {
      final harness = waitingHarness(initialLocation: '/play/waiting-stake');
      addTearDown(harness.dispose);
      await tester.pumpWidget(harness.app);
      await tester.pumpAndSettle();

      await tester.ensureVisible(find.text('Back to Home'));
      await tester.tap(find.text('Back to Home'));
      await tester.pumpAndSettle();

      expect(find.byType(HomeLobbyScreen), findsOneWidget);
      expect(harness.flow.state.currentMatchId, 'match-wait-5678');
      expect(harness.flow.cancelSearchCalls, 0);
      expect(harness.flow.gateway.cancelMatchCalls, 0);
      expect(harness.flow.gateway.leaveQueueCalls, 0);
      expect(find.text('Waiting for opponent'), findsOneWidget);
    },
  );

  testWidgets('Android back returns Home without changing lifecycle state', (
    tester,
  ) async {
    final harness = waitingHarness(initialLocation: '/play/waiting-stake');
    addTearDown(harness.dispose);
    await tester.pumpWidget(harness.app);
    await tester.pumpAndSettle();

    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();

    expect(find.byType(HomeLobbyScreen), findsOneWidget);
    expect(harness.flow.state.lifecycle, same(waitingSnapshot));
    expect(harness.flow.cancelSearchCalls, 0);
  });

  testWidgets('Home renders authoritative waiting details and safe reference', (
    tester,
  ) async {
    final harness = waitingHarness();
    addTearDown(harness.dispose);
    await tester.pumpWidget(harness.app);
    await tester.pumpAndSettle();

    expect(find.text('ACTIVE MATCH'), findsOneWidget);
    expect(find.text('Waiting for opponent'), findsOneWidget);
    expect(find.textContaining('₦2,000', findRichText: true), findsOneWidget);
    expect(find.textContaining('Classic', findRichText: true), findsWidgets);
    expect(
      find.textContaining('10 minutes', findRichText: true),
      findsOneWidget,
    );
    expect(find.text('#••••5678'), findsOneWidget);
    expect(find.textContaining('match-wait-5678'), findsNothing);
  });

  testWidgets(
    'Return to Match opens same waiting match and deduplicates taps',
    (tester) async {
      final harness = waitingHarness();
      addTearDown(harness.dispose);
      await tester.pumpWidget(harness.app);
      await tester.pumpAndSettle();

      await tester.ensureVisible(find.text('Return to Match'));
      final button = tester.widget<OutlinedButton>(
        find.widgetWithText(OutlinedButton, 'Return to Match'),
      );
      button.onPressed!();
      button.onPressed!();
      await tester.pumpAndSettle();

      expect(harness.waitingBuilds.value, 1);
      expect(find.text('MATCH #5678'), findsOneWidget);
      expect(harness.flow.state.currentMatchId, 'match-wait-5678');
      expect(harness.flow.gateway.cancelMatchCalls, 0);
    },
  );

  testWidgets('authoritative match_found updates Home card and destination', (
    tester,
  ) async {
    final harness = waitingHarness();
    addTearDown(harness.dispose);
    await tester.pumpWidget(harness.app);
    await tester.pumpAndSettle();

    harness.match.announceMatch('match-wait-5678');
    await tester.pump();
    await tester.pump();

    expect(find.text('Match found'), findsOneWidget);
    await tester.ensureVisible(find.text('Return to Match'));
    await tester.tap(find.text('Return to Match'));
    await tester.pumpAndSettle();
    expect(find.text('Room match-wait-5678'), findsOneWidget);
  });

  testWidgets('card remains until authoritative expiry or cancellation', (
    tester,
  ) async {
    final harness = waitingHarness();
    addTearDown(harness.dispose);
    await tester.pumpWidget(harness.app);
    await tester.pumpAndSettle();

    expect(find.text('ACTIVE MATCH'), findsOneWidget);
    harness.flow.setSearchPhase(SearchPhase.degraded);
    await tester.pump();
    expect(find.text('ACTIVE MATCH'), findsOneWidget);

    harness.flow.setLifecycle(
      const MatchLifecycleSnapshot(
        phase: MatchLifecyclePhase.challengeExpired,
        terms: waitingTerms,
        matchId: 'match-wait-5678',
      ),
    );
    await tester.pump();
    expect(find.text('ACTIVE MATCH'), findsNothing);

    final cancelled = waitingHarness();
    addTearDown(cancelled.dispose);
    await tester.pumpWidget(cancelled.app);
    await tester.pumpAndSettle();
    cancelled.flow.setSearchPhase(SearchPhase.cancelled);
    await tester.pump();
    expect(find.text('ACTIVE MATCH'), findsNothing);
  });

  testWidgets('offline state preserves pending match and reference', (
    tester,
  ) async {
    final harness = waitingHarness(
      matchState: const MatchState(currentMatchId: 'match-wait-5678'),
    );
    addTearDown(harness.dispose);
    await tester.pumpWidget(harness.app);
    await tester.pumpAndSettle();

    harness.match.setOffline();
    await tester.pump();

    expect(find.text('ACTIVE MATCH'), findsOneWidget);
    expect(find.text('#••••5678'), findsOneWidget);
    expect(find.textContaining('reconnecting'), findsOneWidget);
  });

  testWidgets('resume recovery exposes loading then preserves known state', (
    tester,
  ) async {
    final completer = Completer<MatchLifecycleSnapshot?>();
    final harness = waitingHarness(refreshCompleter: completer);
    addTearDown(harness.dispose);
    await tester.pumpWidget(harness.app);
    await tester.pump();

    expect(
      find.textContaining('Checking the latest server status'),
      findsOneWidget,
    );
    completer.complete(waitingSnapshot);
    await tester.pumpAndSettle();
    expect(find.text('Waiting for opponent'), findsOneWidget);
    expect(harness.flow.refreshCalls, 1);
  });

  testWidgets('recovery failure keeps active match visible', (tester) async {
    final harness = waitingHarness(failRefresh: true);
    addTearDown(harness.dispose);
    await tester.pumpWidget(harness.app);
    await tester.pumpAndSettle();

    expect(find.text('ACTIVE MATCH'), findsOneWidget);
    expect(find.textContaining('last known match preserved'), findsOneWidget);
    expect(harness.flow.state.currentMatchId, 'match-wait-5678');
  });

  testWidgets('no active identity renders no active-match card', (
    tester,
  ) async {
    final harness = waitingHarness(flowState: const MatchFlowState());
    addTearDown(harness.dispose);
    await tester.pumpWidget(harness.app);
    await tester.pumpAndSettle();

    expect(find.text('ACTIVE MATCH'), findsNothing);
    expect(find.text('Return to Match'), findsNothing);
  });

  testWidgets('restored active identity returns to the same match room', (
    tester,
  ) async {
    final harness = waitingHarness(
      flowState: const MatchFlowState(),
      matchState: const MatchState(currentMatchId: 'restored-match-42'),
    );
    addTearDown(harness.dispose);
    await tester.pumpWidget(harness.app);
    await tester.pumpAndSettle();

    expect(find.text('Match found'), findsOneWidget);
    await tester.ensureVisible(find.text('Return to Match'));
    await tester.tap(find.text('Return to Match'));
    await tester.pumpAndSettle();
    expect(find.text('Room restored-match-42'), findsOneWidget);
  });

  testWidgets('waiting flow remains accessible without compact overflow', (
    tester,
  ) async {
    useCompactViewport(tester, textScale: 1.2);
    final semantics = tester.ensureSemantics();
    final harness = waitingHarness(initialLocation: '/play/waiting-stake');
    addTearDown(harness.dispose);
    await tester.pumpWidget(harness.app);
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
    await tester.ensureVisible(find.text('Back to Home'));
    expect(find.bySemanticsLabel('Back to Home'), findsOneWidget);
    final buttonSize = tester.getSize(
      find.widgetWithText(OutlinedButton, 'Back to Home'),
    );
    expect(buttonSize.height, greaterThanOrEqualTo(48));
    semantics.dispose();
  });

  testWidgets('Home active card remains accessible on compact screens', (
    tester,
  ) async {
    useCompactViewport(tester, textScale: 1.2);
    final semantics = tester.ensureSemantics();
    final harness = waitingHarness();
    addTearDown(harness.dispose);
    await tester.pumpWidget(harness.app);
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
    await tester.ensureVisible(find.text('Return to Match'));
    expect(
      find.byWidgetPredicate(
        (widget) =>
            widget is Semantics &&
            widget.properties.label == 'Return to active match #••••5678' &&
            widget.properties.button == true,
      ),
      findsOneWidget,
    );
    semantics.dispose();
  });
}
