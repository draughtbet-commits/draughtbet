import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:draughts_arena/main.dart' as app;
import 'package:draughts_arena/providers/match_provider.dart';
import 'package:draughts_arena/router/app_router.dart';

/// Drives the four PR8 game-protocol screens that the app's own UI can reach,
/// against the real backend on the emulator.
///
///   flutter test integration_test/pr8_game_drive_test.dart -d emulator-5554 \
///     --dart-define=TARGET_STEP=state-resync \
///     --dart-define=HOLD_SECONDS=40
///
/// Steps, and the contract check each one corresponds to:
///
///   board           the canonical match.state the server sends on join
///   move-pending    the app's own submit, before the reply lands
///   state-resync    move.submit refused with stale_state, the version gate
///   move-history    the durable MatchMove log the protocol added
///
/// The other three rejections in the contract are deliberately absent, and not
/// because they are hard to reach. `inputEnabled` in match_screen.dart requires
/// it to be the player's turn on a synced board, and `_onSquareTapped` only
/// submits a pair that is in `game.legalMoves`, so the client refuses to send
/// not_your_turn, illegal_move or invalid_payload at all. Reaching those would
/// mean scripting a socket that bypasses the app, which tests the wire and not
/// the screen; pr8-game-protocol.mjs already covers them (P5, P6, P7).
///
/// The backend and a delaying proxy (pr8-socket-proxy.mjs) both have to be
/// running, and app/.env must point at the proxy, because move-pending and
/// state-resync can only be caught with a frame in flight:
///
///   * move-pending exists only between the emit and the reply, so the reply is
///     held for the length of the recording.
///   * state-resync needs the opponent's game_state to land after the app has
///     already submitted, so the app's cached version is behind while its socket
///     still looks healthy. Blocking the socket would not work: offline sets
///     syncState offline and the board stops accepting input.
///
/// The opponent is driven by backend/scripts/pr8-opponent.mjs over its own
/// socket, so the app never learns about the move until the proxy releases it.
const targetStep = String.fromEnvironment('TARGET_STEP', defaultValue: 'board');
const holdSeconds = int.fromEnvironment('HOLD_SECONDS', defaultValue: 14 * 60);

/// The seed writes the fixture to the host, but the test runs on the device,
/// where /tmp is the device's own /tmp. The host reaches the emulator through
/// 10.0.2.2, so the fixture is fetched over HTTP from the proxy's static root
/// rather than read off the filesystem.
const _fixtureUrl = 'http://10.0.2.2:3200/__fixture/pr8-fixture.json';

const p1Email = String.fromEnvironment(
  'P1_EMAIL',
  defaultValue: 'drive.pr8.p1@draughtsarena.net',
);
const p1Password = String.fromEnvironment(
  'P1_PASSWORD',
  defaultValue: 'Draughts@Dev2026',
);
const p2Email = String.fromEnvironment(
  'P2_EMAIL',
  defaultValue: 'drive.pr8.p2@draughtsarena.net',
);
const p2Password = String.fromEnvironment(
  'P2_PASSWORD',
  defaultValue: 'Draughts@Dev2026',
);

/// The app talks to the proxy, which is the only piece of this drive that is
/// not the real backend. It relays REST untouched and relays the socket with a
/// frame delay, so app/.env must point here.
const _proxyRoot = 'http://10.0.2.2:3200';

/// The board's semantics label carries a piece count after it, so it has to be
/// matched as a pattern: a plain String would require the whole label to be
/// equal and would never match.
final _boardLabel = RegExp('International draughts board');

const _knownSteps = <String>{
  'board',
  'move-pending',
  'state-resync',
  'move-history',
};

/// The opening position the seed writes has 9 legal WHITE moves; 31 -> 26 is the
/// first the engine returns. These are square numbers, not grid cells — the
/// board widget converts a tap into one of these.
const _whiteFrom = 31;
const _whiteTo = 26;

/// WHITE's opening back rank (31-50). The resync step needs any piece the board
/// will offer a destination for, and it cannot know which of them is movable
/// without asking — after the opponent's reply the board has already changed,
/// so the opening move may no longer be legal.
const _whiteBackRank = <int>[31, 32, 33, 34, 35, 36, 37, 38, 39, 40];

void logVisible(WidgetTester tester, String tag) {
  final texts = <String>{};
  for (final w in tester.allWidgets) {
    if (w is Text && w.data != null && w.data!.isNotEmpty) texts.add(w.data!);
  }
  // ignore: avoid_print
  print('=== $tag visible text: ${(texts.toList()..sort()).join(', ')}');
}

Future<String> _read(HttpClientResponse response) async {
  return response.transform(utf8.decoder).join();
}

Future<Map<String, dynamic>> _getJson(String url) async {
  final client = HttpClient();
  try {
    final request = await client.getUrl(Uri.parse(url));
    final response = await request.close();
    return jsonDecode(await _read(response));
  } finally {
    client.close();
  }
}

/// Arms or releases the frame delay. The proxy is the only thing in this drive
/// that is not the real backend, and it only ever delays the app's view.
Future<void> _proxy(String action, {List<String> events = const []}) async {
  final query = events.isEmpty ? '' : '?events=${events.join(',')}';
  await _getJson('$_proxyRoot/__proxy/$action$query');
}

/// The opponent runs on the host, so the proxy starts it and reports the
/// version it moved to. Waiting for that number is what tells the test the
/// server has moved on and the app's cached version is now behind.
/// Starts P2's hold socket and leaves it running for the rest of the drive.
Future<void> _startOpponent() async {
  final body = await _getJson('$_proxyRoot/__proxy/opponent?command=hold');
  if (body['pid'] == null) {
    throw StateError('opponent did not start: ${jsonEncode(body)}');
  }
  // ignore: avoid_print
  print('=== opponent connected as P2 (pid ${body['pid']})');
}

Future<int> _opponentMoves({String? side}) async {
  final query = side == null ? '' : '&side=$side';
  final body = await _getJson('$_proxyRoot/__proxy/opponent?command=move$query');
  final version = body['version'];
  if (version is! int) {
    throw StateError('opponent did not report a move: ${jsonEncode(body)}');
  }
  // ignore: avoid_print
  print('=== opponent moved the server to version $version');
  return version;
}

/// The seed writes the turn deadline, and the server's CAS guard refuses any move
/// once it lapses with TURN_EXPIRED. Confirm the seeded turn is still alive from
/// the device before a step submits, because a lapsed clock is reported by the
/// app as STATE RESYNC — the same thing the resync step is trying to prove — so
/// a stale seed would make that step pass for the wrong reason.
Future<void> assertTurnIsAlive(String matchId) async {
  final body = await _getJson('$_proxyRoot/__proxy/opponent?command=status');
  if (body['turnExpired'] == true) {
    fail(
      'the seeded turn for $matchId has already expired. Re-run '
      'scripts/seed-game-protocol-drive.mjs, which writes the deadline, and '
      'start the drive straight after — a Gradle build alone can outlive a '
      'short clock.',
    );
  }
  // ignore: avoid_print
  print('=== turn is alive (${body['reason'] ?? 'ok'})');
}

Future<bool> waitFor(
  WidgetTester tester,
  Finder finder, {
  String? label,
  int timeoutSeconds = 30,
}) async {
  final deadline = DateTime.now().add(Duration(seconds: timeoutSeconds));
  while (DateTime.now().isBefore(deadline)) {
    if (finder.evaluate().isNotEmpty) return true;
    await tester.pump(const Duration(milliseconds: 300));
  }
  // ignore: avoid_print
  print('=== TIMEOUT waiting for ${label ?? finder.toString()}');
  return false;
}

/// Fails the step when the app has already given up on the turn, so a clock that
/// expired mid-drive is reported as what it is. The server's CAS guard refuses a
/// move on a lapsed deadline with TURN_EXPIRED, and the app surfaces that as
/// STATE RESYNC — which means a stale clock and a genuine version-gate rejection
/// look identical on screen, and the resync step would silently pass against an
/// expired turn. Checked before every step that submits a move.
Future<void> failIfTurnExpired(WidgetTester tester, String step) async {
  if (find.text('STATE RESYNC').evaluate().isNotEmpty) {
    logVisible(tester, 'TURN EXPIRED before "$step"');
    fail(
      'the turn had already expired before "$step", so this would test the '
      'clock rather than the protocol. Re-run the seed: it writes the turn '
      'deadline, and PROXY_VERBOSE=1 on the proxy shows the rejection code.',
    );
  }
}

Future<void> tapText(WidgetTester tester, String label) async {
  final finder = find.text(label);
  if (finder.evaluate().isEmpty) {
    throw StateError('nothing to tap for "$label"');
  }
  await tester.ensureVisible(finder.first);
  await tester.pump(const Duration(milliseconds: 300));
  await tester.tap(finder.first);
  await tester.pump(const Duration(seconds: 1));
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
      await tapText(tester, 'Sign In');
      continue;
    }

    final signIn = find.text('Sign In');
    if (signIn.evaluate().isNotEmpty) {
      await tester.ensureVisible(signIn.first);
      await tester.pump(const Duration(milliseconds: 400));
      if (signIn.evaluate().isNotEmpty) {
        await tester.tap(signIn.first);
        await tester.pump(const Duration(seconds: 1));
      }
      continue;
    }
    await tester.pump(const Duration(seconds: 1));
  }
}

/// The board is a single GestureDetector that maps a tap to a square by
/// geometry, and the legal-move affordances are Semantics nodes layered on top
/// with the square number in the label, so tapping by label is the reliable way
/// to hit a specific square.
Future<void> tapSquare(WidgetTester tester, int square) async {
  final row = (square - 1) ~/ 5;
  final index = (square - 1) % 5;
  // Playable squares are the ones where row + column is odd.
  final col = 2 * index + (row.isEven ? 1 : 0);

  final board = find.bySemanticsLabel(_boardLabel);
  if (board.evaluate().isEmpty) {
    throw StateError('the board is not on screen');
  }
  final rect = tester.getRect(board.first);
  final squareSize = rect.width / 10;
  // ignore: avoid_print
  print(
    '=== board rect ${rect.width.toStringAsFixed(0)}x${rect.height.toStringAsFixed(0)} '
    'at ${rect.left.toStringAsFixed(0)},${rect.top.toStringAsFixed(0)}',
  );
  final centre =
      rect.topLeft + Offset((col + 0.5) * squareSize, (row + 0.5) * squareSize);
  // ignore: avoid_print
  print(
    '=== tapping square $square at ${centre.dx.toStringAsFixed(0)},${centre.dy.toStringAsFixed(0)}',
  );
  await tester.tapAt(centre);
  await tester.pump(const Duration(milliseconds: 600));
}

/// Selecting a piece makes the app offer every legal destination, each with a
/// semantics node naming its square. Waiting for that both proves the tap
/// landed on a real piece and tells the test which squares are genuinely
/// playable, rather than assuming a coordinate mapping.
Future<List<int>> offeredDestinations(WidgetTester tester) async {
  final offered = find.bySemanticsLabel(RegExp('Move to square '));
  if (!await waitFor(
    tester,
    offered,
    label: 'offered destinations after selecting a piece',
    timeoutSeconds: 10,
  )) {
    return const <int>[];
  }
  final labels = tester
      .widgetList<Semantics>(offered)
      .map((widget) => widget.properties.label ?? '')
      .toList();
  final squares = <int>[];
  for (final label in labels) {
    final match = RegExp(r'Move to square (\d+)').firstMatch(label);
    if (match != null) squares.add(int.parse(match.group(1)!));
  }
  // ignore: avoid_print
  print('=== offered destinations: $squares');
  return squares;
}

/// Plays the opening 31 -> 26, but only after the app itself confirms the
/// piece was selected and offers the destination. That keeps the drive honest:
/// it never assumes a coordinate mapping or a legal move, it uses the affordance
/// the app actually presents.
Future<void> playOpeningMove(
  WidgetTester tester, {
  required int from,
  required int to,
}) async {
  await tapSquare(tester, from);
  final offered = await offeredDestinations(tester);
  if (offered.isEmpty) {
    logVisible(tester, 'NO DESTINATIONS');
    fail('selecting square $from offered no destinations, so the tap missed');
  }
  if (!offered.contains(to)) {
    fail('square $to was not offered after selecting $from (got $offered)');
  }
  await tapOfferedSquare(tester, to);
}

/// Taps a highlighted destination through the app's own semantics node.
///
/// Deliberately not pixel math, because selecting a piece inserts the "Capture
/// path selected" label above the board and shifts it down mid-move — coordinates
/// derived before the shift land on the wrong row, the tap is swallowed, and no
/// `move.submit` is ever emitted.
///
/// The rect is read *after* a pump settles that shift, not before. Resolving the
/// node and tapping it in one step measures against the pre-shift layout, which
/// is how a destination tap can miss while the board looks perfectly correct in
/// the log.
Future<void> tapOfferedSquare(WidgetTester tester, int square) async {
  final node = find.bySemanticsLabel(RegExp('^Move to square $square,'));
  if (node.evaluate().isEmpty) {
    logVisible(tester, 'NO SEMANTICS NODE for destination $square');
    fail(
      'square $square is offered but has no "Move to square $square" '
      'semantics node to tap',
    );
  }
  // Let the board settle at its final position before measuring it.
  await tester.pumpAndSettle();
  final centre = tester.getCenter(node.first);
  // ignore: avoid_print
  print(
    '=== tapping offered square $square via semantics at '
    '${centre.dx.toStringAsFixed(0)},${centre.dy.toStringAsFixed(0)}',
  );
  await tester.tapAt(centre);
  await tester.pump(const Duration(milliseconds: 600));
}

Future<void> hold(WidgetTester tester, String step) async {
  // ignore: avoid_print
  print('=== holding on "$step" for $holdSeconds second(s) to record');
  logVisible(tester, 'HOLD $step');
  final deadline = DateTime.now().add(Duration(seconds: holdSeconds));
  while (DateTime.now().isBefore(deadline)) {
    await tester.pump(const Duration(milliseconds: 500));
  }
}

/// The app resolves its router from a provider, so the match route is entered
/// the way the Enter Match button would, not by pushing a route by hand.
Future<void> goToMatch(WidgetTester tester, String matchId) async {
  final context = tester.element(find.byType(MaterialApp));
  final container = ProviderScope.containerOf(context);
  container.read(appRouterProvider).go('/match/$matchId');
  await tester.pump(const Duration(seconds: 2));
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  WidgetController.hitTestWarningShouldBeFatal = true;

  testWidgets('PR8 game protocol drive: $targetStep', (tester) async {
    if (!_knownSteps.contains(targetStep)) {
      fail(
        'unknown TARGET_STEP "$targetStep". Known: ${_knownSteps.join(', ')}. '
        'not_your_turn, illegal_move and invalid_payload are intentionally '
        'absent — the client never sends them.',
      );
    }

    // The board exposes its squares through Semantics, and without an active
    // semantics handle the tree is never built, so bySemanticsLabel finds
    // nothing even though the board is on screen.
    // Disposed in a finally rather than a tearDown: the binding verifies that
    // every handle was released before tearDowns run, so a late dispose fails
    // the test even though the screen was recorded correctly.
    // Clear anything a previous run parked before joining, so this run starts
    // from a clean relay instead of waiting on a board that will never arrive.
    await _proxy('reset');

    final semantics = tester.ensureSemantics();
    try {
      app.main();
      await tester.pump(const Duration(seconds: 3));

      await signIn(tester, email: p1Email, password: p1Password);

      // The fixture is the seed's own output, so the match under test is never a
      // guess at a row id. It is fetched over HTTP because the test runs on the
      // device, where the host's /tmp is not the same directory.
      final fixture = await _getJson(_fixtureUrl);
      final matchId = fixture['matchId'] as String;

      // Both of these run before the app joins, and that order is load-bearing.
      // assertTurnIsAlive signs in as P2 to read the authoritative clock, then
      // exits — and handleDisconnect broadcasts that exit to everyone in the
      // match room. Probed after goToMatch it takes the app's opponentConnected
      // down with it, which mounts the disconnect overlay over the board and
      // swallows the tap that follows, so a healthy turn gets reported as an
      // untappable board. Same reason reset leads rather than trails: a socket
      // orphaned by a crashed run would disconnect here and do the same damage.
      await _proxy('reset');
      await assertTurnIsAlive(matchId);

      await goToMatch(tester, matchId);

      // Wait for the canonical board: the join snapshot has to land before the
      // board can be recorded as the server's state rather than a fixture.
      final boardFinder = find.bySemanticsLabel(_boardLabel);
      if (!await waitFor(tester, boardFinder, label: 'the canonical board')) {
        logVisible(tester, 'TIMEOUT: no board');
        await _proxy('release');
        fail('the board never rendered, so nothing could be recorded');
      }
      // ignore: avoid_print
      print('=== joined match $matchId, board is canonical');

      // P2 has to genuinely be on the socket for every step, not just the resync
      // step. `inputEnabled` in match_screen.dart requires
      // `state.opponentConnected`, and the app only learns the opponent is
      // absent once the server says so — so with no P2 socket the board turns
      // input-disabled partway through and the tap is swallowed, which reads as a
      // dead move button and emits no move.submit at all. It would also put
      // "OPPONENT DISCONNECTED" in the recording. This holds the socket for the
      // whole run; state-resync still drives its own separate socket.
      await _startOpponent();

      if (targetStep == 'board') {
        await hold(tester, targetStep);
        return;
      }

      if (targetStep == 'move-history') {
        // The durable log is the same protocol's persistence, read back through
        // its own route. The board has to have a move in it first, so one is
        // played and accepted before leaving.
        await failIfTurnExpired(tester, targetStep);
        await playOpeningMove(tester, from: _whiteFrom, to: _whiteTo);
        await waitFor(
          tester,
          find.text('Move submitted · waiting for server'),
          label: 'the move to be accepted',
          timeoutSeconds: 15,
        );
        await tester.pump(const Duration(seconds: 3));
        final context = tester.element(find.byType(MaterialApp));
        ProviderScope.containerOf(
          context,
        ).read(appRouterProvider).go('/matches/$matchId/moves');
        await tester.pump(const Duration(seconds: 2));
        await hold(tester, targetStep);
        return;
      }

      if (targetStep == 'move-pending') {
        // Hold the reply so the pending banner is still on screen when the
        // recording starts. game_state is held too, otherwise the accepted move
        // would clear the banner through a different path.
        await _proxy(
          'hold',
          events: ['move.accepted', 'game_state', 'move_applied'],
        );
        await failIfTurnExpired(tester, targetStep);
        await playOpeningMove(tester, from: _whiteFrom, to: _whiteTo);
        if (!await waitFor(
          tester,
          find.text('Move submitted · waiting for server'),
          label: 'the pending banner',
          timeoutSeconds: 15,
        )) {
          logVisible(tester, 'TIMEOUT: no pending banner');
          await _proxy('release');
          fail('the app never showed the move as pending');
        }
        await hold(tester, targetStep);
        await _proxy('release');
        return;
      }

      if (targetStep == 'state-resync') {
        // WHITE has to move first so the opponent has a legal reply, and the
        // opponent's reply is what advances the server past the app's version.
        await failIfTurnExpired(tester, targetStep);
        await playOpeningMove(tester, from: _whiteFrom, to: _whiteTo);
        // Wait on the provider, not the pending banner. The banner is
        // transient by design — a real acceptance can land before it ever
        // paints — so waiting for that text fails on a move that actually
        // succeeded, which is the worst possible way to report this step.
        // isMovePending is set on submit and cleared by the acceptance, so it
        // settles exactly when the server has the move.
        await _waitUntil(
          tester,
          () => !_matchState(tester).isMovePending,
          label: "the app's own move to be accepted",
          timeoutSeconds: 15,
        );
        // Both version-carrying frames are parked, not game_state. The opponent's
        // move reaches the app as move_applied *and* move.accepted — the server
        // emits both to the whole room — and either one alone resyncs the app.
        // The app's own acceptance must still land, because that is what clears
        // isMovePending and inputEnabled requires !isMovePending — park it and the
        // stale submit could never be sent. The proxy tells the two apart by
        // clientMoveId. opponent.connection frames stay live, so P2 presence keeps
        // the disconnect overlay away.
        // First let the opponent's move reach the app, so the app believes it is
        // WHITE's turn again and actually offers destinations. This is not
        // optional: right after the app's own move its cached state says the
        // opponent is to move, so every WHITE piece offers nothing and there is
        // no stale move to send. The board showed "Opponent's turn" and the
        // step failed for want of a tap.
        final opponentVersion = await _opponentMoves();
        // ignore: avoid_print
        print('=== opponent moved the server to version $opponentVersion');
        await _waitUntil(
          tester,
          () => _matchState(tester).gameState?.stateVersion == opponentVersion,
          label: 'the app to learn version $opponentVersion',
          timeoutSeconds: 15,
        );

        // Now park the next advances instead. The server moves on while the app
        // stays on v2, which is exactly the stale position this step exists to
        // provoke.
        //
        // Two scripted plies, not one. The app is WHITE and believes it is
        // WHITE's turn on v2, and the server checks whose turn it is *before* it
        // checks the declared version (gameManager.js:665 then :674). A single
        // WHITE ply therefore leaves the server on v3 with BLACK to move, the
        // turn check fires first, and the refusal comes back as not_your_turn
        // rather than stale_state. Advancing an even number of plies lands on v4
        // with WHITE to move again: the turn check passes and the version gate is
        // what refuses. Ordering the server's guards is not on the table here —
        // that is production move validation.
        await _proxy('hold', events: ['move_applied', 'move.accepted']);
        await _opponentMoves(side: 'WHITE');
        final serverVersion = await _opponentMoves(side: 'BLACK');
        // ignore: avoid_print
        print('=== server is now at version $serverVersion; the app is behind');

        // Now the app moves on the version it still holds. It believes it is
        // WHITE's turn on v2 while the server is on v3, so the board accepts the
        // tap and the server refuses the version. Any legal move will do — the
        // point is the version it carries, not the squares — so the first piece
        // the board offers a destination for is used.
        var tapped = false;
        for (final from in _whiteBackRank) {
          await tapSquare(tester, from);
          final destinations = _offeredDestinations(tester);
          if (destinations.isEmpty) continue;
          await tapOfferedSquare(tester, destinations.first);
          await tester.pump(const Duration(seconds: 1));
          if (find.text('STATE RESYNC').evaluate().isNotEmpty) {
            tapped = true;
            break;
          }
          await tapSquare(tester, from); // clear the selection before retrying
        }

        if (!tapped &&
            !await waitFor(
              tester,
              find.text('STATE RESYNC'),
              label: 'the stale-state rejection',
              timeoutSeconds: 10,
            )) {
          logVisible(tester, 'TIMEOUT: no STATE RESYNC');
          await _proxy('release');
          fail(
            'the stale move was not refused, so the version gate was not shown',
          );
        }

        await hold(tester, targetStep);
        await _proxy('release');
        return;
      }
    } finally {
      // Disarm and flush on the way out too: a failed step must not leave the
      // next run joined to a stalled board.
      await _proxy('reset');
      semantics.dispose();
    }
  }, timeout: const Timeout(Duration(minutes: 20)));
}

/// The live match state, read straight off the provider.
///
/// Preferred over waiting on on-screen text wherever the state itself is the
/// thing under test: a banner or label is transient by design and can come and
/// go inside a single frame, so asserting on it proves nothing about whether the
/// protocol did the right thing.
MatchState _matchState(WidgetTester tester) {
  final context = tester.element(find.byType(MaterialApp));
  return ProviderScope.containerOf(context).read(matchProvider);
}

/// Polls [condition] on the app's frame clock until it holds.
Future<void> _waitUntil(
  WidgetTester tester,
  bool Function() condition, {
  required String label,
  int timeoutSeconds = 15,
}) async {
  final deadline = DateTime.now().add(Duration(seconds: timeoutSeconds));
  while (DateTime.now().isBefore(deadline)) {
    if (condition()) {
      // ignore: avoid_print
      print('=== $label');
      return;
    }
    await tester.pump(const Duration(milliseconds: 300));
  }
  // ignore: avoid_print
  print('=== TIMEOUT waiting for $label');
  fail('$label, within ${timeoutSeconds}s');
}

/// The destination squares the board is currently offering, read from the
/// Semantics labels the legal-move affordances carry.
List<int> _offeredDestinations(WidgetTester tester) {
  final result = <int>[];
  final label = RegExp(r'Move to square (\d+)');
  for (final element in find.byType(Semantics).evaluate()) {
    final node = element.widget;
    if (node is! Semantics) continue;
    final text = node.properties.label ?? '';
    final match = label.firstMatch(text);
    if (match != null) {
      final square = int.tryParse(match.group(1)!);
      if (square != null) result.add(square);
    }
  }
  return result;
}
