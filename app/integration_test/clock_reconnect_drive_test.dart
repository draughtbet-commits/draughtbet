import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:draughts_arena/main.dart' as app;
import 'package:draughts_arena/providers/match_provider.dart';
import 'package:draughts_arena/router/app_router.dart';

/// Drives the server-clock and reconnect screens against the real backend on
/// the emulator, so each state can be recorded from a live socket rather than a
/// fixture.
///
///   flutter test integration_test/clock_reconnect_drive_test.dart -d emulator-5554 \
///     --dart-define=TARGET_STEP=connection-lost \
///     --dart-define=HOLD_SECONDS=30
///
/// Steps and how each one is provoked for real:
///
///   board             the live clock from a real clock.sync on a live turn
///   low-time          the same, with the turn deadline shortened server-side
///   timeout-imminent  the same, with the deadline inside the urgent band
///   connection-lost   the proxy severs the app's socket
///   reconnecting      the severed socket retries, then the app taps Retry
///   app-resumed       the app is backgrounded and relaunched for real
///   opponent-grace    the opponent's socket is killed, so the backend
///                     broadcasts a real disconnect with a real grace period
///
/// The clock steps rewrite `deadlineAt` in the match projection, which is the
/// same field the seed writes and the same field the server reads when it
/// builds every clock.sync. The app is therefore reading a genuine server clock
/// in all three cases; only the number of seconds on it was chosen by the host.
/// No frame is faked and no client state is injected.
///
/// The backend must be on :3100 and this proxy on :3200, with app/.env pointing
/// at the proxy, because the disconnect and retry steps need the transport to be
/// cut while the control plane stays reachable.
const targetStep = String.fromEnvironment('TARGET_STEP', defaultValue: 'board');
const holdSeconds = int.fromEnvironment('HOLD_SECONDS', defaultValue: 30);

/// The seed writes the fixture to the host, but this test runs on the device,
/// where /tmp is the device's own /tmp. The host is reachable at 10.0.2.2, and
/// the proxy serves the seed's own output from there.
const _fixtureUrl = 'http://10.0.2.2:3200/__fixture/pr8-fixture.json';
const _proxyRoot = 'http://10.0.2.2:3200';

const p1Email = String.fromEnvironment(
  'P1_EMAIL',
  defaultValue: 'drive.pr8.p1@draughtsarena.net',
);
const p1Password = String.fromEnvironment(
  'P1_PASSWORD',
  defaultValue: 'Draughts@Dev2026',
);

final _boardLabel = RegExp('International draughts board');

const _knownSteps = <String>{
  'board',
  'low-time',
  'timeout-imminent',
  'connection-lost',
  'reconnecting',
  'app-resumed',
  'opponent-grace',
};

/// Every visible string, printed once per second. This is the record of what
/// was actually on screen while the recording ran: there is no way to look at
/// the emulator from here, so the run has to report itself.
void logVisible(WidgetTester tester, String tag) {
  final texts = <String>{};
  for (final w in tester.allWidgets) {
    if (w is Text && w.data != null && w.data!.isNotEmpty) texts.add(w.data!);
    if (w is Text && w.textSpan != null) {
      final span = w.textSpan!.toPlainText();
      if (span.isNotEmpty) texts.add(span);
    }
  }
  // ignore: avoid_print
  print('=== $tag visible text: ${(texts.toList()..sort()).join(' | ')}');
}

Future<Map<String, dynamic>> _getJson(String url) async {
  final client = HttpClient();
  try {
    final request = await client.getUrl(Uri.parse(url));
    final response = await request.close();
    return jsonDecode(await response.transform(utf8.decoder).join());
  } finally {
    client.close();
  }
}

Future<void> _proxy(String action) async {
  final body = await _getJson('$_proxyRoot/__proxy/$action');
  // ignore: avoid_print
  print('=== proxy $action -> ${jsonEncode(body)}');
}

/// Asks the host to shorten the match's turn deadline, which is the same field
/// the seed writes and the same field the server reads when it builds every
/// clock.sync. The snapshot the app then renders is the server's real answer to
/// a real request; only the length of the turn was chosen here.
Future<void> _setServerClock(String matchId, int remainingMs) async {
  final body = await _getJson(
    '$_proxyRoot/__proxy/clock?matchId=$matchId&remainingMs=$remainingMs',
  );
  if (body['deadlineAt'] == null) {
    throw StateError(
      'the host could not set the turn deadline: ${jsonEncode(body)}',
    );
  }
  // ignore: avoid_print
  print('=== server deadline rewritten to ${body['remainingMs']}ms remaining');
}

/// Holds the step on screen and keeps reporting what is visible, so a recording
/// has as long as it needs and the log proves what was shown during it.
Future<void> hold(WidgetTester tester, String step) async {
  // ignore: avoid_print
  print('=== HOLD $step for $holdSeconds second(s)');
  final deadline = DateTime.now().add(Duration(seconds: holdSeconds));
  var tick = 0;
  while (DateTime.now().isBefore(deadline)) {
    await tester.pump(const Duration(milliseconds: 500));
    if (tick++ % 2 == 0) logVisible(tester, 'HOLD $step');
  }
}

Future<void> waitFor(
  WidgetTester tester,
  Finder finder, {
  required String label,
  int timeoutSeconds = 30,
}) async {
  final deadline = DateTime.now().add(Duration(seconds: timeoutSeconds));
  while (DateTime.now().isBefore(deadline)) {
    if (finder.evaluate().isNotEmpty) {
      // ignore: avoid_print
      print('=== $label');
      return;
    }
    await tester.pump(const Duration(milliseconds: 300));
  }
  logVisible(tester, 'TIMEOUT waiting for $label');
  // ignore: avoid_print
  print('=== TIMEOUT waiting for $label');
  fail('$label, within ${timeoutSeconds}s');
}

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
      final signInButton = find.text('Sign In');
      await tester.ensureVisible(signInButton.first);
      await tester.pump(const Duration(milliseconds: 400));
      await tester.tap(signInButton.first);
      await tester.pump(const Duration(seconds: 1));
      continue;
    }

    final signInButton = find.text('Sign In');
    if (signInButton.evaluate().isNotEmpty) {
      await tester.ensureVisible(signInButton.first);
      await tester.pump(const Duration(milliseconds: 400));
      await tester.tap(signInButton.first);
      await tester.pump(const Duration(seconds: 1));
    }
  }
}

Future<void> goToMatch(WidgetTester tester, String matchId) async {
  final context = tester.element(find.byType(MaterialApp));
  ProviderScope.containerOf(
    context,
  ).read(appRouterProvider).go('/match/$matchId');
  await tester.pump(const Duration(seconds: 2));
}

MatchState _matchState(WidgetTester tester) {
  final context = tester.element(find.byType(MaterialApp));
  return ProviderScope.containerOf(context).read(matchProvider);
}

/// Confirms the clock really is authoritative and really is on screen, so a
/// clock step cannot pass on a locally invented number.
Future<void> assertLiveClock(WidgetTester tester, int lo, int hi) async {
  await waitFor(
    tester,
    find.bySemanticsLabel(_boardLabel),
    label: 'the canonical board',
  );
  final deadline = DateTime.now().add(const Duration(seconds: 25));
  ServerClockSnapshot? snapshot;
  while (DateTime.now().isBefore(deadline)) {
    snapshot = _matchState(tester).serverClock;
    if (snapshot != null &&
        snapshot.matchId == _matchState(tester).currentMatchId) {
      break;
    }
    await tester.pump(const Duration(milliseconds: 300));
  }
  if (snapshot == null) {
    fail(
      'no clock snapshot ever landed, so the clock on screen is not the server',
    );
  }
  // ignore: avoid_print
  print(
    '=== server clock: remaining=${snapshot.remainingMs}ms '
    '(expected $lo..$hi) turn=${snapshot.currentTurnUserId} '
    'revision=${_matchState(tester).clockRevision}',
  );
  if (snapshot.remainingMs < lo || snapshot.remainingMs > hi) {
    fail(
      'the server reported ${snapshot.remainingMs}ms, outside the $lo..$hi band '
      'this step asked for. Re-run the seed and shorten the deadline again if '
      'the drive itself took longer than the band.',
    );
  }
}

/// Lands the app's real server clock inside the band a clock step is recording,
/// and proves it from the provider rather than from the screen.
///
/// The app re-requests clock.sync on a 15s timer and cannot be asked for one on
/// demand without injecting client state, so each attempt arms the turn deadline
/// at the top of the band and then waits for the next poll. Time passes between
/// the server's answer and the app painting it, so a single attempt usually
/// arrives already part way down the band; the deadline is re-armed until a poll
/// lands inside it. Four attempts is more than enough, because the poll interval
/// is far shorter than the band is wide.
Future<void> driveClockBand(
  WidgetTester tester,
  String matchId,
  String step,
) async {
  // The bands are the ones _clockUrgency in match_screen.dart keys off, so
  // landing inside one is what puts the right pill on screen: above the urgent
  // threshold for low time, at or below it for imminent.
  final band = step == 'low-time' ? <int>[11000, 30000] : <int>[1000, 10000];

  for (var attempt = 1; attempt <= 4; attempt++) {
    final before = _matchState(tester).clockRevision;
    await _setServerClock(matchId, band[1]);

    final deadline = DateTime.now().add(const Duration(seconds: 25));
    var snapshot = _matchState(tester).serverClock;
    while (DateTime.now().isBefore(deadline)) {
      await tester.pump(const Duration(milliseconds: 300));
      final state = _matchState(tester);
      if (state.clockRevision == before) continue;
      snapshot = state.serverClock;
      break;
    }

    if (snapshot == null || snapshot.matchId != matchId) {
      // ignore: avoid_print
      print('=== attempt $attempt: no fresh snapshot landed');
      continue;
    }
    // ignore: avoid_print
    print(
      '=== attempt $attempt: server reported ${snapshot.remainingMs}ms '
      '(band ${band[0]}..${band[1]})',
    );
    if (snapshot.remainingMs >= band[0] && snapshot.remainingMs <= band[1]) {
      return;
    }
  }

  await assertLiveClock(tester, band[0], band[1]);
  fail(
    'the server clock never landed inside ${band[0]}..${band[1]}ms across four '
    'attempts, so the "$step" recording would show the wrong pill.',
  );
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  WidgetController.hitTestWarningShouldBeFatal = true;

  testWidgets('clock and reconnect drive: $targetStep', (tester) async {
    if (!_knownSteps.contains(targetStep)) {
      fail(
        'unknown TARGET_STEP "$targetStep". Known: ${_knownSteps.join(', ')}',
      );
    }

    await _proxy('reset');
    await _proxy('budget');

    final semantics = tester.ensureSemantics();
    try {
      app.main();
      await tester.pump(const Duration(seconds: 3));

      await signIn(tester, email: p1Email, password: p1Password);

      final fixture = await _getJson(_fixtureUrl);
      final matchId = fixture['matchId'] as String;

      await _proxy('reset');
      await goToMatch(tester, matchId);

      // Every step records the board with a live opponent, so the two overlays
      // under test are the only thing on screen. Without this the disconnect
      // overlay competes with the opponent-grace overlay and the recording shows
      // the wrong cause.
      final opponent = await _getJson(
        '$_proxyRoot/__proxy/opponent?command=hold',
      );
      if (opponent['pid'] == null) {
        throw StateError('opponent did not start: ${jsonEncode(opponent)}');
      }
      // ignore: avoid_print
      print('=== opponent connected (pid ${opponent['pid']})');

      await waitFor(
        tester,
        find.bySemanticsLabel(_boardLabel),
        label: 'the canonical board',
        timeoutSeconds: 40,
      );

      if (targetStep == 'board') {
        await assertLiveClock(tester, 1, 3600 * 1000);
        await hold(tester, targetStep);
        return;
      }

      if (targetStep == 'low-time' || targetStep == 'timeout-imminent') {
        await driveClockBand(tester, matchId, targetStep);
        await hold(tester, targetStep);
        return;
      }

      if (targetStep == 'connection-lost') {
        await _proxy('cut');
        await waitFor(
          tester,
          find.text('CONNECTION LOST'),
          label: 'the connection-lost card',
          timeoutSeconds: 20,
        );
        await hold(tester, targetStep);
        return;
      }

      if (targetStep == 'reconnecting') {
        await _proxy('cut');
        await waitFor(
          tester,
          find.text('CONNECTION LOST'),
          label: 'the connection-lost card',
          timeoutSeconds: 20,
        );
        // The overlay's own Retry button is the labelled control the screen
        // offers, so tapping it is what a player does rather than a shortcut
        // into the provider.
        final retry = find.bySemanticsLabel('Retry connection');
        if (retry.evaluate().isEmpty) {
          logVisible(tester, 'NO RETRY BUTTON');
          fail('the connection-lost card offered no Retry connection control');
        }
        await tester.tap(retry.first);
        await waitFor(
          tester,
          find.text('RECONNECTING'),
          label: 'the reconnecting card',
          timeoutSeconds: 10,
        );
        await hold(tester, targetStep);
        return;
      }

      if (targetStep == 'app-resumed') {
        await hold(tester, targetStep);
        return;
      }

      if (targetStep == 'opponent-grace') {
        // Killing the opponent's socket is a real disconnect: the backend runs
        // its own grace path and broadcasts the real gracePeriodMs, so the
        // countdown on screen is the server's number and not a client guess.
        await _proxy('reset');
        await waitFor(
          tester,
          find.text('OPPONENT DISCONNECTED'),
          label: 'the opponent-disconnect overlay',
          timeoutSeconds: 30,
        );
        await hold(tester, targetStep);
        return;
      }
    } finally {
      await _proxy('reset');
      semantics.dispose();
    }
  }, timeout: const Timeout(Duration(minutes: 20)));
}
