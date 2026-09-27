import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:draughts_arena/main.dart' as app;

/// Drives the PR6 deposit screens against the real backend on the emulator.
///
/// The backend runs with PAYSTACK_API_BASE pointed at
/// `backend/scripts/fake-paystack.mjs`, so the quote, intent, signature
/// verification and webhook crediting are all real; only the hosted checkout
/// page is local. Every step parks and holds so each screen can be recorded on
/// its own:
///
///   flutter test integration_test/deposit_drive_test.dart -d emulator-5554 \
///     --dart-define=TARGET_STEP=add-money \
///     --dart-define=HOLD_MINUTES=14
///
/// Steps: add-money, methods, checkout, webview, pending, successful.
///
/// The awaiting-confirmation step is reached as PENDING because the backend
/// only ever writes PENDING or COMPLETED for a deposit; PROCESSING is a
/// withdrawal-only status.
const targetStep = String.fromEnvironment(
  'TARGET_STEP',
  defaultValue: 'successful',
);
const holdMinutes = int.fromEnvironment('HOLD_MINUTES', defaultValue: 14);
const targetEmail = String.fromEnvironment(
  'TARGET_EMAIL',
  defaultValue: 'seed.dev@draughtsarena.net',
);
const targetPassword = String.fromEnvironment(
  'TARGET_PASSWORD',
  defaultValue: 'Draughts@Dev2026',
);
const driveAmount = String.fromEnvironment(
  'DRIVE_AMOUNT',
  defaultValue: '2000',
);

const _apiBase = 'http://10.0.2.2:3000/api/v1';
// This code runs on the device, so the fake provider on the host is reached
// through the emulator loopback alias rather than the device's own 127.0.0.1.
const _fakePaystack = 'http://10.0.2.2:4010';

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

Future<String> _readJson(HttpClientRequest request) async {
  final response = await request.close();
  return response.transform(utf8.decoder).join();
}

Future<String> loginToken() async {
  final client = HttpClient();
  try {
    final request = await client.postUrl(Uri.parse('$_apiBase/auth/login'));
    request.headers.contentType = ContentType.json;
    request.write(
      jsonEncode({'email': targetEmail, 'password': targetPassword}),
    );
    final json = jsonDecode(await _readJson(request)) as Map<String, dynamic>;
    return ((json['data']?['accessToken'] ?? json['accessToken']) as String?)
        ?? '';
  } finally {
    client.close();
  }
}

/// Tells the fake Paystack to deliver the signed charge.success webhook for the
/// newest checkout session, so the app's own status poll can observe the credit
/// rather than the test writing to the database.
Future<void> confirmThroughFakePaystack() async {
  final client = HttpClient();
  try {
    final request = await client.postUrl(
      Uri.parse('$_fakePaystack/test/confirm'),
    );
    final body = await _readJson(request);
    // ignore: avoid_print
    print('=== fake paystack confirm: $body');
  } catch (error) {
    // ignore: avoid_print
    print('=== fake paystack confirm failed: $error');
  } finally {
    client.close();
  }
}

/// Pumps until [finder] appears, so a drive never races a screen transition.
Future<bool> waitFor(
  WidgetTester tester,
  Finder finder, {
  Duration timeout = const Duration(seconds: 45),
  String label = '',
}) async {
  final deadline = DateTime.now().add(timeout);
  while (DateTime.now().isBefore(deadline)) {
    if (finder.evaluate().isNotEmpty) return true;
    await tester.pump(const Duration(milliseconds: 400));
  }
  // ignore: avoid_print
  print('=== TIMEOUT waiting for $label');
  return false;
}

/// Pumps until any one of [texts] appears. The waiting screen is rendered from
/// the server's own status, so a deposit that has not been confirmed yet reads
/// PENDING rather than PROCESSING.
Future<bool> waitForAny(
  WidgetTester tester,
  List<String> texts, {
  Duration timeout = const Duration(seconds: 45),
  required String label,
}) async {
  final deadline = DateTime.now().add(timeout);
  while (DateTime.now().isBefore(deadline)) {
    if (texts.any((text) => find.text(text).evaluate().isNotEmpty)) return true;
    await tester.pump(const Duration(milliseconds: 400));
  }
  // ignore: avoid_print
  print('=== TIMEOUT waiting for $label');
  return false;
}

Future<void> tapText(WidgetTester tester, String text) async {
  final finder = find.text(text);
  expect(
    finder,
    findsWidgets,
    reason: 'expected to find "$text" to tap',
  );
  // Flow screens autofocus their first field, so the soft keyboard can leave
  // trailing actions below the fold. Drop focus and scroll the target in.
  FocusManager.instance.primaryFocus?.unfocus();
  await tester.pump(const Duration(milliseconds: 500));
  final target = finder.first;
  await tester.ensureVisible(target);
  await tester.pump(const Duration(milliseconds: 500));
  await tester.tap(target);
  await tester.pump(const Duration(seconds: 1));
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  // A tap that lands on the wrong widget would otherwise just warn and let the
  // drive sail past a screen it never actually reached.
  WidgetController.hitTestWarningShouldBeFatal = true;

  testWidgets(
    'PR6 deposit screen drive: $targetStep',
    (tester) async {
      app.main();
      await tester.pump(const Duration(seconds: 3));

      // Sign in through the real UI, exactly as a player would. A fresh install
      // has no persisted onboarding flag, so the drive walks the carousel first.
      final loginDeadline = DateTime.now().add(const Duration(minutes: 3));
      while (find.text('Arena').evaluate().isEmpty) {
        if (DateTime.now().isAfter(loginDeadline)) {
          logVisible(tester, 'TIMEOUT: never reached Home');
          fail('Timed out reaching the Home bottom nav');
        }
        await tester.pump(const Duration(milliseconds: 500));

        // The carousel only offers "Skip" once it is past the first slide.
        final skip = find.text('Skip');
        if (skip.evaluate().isNotEmpty) {
          await tester.tap(skip.first);
          await tester.pump(const Duration(seconds: 1));
          continue;
        }
        if (find.text('Play smart. Compete fairly').evaluate().isNotEmpty) {
          await tester.drag(
            find.byType(PageView).first,
            const Offset(-400, 0),
          );
          await tester.pump(const Duration(seconds: 1));
          continue;
        }

        final fields = find.byType(TextFormField);
        if (fields.evaluate().length >= 2) {
          await tester.enterText(fields.at(0), targetEmail);
          await tester.pump(const Duration(milliseconds: 200));
          await tester.enterText(fields.at(1), targetPassword);
          await tester.pump(const Duration(milliseconds: 200));
          await tapText(tester, 'Sign In');
          continue;
        }

        // The landing CTA shares the "Sign In" label, so scroll it into view.
        final signIn = find.text('Sign In');
        if (signIn.evaluate().isNotEmpty) {
          await tester.ensureVisible(signIn.first);
          await tester.pump(const Duration(milliseconds: 400));
          await tester.tap(signIn.first);
          await tester.pump(const Duration(seconds: 1));
          continue;
        }
        await tester.pump(const Duration(seconds: 1));
      }

      // Wallet -> Add money.
      await waitFor(tester, find.text('Wallet'), label: 'Wallet tab');
      await tapText(tester, 'Wallet');
      await tester.pump(const Duration(seconds: 2));

      final addMoney = find.text('Add money');
      if (addMoney.evaluate().isNotEmpty) {
        await tester.tap(addMoney.first);
      } else {
        await tapText(tester, 'Add Money');
      }
      await tester.pump(const Duration(seconds: 2));

      if (!await waitFor(
        tester,
        find.text('Continue'),
        label: 'Add money screen',
      )) {
        logVisible(tester, 'add money TIMEOUT');
        fail('Never reached the Add money screen');
      }

      // Amount first, so the recorded Add money screen shows a real amount.
      // Target the field by key: the wallet underneath stays in the tree and
      // also renders amount inputs.
      final amountField = find.byKey(const ValueKey('deposit-amount-field'));
      expect(
        amountField,
        findsOneWidget,
        reason: 'deposit amount field must be on the Add money screen',
      );
      await tester.enterText(amountField, driveAmount);
      await tester.pump(const Duration(milliseconds: 400));

      if (targetStep == 'add-money') {
        logVisible(tester, 'add-money');
      } else {
        // Let the server quote the fee and total before choosing a method.
        await tapText(tester, 'Continue');
        if (!await waitFor(
          tester,
          find.text('Choose how to pay'),
          label: 'payment method screen',
        )) {
          logVisible(tester, 'methods TIMEOUT');
          fail('Never reached the payment method screen');
        }
        // The quote is server-owned, so wait for a real method tile to appear.
        await waitFor(
          tester,
          find.text('Paystack'),
          label: 'server-supplied payment methods',
        );

        if (targetStep == 'methods') {
          logVisible(tester, 'methods');
        } else {
          // Tapping a tile only marks the method; the trailing action creates
          // the intent and stays disabled until one is chosen.
          await tapText(tester, 'Paystack');
          await tapText(tester, 'Continue to payment');
          if (!await waitFor(
            tester,
            find.text('CHECKOUT READY'),
            label: 'hosted checkout screen',
          )) {
            logVisible(tester, 'checkout TIMEOUT');
            fail('Never reached the hosted checkout screen');
          }

          if (targetStep == 'checkout') {
            logVisible(tester, 'checkout');
          } else {
            await tapText(tester, 'Pay now');
            // Tapping opens the local hosted checkout webview.
            await tester.pump(const Duration(seconds: 3));

            if (targetStep == 'webview') {
              // Parked on the fake provider's hosted page.
              logVisible(tester, 'webview');
            } else {
              // The checkout launcher only returns once the hosted page is
              // dismissed, and that return is what makes the app read the
              // authoritative status back from the server. The page closes with
              // its own AppBar control, which pageBack() cannot see.
              final closeHostedPage = find.byIcon(Icons.close);
              if (!await waitFor(
                tester,
                closeHostedPage,
                label: 'hosted checkout close control',
              )) {
                logVisible(tester, 'webview TIMEOUT');
                fail('The hosted checkout page never opened');
              }
              await tester.tap(closeHostedPage.first);
              await tester.pump(const Duration(seconds: 1));
              if (!await waitForAny(
                tester,
                const ['DEPOSIT PENDING', 'DEPOSIT PROCESSING'],
                label: 'deposit awaiting confirmation screen',
              )) {
                logVisible(tester, 'pending TIMEOUT');
                fail('Never reached the deposit awaiting confirmation screen');
              }

              if (targetStep == 'pending' || targetStep == 'processing') {
                logVisible(tester, 'pending');
              } else {
                // Settle the payment and let the app's own poll observe the
                // credit rather than the test writing to the database.
                await confirmThroughFakePaystack();
                if (!await waitFor(
                  tester,
                  find.text('DEPOSIT SUCCESSFUL'),
                  timeout: const Duration(seconds: 60),
                  label: 'deposit successful screen',
                )) {
                  logVisible(tester, 'successful TIMEOUT');
                  fail('Deposit never reached the successful screen');
                }
                logVisible(tester, 'successful');
              }
            }
          }
        }
      }

      // ignore: avoid_print
      print(
        '=== parked on step "$targetStep" for recording '
        '(hold ${holdMinutes}m); token len '
        '${(await loginToken()).length}',
      );
      final holdUntil = DateTime.now().add(Duration(minutes: holdMinutes));
      while (DateTime.now().isBefore(holdUntil)) {
        await tester.pump(const Duration(seconds: 5));
      }
    },
    timeout: Timeout(Duration(minutes: holdMinutes + 6)),
  );
}
