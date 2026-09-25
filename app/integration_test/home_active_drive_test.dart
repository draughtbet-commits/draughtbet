import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:draughts_arena/main.dart' as app;

const parkSeconds = int.fromEnvironment('PARK_SECONDS', defaultValue: 0);

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

  testWidgets(
    'Home drive: seed signs in and parks on Home',
    (tester) async {
      app.main();
      await tester.pump(const Duration(seconds: 3));

      const email = 'seed.dev@draughtsarena.net';
      const password = 'Draughts@Dev2026';
      final loginDeadline = DateTime.now().add(const Duration(minutes: 2));
      while (find.text('Home').evaluate().isEmpty) {
        if (DateTime.now().isAfter(loginDeadline)) {
          fail('Timed out reaching the Home bottom nav');
        }
        await tester.pump(const Duration(milliseconds: 500));
        final fields = find.byType(TextFormField);
        if (fields.evaluate().length >= 2) {
          await tester.enterText(fields.at(0), email);
          await tester.pump(const Duration(milliseconds: 200));
          await tester.enterText(fields.at(1), password);
          await tester.pump(const Duration(milliseconds: 200));
          final signIn = find.text('Sign In');
          if (signIn.evaluate().isNotEmpty) {
            await tester.tap(signIn);
            await tester.pump(const Duration(seconds: 1));
          }
          continue;
        }
        final pageView = find.byType(PageView);
        if (pageView.evaluate().isNotEmpty) {
          final skip = find.text('Skip');
          if (skip.evaluate().isNotEmpty) {
            await tester.tap(skip);
            await tester.pump(const Duration(seconds: 1));
            continue;
          }
          await tester.fling(pageView, const Offset(-420, 0), 1200);
          await tester.pump(const Duration(seconds: 1));
          continue;
        }
        final welcomeSignIn = find.text('Sign In');
        if (welcomeSignIn.evaluate().isNotEmpty) {
          await tester.tap(welcomeSignIn);
          await tester.pump(const Duration(seconds: 1));
          continue;
        }
        await tester.pump(const Duration(seconds: 1));
      }

      await tester.tap(find.text('Home'));
      await tester.pump(const Duration(seconds: 3));
      // Let the active-matches request settle before logging.
      final settle = DateTime.now().add(const Duration(seconds: 10));
      while (DateTime.now().isBefore(settle)) {
        await tester.pump(const Duration(seconds: 1));
      }
      logVisible(tester, 'HOME parked');

      if (parkSeconds > 0) {
        final holdUntil = DateTime.now().add(Duration(seconds: parkSeconds));
        while (DateTime.now().isBefore(holdUntil)) {
          await tester.pump(const Duration(seconds: 5));
        }
      }
    },
    timeout: Timeout(
      Duration(minutes: parkSeconds > 0 ? parkSeconds ~/ 60 + 5 : 5),
    ),
  );
}