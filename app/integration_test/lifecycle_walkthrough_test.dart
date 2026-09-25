import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:draughts_arena/main.dart' as app;

Future<void> pumpUntil(
  WidgetTester tester,
  Finder finder, {
  Duration timeout = const Duration(seconds: 40),
  String? what,
}) async {
  final end = DateTime.now().add(timeout);
  while (DateTime.now().isBefore(end)) {
    await tester.pump(const Duration(milliseconds: 250));
    if (finder.evaluate().isNotEmpty) return;
  }
  logVisible(tester, 'TIMEOUT: ${what ?? finder}');
  fail('Timed out waiting for ${what ?? finder}');
}

void logVisible(WidgetTester tester, String tag) {
  final texts = <String>{};
  for (final w in tester.allWidgets) {
    if (w is Text && w.data != null && w.data!.isNotEmpty) {
      texts.add(w.data!);
    }
  }
  // ignore: avoid_print
  print('=== $tag visible text: ${texts.toList()..sort()}');
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('lifecycle walkthrough: accept -> ready -> play -> result', (
    tester,
  ) async {
    app.main();
    await tester.pump(const Duration(seconds: 3));

    // Phase 0: reach the Home arena tab no matter where login lands us
    // (landing carousel -> welcome -> login screen -> home). Real network +
    // socket here.
    const email = 'seed.dev@draughtsarena.net';
    const password = 'Draughts@Dev2026';
    final loginDeadline = DateTime.now().add(const Duration(minutes: 2));
    while (find.text('Arena').evaluate().isEmpty) {
      if (DateTime.now().isAfter(loginDeadline)) {
        logVisible(tester, 'TIMEOUT: never reached Home');
        fail('Timed out reaching the Home bottom nav');
      }
      await tester.pump(const Duration(milliseconds: 500));
      final fields = find.byType(TextFormField);
      if (fields.evaluate().length >= 2) {
        await tester.enterText(fields.at(0), email);
        await tester.pump(const Duration(milliseconds: 200));
        await tester.enterText(fields.at(1), password);
        await tester.pump(const Duration(milliseconds: 200));
        await tester.tap(find.text('Sign In'));
        await tester.pump(const Duration(seconds: 1));
        continue;
      }
      // First run: leave the onboarding carousel. Slide 0 is a bare splash
      // (swipe only); later slides expose Skip.
      final pageView = find.byType(PageView);
      if (pageView.evaluate().isNotEmpty) {
        final skip = find.text('Skip');
        if (skip.evaluate().isNotEmpty) {
          await tester.tap(skip);
          await tester.pump(const Duration(seconds: 1));
          continue;
        }
        await tester.fling(
          pageView,
          const Offset(-420, 0),
          1200,
        );
        await tester.pump(const Duration(seconds: 1));
        continue;
      }
      // Welcome screen: open the login form.
      final welcomeSignIn = find.text('Sign In');
      if (welcomeSignIn.evaluate().isNotEmpty) {
        await tester.tap(welcomeSignIn);
        await tester.pump(const Duration(seconds: 1));
        continue;
      }
      await tester.pump(const Duration(seconds: 1));
    }

    // Phase 1: open the Arena and review the first open match.
    await tester.tap(find.text('Arena'));
    await pumpUntil(
      tester,
      find.text('JOIN'),
      timeout: const Duration(seconds: 30),
      what: 'open match JOIN button',
    );
    await tester.tap(find.text('JOIN').first);

    // Phase 2: OpenMatchDetailsScreen (#1).
    await pumpUntil(
      tester,
      find.text('OPEN MATCH'),
      timeout: const Duration(seconds: 15),
      what: 'details screen',
    );
    logVisible(tester, 'details');
    expect(find.text('Join match'), findsOneWidget);
    await tester.tap(find.text('Join match'));

    // Phase 3: Match Confirmation.
    await pumpUntil(
      tester,
      find.text('Match Confirmation'),
      timeout: const Duration(seconds: 15),
      what: 'confirmation screen',
    );
    await tester.tap(find.text('Confirm & Lock Stake'));

    // Phase 4: the merged room syncs the canonical state; readiness is
    // signaled server-side (seed via REST /ready, p2 via the watcher), then
    // the game starts and the room unlocks Enter Match.
    await pumpUntil(
      tester,
      find.text('READY TO PLAY'),
      timeout: const Duration(seconds: 45),
      what: 'room synced',
    );
    logVisible(tester, 'room');

    // Phase 5: both ready -> in_progress -> Enter Match.
    await pumpUntil(
      tester,
      find.text('Enter Match'),
      timeout: const Duration(seconds: 60),
      what: 'Enter Match (in_progress)',
    );
    await tester.tap(find.text('Enter Match'));

    // Phase 6: live play screen (p2 resigns after a beat -> seed wins).
    await pumpUntil(
      tester,
      find.byWidgetPredicate(
        (w) =>
            w is Text &&
            (w.data?.toUpperCase() == 'VICTORY' ||
                w.data?.toUpperCase() == 'DEFEAT'),
      ),
      timeout: const Duration(seconds: 90),
      what: 'result screen',
    );
    logVisible(tester, 'result');
    // Let late socket-driven frames settle before teardown (the live clock can
    // otherwise trip the binding's pending-frame assert).
    await tester.pump(const Duration(seconds: 3));
  });
}