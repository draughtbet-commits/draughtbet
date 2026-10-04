import 'dart:async';

import 'package:draughts_arena/models/eligibility.dart';
import 'package:draughts_arena/providers/eligibility_provider.dart';
import 'package:draughts_arena/screens/safer_play_screens.dart';
import 'package:draughts_arena/services/eligibility_gateway.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

class _SaferGateway implements EligibilityGateway {
  SaferPlayProfile? profile = const SaferPlayProfile();
  int? depositLimit;
  int? stakeLimit;
  int? timeoutMinutes;
  String? exclusionUntil;
  int mutationCount = 0;
  Completer<SaferPlayProfile?>? pendingMutation;

  Future<SaferPlayProfile?> _result() {
    mutationCount++;
    return pendingMutation?.future ?? Future.value(profile);
  }

  @override
  Future<VerificationSnapshot?> fetchVerificationStatus() async =>
      const VerificationSnapshot(status: VerificationStatus.notRequired);

  @override
  Future<SaferPlayProfile?> fetchSaferPlayProfile() async => profile;

  @override
  Future<VerificationStartResult> startVerification(
    VerificationCheckType type,
  ) async => const VerificationStartResult(
    snapshot: VerificationSnapshot(status: VerificationStatus.pending),
  );

  @override
  Future<SaferPlayProfile?> setDepositLimit(int? amountMinorUnits) {
    depositLimit = amountMinorUnits;
    return _result();
  }

  @override
  Future<SaferPlayProfile?> setStakeLimit(int? amountMinorUnits) {
    stakeLimit = amountMinorUnits;
    return _result();
  }

  @override
  Future<SaferPlayProfile?> startSelfExclusion(String until) {
    exclusionUntil = until;
    return _result();
  }

  @override
  Future<SaferPlayProfile?> startTimeout(int minutes) {
    timeoutMinutes = minutes;
    return _result();
  }
}

void main() {
  test('notifier keeps mutations server-authoritative', () async {
    final gateway = _SaferGateway()
      ..profile = const SaferPlayProfile(
        effectiveDepositLimitMinorUnits: 500000,
        effectiveStakeLimitMinorUnits: 100000,
      );
    final notifier = EligibilityNotifier(gateway);

    expect(await notifier.setLimit(deposit: true, amount: 750000), isTrue);
    expect(gateway.depositLimit, 750000);
    expect(
      notifier.state.saferPlay?.effectiveDepositLimitMinorUnits,
      500000,
      reason:
          'Flutter must display the server response, not the submitted value.',
    );

    expect(await notifier.setLimit(deposit: false, amount: 200000), isTrue);
    expect(gateway.stakeLimit, 200000);
    expect(notifier.state.saferPlay?.effectiveStakeLimitMinorUnits, 100000);

    expect(await notifier.takeBreak(1440), isTrue);
    expect(gateway.timeoutMinutes, 1440);
    expect(await notifier.selfExclude('30d'), isTrue);
    expect(gateway.exclusionUntil, '30d');
  });

  test('duplicate safer-play submission is prevented', () async {
    final gateway = _SaferGateway()
      ..pendingMutation = Completer<SaferPlayProfile?>();
    final notifier = EligibilityNotifier(gateway);
    final first = notifier.setLimit(deposit: true, amount: 500000);
    expect(notifier.state.submitting, isTrue);
    expect(await notifier.setLimit(deposit: true, amount: 600000), isFalse);
    expect(gateway.mutationCount, 1);
    gateway.pendingMutation!.complete(const SaferPlayProfile());
    expect(await first, isTrue);
  });

  testWidgets('dashboard renders server effective limits and active control', (
    tester,
  ) async {
    final now = DateTime.now();
    final gateway = _SaferGateway()
      ..profile = SaferPlayProfile(
        effectiveDepositLimitMinorUnits: 500000,
        effectiveStakeLimitMinorUnits: 100000,
        timeoutUntil: now.add(const Duration(hours: 4)),
      );
    await _pump(tester, const SaferPlayDashboardScreen(), gateway: gateway);
    expect(find.textContaining('₦5,000'), findsOneWidget);
    expect(find.textContaining('₦1,000'), findsOneWidget);
    expect(find.text('Active restriction'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('deposit limit validates input before server mutation', (
    tester,
  ) async {
    final gateway = _SaferGateway();
    await _pump(
      tester,
      const LimitEditorScreen(deposit: true),
      gateway: gateway,
    );
    await tester.tap(find.byKey(const Key('save-limit-button')));
    await tester.pump();
    expect(
      find.text('Enter a valid amount greater than zero.'),
      findsOneWidget,
    );
    expect(gateway.mutationCount, 0);
  });

  testWidgets(
    'stake limit converts the entered major amount only for transport',
    (tester) async {
      final gateway = _SaferGateway();
      await _pump(
        tester,
        const LimitEditorScreen(deposit: false),
        gateway: gateway,
      );
      await tester.enterText(
        find.byKey(const Key('limit-amount-field')),
        '2500',
      );
      await tester.tap(find.byKey(const Key('save-limit-button')));
      await tester.pump();
      expect(gateway.stakeLimit, isNull);
      expect(find.text('Confirm stake limit'), findsOneWidget);
      await tester.tap(find.byKey(const Key('confirm-safer-play-action')));
      await tester.pump();
      expect(gateway.stakeLimit, 250000);
    },
  );

  testWidgets('take-a-break requires explicit confirmation', (tester) async {
    final gateway = _SaferGateway();
    await _pump(tester, const TakeBreakScreen(), gateway: gateway);
    await tester.ensureVisible(find.text('Continue'));
    await tester.tap(find.text('Continue'));
    await tester.pump();
    expect(gateway.timeoutMinutes, isNull);
    expect(find.text('Start this break?'), findsOneWidget);
    await tester.tap(find.byKey(const Key('confirm-safer-play-action')));
    await tester.pump();
    expect(gateway.timeoutMinutes, 1440);
  });

  testWidgets('unavailable safer-play status blocks control navigation', (
    tester,
  ) async {
    final gateway = _SaferGateway()..profile = null;
    await _pump(tester, const SaferPlayDashboardScreen(), gateway: gateway);
    await tester.pumpAndSettle();
    expect(find.text('CONTROLS UNAVAILABLE'), findsOneWidget);
    expect(find.text('Deposit limits'), findsNothing);
    expect(find.text('Try again'), findsOneWidget);
  });

  testWidgets('restriction screen never invents an active restriction', (
    tester,
  ) async {
    final gateway = _SaferGateway();
    await _pump(tester, const ActiveRestrictionScreen(), gateway: gateway);
    expect(find.text('NO ACTIVE RESTRICTION'), findsOneWidget);
    expect(find.text('BREAK ACTIVE'), findsNothing);
  });

  testWidgets('all safer-play supporting states render without overflow', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(320, 568);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final gateway = _SaferGateway()
      ..profile = SaferPlayProfile(
        selfExcludedUntil: DateTime.now().add(const Duration(days: 30)),
      );
    for (final screen in <Widget>[
      const SaferPlayDashboardScreen(),
      const LimitEditorScreen(deposit: true),
      const LimitEditorScreen(deposit: false),
      const TakeBreakScreen(),
      const SelfExclusionScreen(),
      const SessionReminderScreen(),
      const ActiveRestrictionScreen(),
      const LimitConfirmedScreen(),
    ]) {
      await _pump(
        tester,
        screen,
        gateway: gateway,
        textScaler: const TextScaler.linear(1.3),
      );
      expect(
        tester.takeException(),
        isNull,
        reason: screen.runtimeType.toString(),
      );
    }
  });
}

Future<void> _pump(
  WidgetTester tester,
  Widget child, {
  required _SaferGateway gateway,
  TextScaler textScaler = TextScaler.noScaling,
}) async {
  final notifier = EligibilityNotifier(
    gateway,
    initialState: EligibilityState(
      phase: EligibilityLoadPhase.ready,
      verification: const VerificationSnapshot(
        status: VerificationStatus.notRequired,
      ),
      saferPlay: gateway.profile,
    ),
  );
  final router = GoRouter(
    initialLocation: '/',
    routes: [
      GoRoute(path: '/', builder: (context, state) => child),
      GoRoute(
        path: '/profile/settings/limit-confirmed',
        builder: (context, state) => const LimitConfirmedScreen(),
      ),
      GoRoute(
        path: '/home',
        builder: (context, state) => const Scaffold(body: Text('Home')),
      ),
    ],
  );
  addTearDown(router.dispose);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [eligibilityProvider.overrideWith((ref) => notifier)],
      child: MaterialApp.router(
        theme: ThemeData.dark(),
        routerConfig: router,
        builder: (context, routedChild) => MediaQuery(
          data: MediaQueryData(textScaler: textScaler),
          child: routedChild!,
        ),
      ),
    ),
  );
  await tester.pump();
}
