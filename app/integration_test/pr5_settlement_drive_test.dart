import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:socket_io_client/socket_io_client.dart' as socket_io;
import 'package:draughts_arena/main.dart' as app;

const _base = 'http://10.0.2.2:3000/api/v1';
const _socketBase = 'http://10.0.2.2:3000';

const scenario = String.fromEnvironment('SCENARIO', defaultValue: 'processing');
const parkSeconds = int.fromEnvironment('PARK_SECONDS', defaultValue: 0);
const verifyLiveFlip = bool.fromEnvironment('VERIFY_LIVE_FLIP');

const email = 'seed.dev@draughtsarena.net';
const password = 'Draughts@Dev2026';
const p2Email = 'p2.arena+1790254924343@draughtsarena.net';
const p2Password = 'Arena-Match-P2-77!';

Future<Map<String, dynamic>> _readJson(HttpClientRequest request) async {
  final response = await request.close();
  final buffer = StringBuffer();
  await for (final chunk in response.transform(utf8.decoder)) {
    buffer.write(chunk);
  }
  return Map<String, dynamic>.from(jsonDecode(buffer.toString()));
}

Future<String> _login(
  HttpClient client,
  String loginEmail,
  String loginPassword,
) async {
  final loginRequest = await client.postUrl(Uri.parse('$_base/auth/login'));
  loginRequest.headers.contentType = ContentType.json;
  loginRequest.write(
    jsonEncode({'email': loginEmail, 'password': loginPassword}),
  );
  final loginJson = await _readJson(loginRequest);
  return loginJson['accessToken'] as String;
}

Future<void> _post(
  String path,
  Map<String, dynamic> body, {
  String? token,
  String? key,
}) async {
  final client = HttpClient();
  try {
    final request = await client.postUrl(Uri.parse('$_base$path'));
    request.headers.contentType = ContentType.json;
    if (token != null) {
      request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
    }
    if (key != null) {
      request.headers.set('Idempotency-Key', key);
    }
    request.write(jsonEncode(body));
    // ignore: avoid_print
    print('API $_base$path -> ${await _readJson(request)}');
  } finally {
    client.close();
  }
}

Future<Map<String, dynamic>?> getPendingChallenge(String token) async {
  final client = HttpClient();
  try {
    final request =
        await client.getUrl(Uri.parse('$_base/players/challenges'));
    request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
    final json = await _readJson(request);
    final items = (json['data']?['challenges'] ?? const []) as List;
    for (final item in items.whereType<Map<String, dynamic>>()) {
      if (item['status'] == 'PENDING') return item;
    }
    return null;
  } finally {
    client.close();
  }
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

Future<void> signIn(WidgetTester tester) async {
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
}

/// Cancels matches that are still pre-play and declines leftover PENDING
/// challenges as the invitee, so a fresh challenge is not blocked by 409.
Future<void> releasePreStartMatches() async {
  final client = HttpClient();
  try {
    final token = await _login(client, email, password);

    final matchesRequest = await client.getUrl(
      Uri.parse('$_base/matches/active'),
    );
    matchesRequest.headers.set(
      HttpHeaders.authorizationHeader,
      'Bearer $token',
    );
    final matchesJson = await _readJson(matchesRequest);
    final items = (matchesJson['data'] ?? const []) as List;
    for (final item in items.whereType<Map<String, dynamic>>()) {
      final id = item['id'];
      if (id == null) continue;
      await _cancel(client, token, id);
      // ignore: avoid_print
      print('=== released stale pre-play match $id');
    }

    final p2Token = await _login(client, p2Email, p2Password);
    final challengesRequest = await client.getUrl(
      Uri.parse('$_base/players/challenges'),
    );
    challengesRequest.headers.set(
      HttpHeaders.authorizationHeader,
      'Bearer $p2Token',
    );
    final challengesJson = await _readJson(challengesRequest);
    final challenges =
        (challengesJson['data']?['challenges'] ?? const []) as List;
    for (final item in challenges.whereType<Map<String, dynamic>>()) {
      final matchId = item['matchId'];
      if (item['status'] != 'PENDING' || matchId == null) continue;
      await _cancel(client, p2Token, matchId, decline: true);
      // ignore: avoid_print
      print('=== declined stale pending challenge for $matchId');
    }
  } finally {
    client.close();
  }
}

Future<void> _cancel(
  HttpClient client,
  String token,
  String matchId, {
  bool decline = false,
}) async {
  final cancelRequest = await client.postUrl(
    Uri.parse('$_base/matches/$matchId/${decline ? 'decline' : 'cancel'}'),
  );
  cancelRequest.headers.set(
    HttpHeaders.authorizationHeader,
    'Bearer $token',
  );
  cancelRequest.headers.set(
    'Idempotency-Key',
    'pr5-cleanup-${DateTime.now().microsecondsSinceEpoch}',
  );
  cancelRequest.headers.contentType = ContentType.json;
  cancelRequest.add([]);
  await _readJson(cancelRequest);
}

/// Challenges p2 from the real UI so the match the drive settles is created by
/// the app itself, with server-owned terms.
Future<String> createChallengeUi(WidgetTester tester) async {
  await tester.tap(find.text('Arena'));
  await tester.pump(const Duration(seconds: 2));

  await tester.tap(find.byTooltip('Find opponent by username'));
  await tester.pump(const Duration(seconds: 2));

  await tester.enterText(find.byType(TextField), 'p2');
  await tester.pump(const Duration(seconds: 1));
  final resultsDeadline = DateTime.now().add(const Duration(seconds: 20));
  while (find.text('p2arena').evaluate().isEmpty) {
    if (DateTime.now().isAfter(resultsDeadline)) {
      fail('Timed out waiting for p2arena search result');
    }
    await tester.pump(const Duration(milliseconds: 500));
  }
  await tester.tap(find.text('p2arena'));
  await tester.pump(const Duration(seconds: 3));

  await tester.tap(find.text('Challenge Player'));
  await tester.pump(const Duration(seconds: 2));

  expect(
    find.text('Challenge stake').evaluate(),
    isNotEmpty,
    reason: 'the stake picker sheet should appear',
  );
  await tester.tap(find.text('₦15,000'));
  await tester.pump(const Duration(seconds: 3));

  final sentDeadline = DateTime.now().add(const Duration(seconds: 15));
  while (find.text('CHALLENGE SENT').evaluate().isEmpty) {
    if (DateTime.now().isAfter(sentDeadline)) {
      fail('CHALLENGE SENT never appeared');
    }
    await tester.pump(const Duration(milliseconds: 500));
  }
  final p2Token = await _login(
    HttpClient(),
    p2Email,
    p2Password,
  );
  final challenge = await getPendingChallenge(p2Token);
  expect(challenge, isNotNull, reason: 'p2 should see the pending challenge');
  return challenge!['matchId'] as String;
}

/// Opens a real p2 socket (the same transport the app uses) so p2 can join,
/// signal ready and end the match from the backend's point of view.
Future<socket_io.Socket> connectP2Socket(String p2Token) async {
  final p2Socket = socket_io.io(
    _socketBase,
    socket_io.OptionBuilder()
        .setTransports(['websocket', 'polling'])
        .disableAutoConnect()
        .enableForceNewConnection()
        .setAuth({'token': p2Token})
        .build(),
  );
  final connected = Completer<bool>();
  final failed = Completer<String>();
  p2Socket.onConnect((_) {
    if (!connected.isCompleted) connected.complete(true);
  });
  // The server answers a refused action with `error` on the acting socket only.
  // p2 is not the app under test, so nothing else would surface the reason its
  // join/ready/resign is dropped.
  p2Socket.on('error', (data) {
    // ignore: avoid_print
    print('=== p2 socket ACTION ERROR: $data');
  });
  p2Socket.on('action_error', (data) {
    // ignore: avoid_print
    print('=== p2 socket action_error: $data');
  });
  p2Socket.onAny((event, data) {
    // ignore: avoid_print
    print('=== p2 socket recv [$event]: $data');
  });
  p2Socket.on('connect_error', (data) {
    // ignore: avoid_print
    print('=== p2 socket connect_error: $data');
    if (!failed.isCompleted) failed.complete('connect_error $data');
  });
  p2Socket.onError((data) {
    // ignore: avoid_print
    print('=== p2 socket onError: $data');
    if (!failed.isCompleted) failed.complete('onError $data');
  });
  p2Socket.connect();
  await Future.any([
    connected.future,
    failed.future.timeout(
      const Duration(seconds: 20),
      onTimeout: () => throw TimeoutException('socket never connected'),
    ),
  ]).timeout(const Duration(seconds: 20));
  // ignore: avoid_print
  print('=== p2 real socket connected');
  return p2Socket;
}

Future<void> pumpUntil(
  WidgetTester tester,
  Finder finder, {
  required Duration timeout,
  required String what,
}) async {
  final deadline = DateTime.now().add(timeout);
  while (finder.evaluate().isEmpty) {
    if (DateTime.now().isAfter(deadline)) {
      logVisible(tester, 'TIMEOUT: $what');
      fail('Timed out waiting for $what');
    }
    await tester.pump(const Duration(seconds: 1));
  }
}

Future<void> parkOnScreen(WidgetTester tester) async {
  final holdSeconds = parkSeconds > 0 ? parkSeconds : 300;
  final holdUntil = DateTime.now().add(Duration(seconds: holdSeconds));
  while (DateTime.now().isBefore(holdUntil)) {
    await tester.pump(const Duration(seconds: 3));
  }
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'PR5 settlement drive ($scenario): real match settles server-side',
    (tester) async {
      app.main();
      await tester.pump(const Duration(seconds: 3));
      await signIn(tester);
      await releasePreStartMatches();

      final matchId = await createChallengeUi(tester);
      // ignore: avoid_print
      print('=== real challenge match $matchId awaiting p2 join');

      // p2 joins for real, then opens a socket so the backend accepts its
      // ready/resign actions exactly as it would from the p2 app.
      final p2Client = HttpClient();
      final p2Token = await _login(p2Client, p2Email, p2Password);
      final joinKey = 'pr5-join-${DateTime.now().millisecondsSinceEpoch}';
      await _post(
        '/matches/$matchId/join',
        {'stakeMinorUnits': 1500000, 'timeControlSeconds': 600},
        token: p2Token,
        key: joinKey,
      );
      p2Client.close();

      final p2Socket = await connectP2Socket(p2Token);

      // The real client joins the match room before signalling readiness; the
      // room join is what stages the server-side projection, so ready/resign
      // from a socket that skipped it would be dropped.
      p2Socket.emit('match.join', {'matchId': matchId});

      await pumpUntil(
        tester,
        find.text('READY CHECK'),
        timeout: const Duration(seconds: 45),
        what: 'ready check after the join',
      );

      // Seed readies from the real UI, p2 readies over its real socket, so the
      // backend promotes the match to in_progress on its own.
      if (find.text('I am ready').evaluate().isNotEmpty) {
        await tester.tap(find.text('I am ready'));
        await tester.pump(const Duration(seconds: 2));
      }
      // ignore: avoid_print
      print('=== p2 signals ready over the real socket');
      p2Socket.emit('player.ready', {
        'matchId': matchId,
        'actionId': 'pr5-ready-${DateTime.now().microsecondsSinceEpoch}',
      });

      await pumpUntil(
        tester,
        find.text('Resign'),
        timeout: const Duration(seconds: 60),
        what: 'the live board once the server started the game',
      );
      logVisible(tester, 'live board');

      // p2 resigns from a real socket: the backend settles the ledger, emits the
      // terminal outcome, and holds the receipt confirmation back for
      // SETTLEMENT_CONFIRM_DELAY_MS. The parked app therefore has to render the
      // real "result final, settlement still processing" window.
      // ignore: avoid_print
      print('=== p2 resigns over the real socket');
      p2Socket.emit('resign', {'matchId': matchId});
      await tester.pump(const Duration(seconds: 2));

      // The ledger has moved but the receipt confirmation is still in flight,
      // so the app must be showing the processing line, not "Settlement
      // complete". Assert the pending copy so a recording can never silently
      // capture the confirmed state instead.
      await pumpUntil(
        tester,
        find.text('Result final · settlement processing'),
        timeout: const Duration(seconds: 60),
        what: 'the settled result still awaiting receipt confirmation',
      );
      expect(
        find.text('Settlement complete'),
        findsNothing,
        reason: 'receipt confirmation is delayed, so the result must not '
            'claim the settlement is complete',
      );
      logVisible(tester, '=== RESULT while settlement is processing');
      // ignore: avoid_print
      print('=== PARK: victory result held for recording');
      await parkOnScreen(tester);

      // The processing line is the way a player opens the settlement detail, so
      // tap it the way a player would rather than routing there directly.
      await tester.tap(find.text('Result final · settlement processing'));
      await pumpUntil(
        tester,
        find.text('SETTLEMENT PROCESSING'),
        timeout: const Duration(seconds: 30),
        what: 'the settlement processing screen behind the result line',
      );
      expect(
        find.text('SETTLEMENT COMPLETE'),
        findsNothing,
        reason: 'the confirmation is still in flight',
      );
      logVisible(tester, '=== SETTLEMENT PROCESSING');
      // ignore: avoid_print
      print('=== PARK: settlement processing screen held for recording');
      await parkOnScreen(tester);

      if (verifyLiveFlip) {
        // Proves the open settlement screen follows the server: the delayed
        // confirmation has to land here and retitle the screen in place.
        await pumpUntil(
          tester,
          find.text('SETTLEMENT COMPLETE'),
          timeout: const Duration(minutes: 5),
          what: 'the confirmation retitling the open settlement screen',
        );
        expect(
          find.text('SETTLEMENT PROCESSING'),
          findsNothing,
          reason: 'the confirmed screen must replace the processing one',
        );
        logVisible(tester, '=== SETTLEMENT COMPLETE after live confirmation');
        // ignore: avoid_print
        print('=== LIVE FLIP VERIFIED on the open settlement screen');
      }

      p2Socket.dispose();
    },
    timeout: const Timeout(Duration(minutes: 14)),
  );
}
