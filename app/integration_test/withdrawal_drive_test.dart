import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:draughts_arena/main.dart' as app;

/// Drives the PR7 withdrawal screens against the real backend on the emulator.
///
/// The backend runs with PAYSTACK_API_BASE pointed at
/// `backend/scripts/fake-paystack.mjs`, so nuban resolution, recipient
/// creation, transfer initiation and the signed transfer webhook are all real;
/// only the provider is local. Each step parks and holds so the screen can be
/// recorded on its own:
///
///   flutter test integration_test/withdrawal_drive_test.dart -d emulator-5556 \
///     --dart-define=TARGET_STEP=processing \
///     --dart-define=HOLD_SECONDS=40
///
/// Steps and the state each one needs from the real backend:
///
///   withdraw-money           amount screen, nothing else required
///   select-bank-account      eligibility answered ALLOWED for a WITHDRAW
///   add-bank-account         the saved-account list is rendered
///   verifying-bank-account   submitting the form hits the provider for real
///   withdrawal-review        a verified destination is selected
///   verification-required    the unverified account; server answers 403 KYC
///   pending-review           a real withdrawal exists and is PENDING_REVIEW
///   processing               finance approved it and payout was initiated
///   successful               the provider delivered transfer.success
///   payout-failed            the provider delivered transfer.failed
///   reversed                 finance rejected it, so funds came back
///
/// `limit-reached` is deliberately absent. No withdrawal ceiling exists in the
/// schema or the safer-play profile, so the backend cannot produce the error
/// that screen is drawn from. Recording it would mean faking a rejection the
/// server cannot send — see `assertUnreachableStep` below.
///
/// The status steps are advanced over HTTP from this test, not by writing to
/// the database, and the screen is only left once its own copy is on the
/// display. That way what gets recorded is the app's poll reading the server,
/// not a fixture.
const targetStep = String.fromEnvironment(
  'TARGET_STEP',
  defaultValue: 'withdraw-money',
);
/// Seconds to park on the screen. Seconds rather than minutes because a short
/// hold is what recording actually wants, and 40s is not expressible in whole
/// minutes.
const holdSeconds = int.fromEnvironment('HOLD_SECONDS', defaultValue: 14 * 60);

// Seeded by backend/scripts/seed-withdrawal-drive.mjs.
const playerEmail = String.fromEnvironment(
  'PLAYER_EMAIL',
  defaultValue: 'withdraw.dev@draughtsarena.net',
);
const playerPassword = String.fromEnvironment(
  'PLAYER_PASSWORD',
  defaultValue: 'Draughts@Dev2026',
);
const unverifiedEmail = String.fromEnvironment(
  'UNVERIFIED_EMAIL',
  defaultValue: 'withdraw.unverified@draughtsarena.net',
);
const unverifiedPassword = String.fromEnvironment(
  'UNVERIFIED_PASSWORD',
  defaultValue: 'Draughts@Dev2026',
);
const staffEmail = String.fromEnvironment(
  'STAFF_EMAIL',
  defaultValue: 'finance.dev@draughtsarena.net',
);
const staffPassword = String.fromEnvironment(
  'STAFF_PASSWORD',
  defaultValue: 'Draughts@Dev2026',
);
const driveAmount = String.fromEnvironment(
  'DRIVE_AMOUNT',
  defaultValue: '500.00',
);
const driveBankCode = String.fromEnvironment('DRIVE_BANK_CODE', defaultValue: '007');
const driveAccountNumber = String.fromEnvironment(
  'DRIVE_ACCOUNT_NUMBER',
  defaultValue: '0123456789',
);

// The backend is on 3100 because port 3000 belongs to another project on this
// host; app/.env points at the same port. These run on the device, so the host
// is reached through the emulator loopback alias.
const _apiBase = 'http://10.0.2.2:3100/api/v1';
const _fakePaystack = 'http://10.0.2.2:4010';

/// Title text each status screen renders, used to wait for the app's own poll to
/// render the state the backend actually reached.
const _expectedScreenText = <String, String>{
  'pending-review': 'PENDING REVIEW',
  'processing': 'PROCESSING',
  'successful': 'SUCCESSFUL',
  'payout-failed': 'PAYOUT FAILED',
  'reversed': 'WITHDRAWAL RELEASED',
};

/// Steps whose screen only appears after the withdrawal is actually created.
const _statusSteps = <String>{
  'pending-review',
  'processing',
  'successful',
  'payout-failed',
  'reversed',
};

const _knownSteps = <String>{
  'withdraw-money',
  'select-bank-account',
  'add-bank-account',
  'verifying-bank-account',
  'withdrawal-review',
  'verification-required',
  ..._statusSteps,
};

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

Future<String> _read(HttpClientRequest request) async {
  final response = await request.close();
  return response.transform(utf8.decoder).join();
}

Map<String, dynamic> _decode(int status, String text) {
  try {
    return {'status': status, 'body': jsonDecode(text)};
  } on FormatException {
    return {'status': status, 'body': text};
  }
}

Future<Map<String, dynamic>> _postJson(
  String url, {
  Map<String, dynamic>? body,
  String? token,
  String? idempotencyKey,
}) async {
  final client = HttpClient();
  try {
    final request = await client.postUrl(Uri.parse(url));
    request.headers.contentType = ContentType.json;
    if (token != null) request.headers.set('authorization', 'Bearer $token');
    if (idempotencyKey != null) {
      request.headers.set('idempotency-key', idempotencyKey);
    }
    if (body != null) request.write(jsonEncode(body));
    final response = await request.close();
    return _decode(response.statusCode, await response.transform(utf8.decoder).join());
  } finally {
    client.close();
  }
}

Future<Map<String, dynamic>> _getJson(String url, {String? token}) async {
  final client = HttpClient();
  try {
    final request = await client.getUrl(Uri.parse(url));
    if (token != null) request.headers.set('authorization', 'Bearer $token');
    final response = await request.close();
    return _decode(response.statusCode, await response.transform(utf8.decoder).join());
  } finally {
    client.close();
  }
}

Future<String> _login(String email, String password) async {
  final res = await _postJson(
    '$_apiBase/auth/login',
    body: {'email': email, 'password': password},
  );
  final body = res['body'];
  final token = body is Map ? (body['data']?['accessToken'] ?? body['accessToken']) : null;
  if (token is! String || token.isEmpty) {
    throw StateError('login failed for $email: ${jsonEncode(res)}');
  }
  return token;
}

/// Reads back the id of the most recent withdrawal in a given state, through the
/// staff API. The app never surfaces the row id, and the admin actions need it,
/// so this is a read rather than a guess. Newest-first, so the withdrawal the
/// player just created is the one returned.
Future<String> _newestWithdrawalId(
  String staffToken,
  String status,
) async {
  final res = await _getJson(
    '$_apiBase/admin/withdrawals?status=$status&limit=1',
    token: staffToken,
  );
  final body = res['body'];
  final list = body is Map ? body['withdrawals'] : null;
  if (list is! List || list.isEmpty) {
    throw StateError('no $status withdrawal to act on: ${jsonEncode(res)}');
  }
  final first = list.first;
  if (first is! Map || first['id'] is! String) {
    throw StateError('unexpected admin list shape: ${jsonEncode(res)}');
  }
  return first['id'] as String;
}

/// Runs one staff action against the real admin API. Every POST is
/// idempotency-keyed, so a retried approval cannot approve twice.
Future<void> _staffAction(
  String staffToken,
  String withdrawalId,
  String action, [
  Map<String, dynamic>? body,
]) async {
  final res = await _postJson(
    '$_apiBase/admin/withdrawals/$withdrawalId/$action',
    token: staffToken,
    body: body ?? const {},
    idempotencyKey: 'drive-$action-$withdrawalId-${DateTime.now().millisecondsSinceEpoch}',
  );
  // ignore: avoid_print
  print('=== staff $action on $withdrawalId -> ${res['status']} ${jsonEncode(res['body'])}');
  if (res['status'] != 200) {
    throw StateError('staff $action failed: ${jsonEncode(res)}');
  }
}

/// Asks the stand-in provider to settle the newest unsettled transfer, which
/// delivers a real signed transfer.success / transfer.failed webhook.
Future<void> _settleTransfer(String outcome) async {
  final client = HttpClient();
  try {
    final request = await client.postUrl(
      Uri.parse('$_fakePaystack/test/transfer/settle?outcome=$outcome'),
    );
    final text = await _read(request);
    // ignore: avoid_print
    print('=== fake paystack settle($outcome): $text');
  } finally {
    client.close();
  }
}

Future<bool> waitFor(
  WidgetTester tester,
  Finder finder, {
  Duration timeout = const Duration(seconds: 60),
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

/// Waits for the status screen to show the copy that belongs to the state the
/// backend reached, so the recording cannot be of a stale frame.
Future<bool> waitForScreenText(WidgetTester tester, String text) async {
  final found = await waitFor(
    tester,
    find.text(text),
    timeout: const Duration(seconds: 90),
    label: 'screen text "$text"',
  );
  if (!found) logVisible(tester, 'TIMEOUT waiting for "$text"');
  return found;
}

Future<void> tapText(WidgetTester tester, String label) async {
  final target = find.text(label);
  if (target.evaluate().isEmpty) {
    // ignore: avoid_print
    print('=== cannot tap "$label": not on screen');
    return;
  }
  await tester.ensureVisible(target.first);
  await tester.pump(const Duration(milliseconds: 400));
  await tester.tap(target.first);
  await tester.pump(const Duration(seconds: 1));
}

/// Signs in through the real UI, walking the first-run carousel on the way.
Future<void> signIn(
  WidgetTester tester, {
  required String email,
  required String password,
}) async {
  final deadline = DateTime.now().add(const Duration(minutes: 3));
  while (find.text('Arena').evaluate().isEmpty) {
    if (DateTime.now().isAfter(deadline)) {
      logVisible(tester, 'TIMEOUT: never reached Home');
      fail('Timed out reaching the Home bottom nav');
    }
    await tester.pump(const Duration(milliseconds: 500));

    final skip = find.text('Skip');
    if (skip.evaluate().isNotEmpty) {
      await tester.tap(skip.first);
      await tester.pump(const Duration(seconds: 1));
      continue;
    }
    if (find.text('Play smart. Compete fairly').evaluate().isNotEmpty) {
      await tester.drag(find.byType(PageView).first, const Offset(-400, 0));
      await tester.pump(const Duration(seconds: 1));
      continue;
    }

    final fields = find.byType(TextFormField);
    if (fields.evaluate().length >= 2) {
      await tester.enterText(fields.at(0), email);
      await tester.pump(const Duration(milliseconds: 200));
      await tester.enterText(fields.at(1), password);
      await tester.pump(const Duration(milliseconds: 200));
      await tapText(tester, 'Sign In');
      continue;
    }

    final signIn = find.text('Sign In');
    if (signIn.evaluate().isNotEmpty) {
      await tester.ensureVisible(signIn.first);
      await tester.pump(const Duration(milliseconds: 400));
      // ensureVisible pumps, and the screen can rebuild underneath us when a
      // stale session is dropping the user back to Home. Re-check before the
      // tap so a vanished button cannot throw No element.
      if (signIn.evaluate().isNotEmpty) {
        await tester.tap(signIn.first);
        await tester.pump(const Duration(seconds: 1));
      }
      continue;
    }
    await tester.pump(const Duration(seconds: 1));
  }
}

/// Wallet -> Withdraw -> amount, which is also what triggers the eligibility
/// call that decides between the normal path and the verification gate.
Future<void> openWithdrawScreen(WidgetTester tester) async {
  await waitFor(tester, find.text('Wallet'), label: 'Wallet tab');
  await tapText(tester, 'Wallet');
  await tester.pump(const Duration(seconds: 2));
  await tapText(tester, 'Withdraw');
  if (!await waitFor(
    tester,
    find.byKey(const ValueKey('withdrawal-amount-field')),
    label: 'Withdraw money screen',
  )) {
    logVisible(tester, 'withdraw money TIMEOUT');
    fail('Never reached the Withdraw money screen');
  }
  await tester.enterText(
    find.byKey(const ValueKey('withdrawal-amount-field')),
    driveAmount,
  );
  await tester.pump(const Duration(milliseconds: 500));
}

Future<void> hold(WidgetTester tester, String step) async {
  // ignore: avoid_print
  print('=== holding on "$step" for $holdSeconds second(s) to record');
  logVisible(tester, 'HOLD $step');
  final deadline = DateTime.now().add(Duration(seconds: holdSeconds));
  while (DateTime.now().isBefore(deadline)) {
    // Pump in short slices so the screen keeps animating (and any in-flight poll
    // keeps running) instead of freezing on a stale frame.
    await tester.pump(const Duration(seconds: 1));
  }
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  // A tap that lands on the wrong widget would otherwise warn and let the drive
  // sail past a screen it never reached.
  WidgetController.hitTestWarningShouldBeFatal = true;

  testWidgets('PR7 withdrawal screen drive: $targetStep', (tester) async {
    if (!_knownSteps.contains(targetStep)) {
      fail(
        'unknown TARGET_STEP "$targetStep". Known: ${_knownSteps.join(', ')}. '
        '"limit-reached" is intentionally not driveable — the backend has no '
        'withdrawal ceiling, so it cannot produce the rejection that screen is '
        'drawn from.',
      );
    }

    app.main();
    await tester.pump(const Duration(seconds: 3));

    final gate = targetStep == 'verification-required';
    await signIn(
      tester,
      email: gate ? unverifiedEmail : playerEmail,
      password: gate ? unverifiedPassword : playerPassword,
    );

    await openWithdrawScreen(tester);

    // The amount screen is recorded with the figure already entered, so the
    // recording shows a real amount against the server's available balance
    // rather than an empty field.
    if (targetStep == 'withdraw-money') {
      await hold(tester, targetStep);
      return;
    }

    await tapText(tester, 'Continue');

    // The unverified account is refused by the server here, and the app routes
    // to the gate rather than inventing a reason.
    if (gate) {
      if (!await waitForScreenText(tester, 'VERIFICATION REQUIRED')) {
        logVisible(tester, 'verification-required TIMEOUT');
        fail('The unverified account did not reach the verification gate');
      }
      await hold(tester, targetStep);
      return;
    }

    // Everything below this line needs the eligibility check to have passed.
    if (!await waitForScreenText(tester, 'SELECT BANK ACCOUNT')) {
      logVisible(tester, 'select-bank-account TIMEOUT');
      fail('Eligibility did not pass, so the flow never reached bank selection');
    }
    if (targetStep == 'select-bank-account') {
      await hold(tester, targetStep);
      return;
    }

    if (targetStep == 'add-bank-account') {
      await tapText(tester, 'Add new bank account');
      if (!await waitForScreenText(tester, 'ADD BANK ACCOUNT')) {
        logVisible(tester, 'add-bank-account TIMEOUT');
        fail('Never reached the Add bank account screen');
      }
      await hold(tester, targetStep);
      return;
    }

    if (targetStep == 'verifying-bank-account') {
      await tapText(tester, 'Add new bank account');
      if (!await waitForScreenText(tester, 'ADD BANK ACCOUNT')) {
        fail('Never reached the Add bank account screen');
      }
      // Bank code and account number only. The account name is the server's to
      // resolve, so the form no longer asks for one.
      final codeField = find.widgetWithText(TextFormField, 'Bank code');
      await tester.enterText(codeField.first, driveBankCode);
      await tester.pump(const Duration(milliseconds: 300));
      final numberField = find.byKey(const ValueKey('bank-account-number-field'));
      await tester.enterText(numberField, driveAccountNumber);
      await tester.pump(const Duration(milliseconds: 300));
      // The add form's action is "Verify account", not "Continue" — tapping
      // Continue would silently do nothing and the drive would sit on the form.
      await tapText(tester, 'Verify account');
      if (!await waitForScreenText(tester, 'VERIFY BANK ACCOUNT')) {
        logVisible(tester, 'verifying-bank-account TIMEOUT');
        fail('Never reached the verifying bank account screen');
      }
      // Wait for the provider round trip to finish, so the recorded frame shows
      // a genuinely verified account rather than a spinner that resolves later.
      if (!await waitForScreenText(tester, 'ACCOUNT VERIFIED')) {
        logVisible(tester, 'verifying-bank-account did not verify');
        fail('The provider did not verify the account on this run');
      }
      await hold(tester, targetStep);
      return;
    }

    // The rest need a selected destination.
    final tile = find.textContaining('••••');
    if (tile.evaluate().isEmpty) {
      logVisible(tester, 'no saved bank account');
      fail(
        'The seed should have left one verified bank account. Run '
        'backend/scripts/seed-withdrawal-drive.mjs first.',
      );
    }
    await tester.ensureVisible(tile.first);
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tap(tile.first);
    await tester.pump(const Duration(seconds: 1));
    await tapText(tester, 'Continue');

    if (!await waitForScreenText(tester, 'Review withdrawal')) {
      logVisible(tester, 'withdrawal-review TIMEOUT');
      fail('Never reached the withdrawal review screen');
    }
    if (targetStep == 'withdrawal-review') {
      await hold(tester, targetStep);
      return;
    }

    // Status steps: create the withdrawal for real, then move it to the state
    // this step is recording.
    await tester.tap(find.byKey(const ValueKey('create-withdrawal-button')));
    await tester.pump(const Duration(seconds: 2));

    if (!await waitForScreenText(tester, _expectedScreenText['pending-review']!)) {
      logVisible(tester, 'pending-review TIMEOUT');
      fail('The created withdrawal never showed the pending review screen');
    }

    if (targetStep == 'pending-review') {
      await hold(tester, targetStep);
      return;
    }

    final staffToken = await _login(staffEmail, staffPassword);

    if (targetStep == 'reversed') {
      final id = await _newestWithdrawalId(staffToken, 'PENDING_REVIEW');
      await _staffAction(staffToken, id, 'reject', {
        'reason': 'Drive recording',
      });
    } else {
      final id = await _newestWithdrawalId(staffToken, 'PENDING_REVIEW');
      await _staffAction(staffToken, id, 'approve');
      await _staffAction(staffToken, id, 'begin-payout');

      if (targetStep != 'processing') {
        // The app polls, so settle the transfer and let its own poll land.
        await tester.pump(const Duration(seconds: 1));
        await _settleTransfer(targetStep == 'successful' ? 'success' : 'failure');
      }
    }

    final expected = _expectedScreenText[targetStep]!;
    if (!await waitForScreenText(tester, expected)) {
      logVisible(tester, '$targetStep TIMEOUT');
      fail('The backend reached the state but the app never rendered "$expected"');
    }

    await hold(tester, targetStep);
  });
}
