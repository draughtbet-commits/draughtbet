import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:draughts_arena/main.dart' as app;
import 'package:draughts_arena/router/app_router.dart';

const targetRoute = String.fromEnvironment('TARGET_ROUTE', defaultValue: '');

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
    'PR4 screen drive: $targetRoute',
    (tester) async {
      app.main();
      await tester.pump(const Duration(seconds: 3));

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

      final navCtx = tester.element(find.byType(Navigator).first);
      final router = ProviderScope.containerOf(navCtx).read(appRouterProvider);
      router.go(targetRoute);
      await tester.pump(const Duration(seconds: 3));

      logVisible(tester, 'screen');
      expect(true, true, reason: 'parked on $targetRoute for recording');
      final holdUntil = DateTime.now().add(const Duration(minutes: 14));
      while (DateTime.now().isBefore(holdUntil)) {
        await tester.pump(const Duration(seconds: 5));
      }
    },
    timeout: const Timeout(Duration(minutes: 15)),
  );
}