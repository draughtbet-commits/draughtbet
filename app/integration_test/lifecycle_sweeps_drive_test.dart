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

const scenario = String.fromEnvironment('SCENARIO', defaultValue: '');
const parkSeconds = int.fromEnvironment('PARK_SECONDS', defaultValue: 0);

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
    final json = await _readJson(request);
    // ignore: avoid_print
    print('API $_base$path -> $json');
  } finally {
    client.close();
  }
}

Future<String> loginToken(String email, String password) async {
  final client = HttpClient();
  try {
    final request = await client.postUrl(Uri.parse('$_base/auth/login'));
    request.headers.contentType = ContentType.json;
    request.write(jsonEncode({'email': email, 'password': password}));
    final json = await _readJson(request);
    return json['accessToken'] as String;
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
  final p2Token = await loginToken(p2Email, p2Password);
  final challenge = await getPendingChallenge(p2Token);
  expect(challenge, isNotNull, reason: 'p2 should see the pending challenge');
  return challenge!['matchId'] as String;
}

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

    // A leftover PENDING challenge is not listed in /matches/active (its match
    // is OPEN, not FUNDED/READY), yet it blocks a fresh challenge with 409. The
    // invitee (p2) declines it so both the MatchChallenge row and the match are
    // cleared through the real API.
    final p2Token = await _login(client, p2Email, p2Password);
    final challengesRequest = await client.getUrl(
      Uri.parse('$_base/players/challenges'),
    );
    challengesRequest.headers.set(
      HttpHeaders.authorizationHeader,
      'Bearer $p2Token',
    );
    final challengesJson = await _readJson(challengesRequest);
    final challenges = (challengesJson['data']?['challenges'] ?? const []) as List;
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

Future<String> _login(
  HttpClient client,
  String loginEmail,
  String loginPassword,
) async {
  final loginRequest =
      await client.postUrl(Uri.parse('$_base/auth/login'));
  loginRequest.headers.contentType = ContentType.json;
  loginRequest.write(
    jsonEncode({'email': loginEmail, 'password': loginPassword}),
  );
  final loginJson = await _readJson(loginRequest);
  return loginJson['accessToken'] as String;
}

Future<void> parkOnScreen(WidgetTester tester) async {
  // Keep the terminal screen live on the emulator for recording. Defaults to
  // 5 minutes; override with PARK_SECONDS.
  final holdSeconds = parkSeconds > 0 ? parkSeconds : 300;
  final holdUntil = DateTime.now().add(Duration(seconds: holdSeconds));
  while (DateTime.now().isBefore(holdUntil)) {
    await tester.pump(const Duration(seconds: 3));
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
    'sweep-cleanup-${DateTime.now().microsecondsSinceEpoch}',
  );
  cancelRequest.headers.contentType = ContentType.json;
  cancelRequest.add([]);
  await _readJson(cancelRequest);
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'sweep drive: $scenario',
    (tester) async {
      app.main();
      await tester.pump(const Duration(seconds: 3));
      await signIn(tester);
      await releasePreStartMatches();

      final matchId = await createChallengeUi(tester);

      if (scenario == 'challengeExpired') {
        // Leave the challenge pending and let the expiry sweep own it.
        logVisible(tester, 'CHALLENGE SENT parked');
        final deadline =
            DateTime.now().add(const Duration(minutes: parkSeconds > 0 ? parkSeconds + 60 : 4));
        while (find.text('CHALLENGE EXPIRED').evaluate().isEmpty &&
            DateTime.now().isBefore(deadline)) {
          await tester.pump(const Duration(seconds: 2));
        }
        expect(
          find.text('CHALLENGE EXPIRED').evaluate(),
          isNotEmpty,
          reason: 'the inviter should see the challenge-expired state once the sweep fires',
        );
        logVisible(tester, 'CHALLENGE EXPIRED');
        logVisible(tester, '=== PARK: challenge expired screen held for recording');
        await parkOnScreen(tester);
        return;
      }

      // Fund the match so both sides hold as real backend state.
      final p2Token = await loginToken(p2Email, p2Password);
      final joinKey = 'sweep-join-${DateTime.now().millisecondsSinceEpoch}';
      await _post('/matches/$matchId/join',
          {'stakeMinorUnits': 1500000, 'timeControlSeconds': 600},
          token: p2Token, key: joinKey);

      final readyDeadline = DateTime.now().add(const Duration(seconds: 30));
      while (find.text('READY CHECK').evaluate().isEmpty &&
          DateTime.now().isBefore(readyDeadline)) {
        await tester.pump(const Duration(seconds: 1));
      }
      expect(
        find.text('READY CHECK').evaluate(),
        isNotEmpty,
        reason: 'the inviter should reach the ready screen after the join',
      );

      if (scenario == 'readyTimeout') {
        logVisible(tester, 'READY CHECK parked');
        final deadline =
            DateTime.now().add(const Duration(minutes: parkSeconds > 0 ? parkSeconds + 60 : 4));
        while (find.text('READY TIMEOUT').evaluate().isEmpty &&
            DateTime.now().isBefore(deadline)) {
          await tester.pump(const Duration(seconds: 2));
        }
        expect(
          find.text('READY TIMEOUT').evaluate(),
          isNotEmpty,
          reason: 'the ready-gate sweep should release the match while parked on ready check',
        );
        logVisible(tester, 'READY TIMEOUT');
        logVisible(tester, '=== PARK: ready timeout screen held for recording');
        await parkOnScreen(tester);
        return;
      }

      if (scenario == 'disconnected') {
        // Open a real p2 socket (like the app does) and then drop it; the
        // backend notifies the parked opponent over the personal room and the
        // app navigates to the disconnected-before-start state.
        socket_io.Socket p2Socket;
        try {
          p2Socket = socket_io.io(
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
          await connected.future.timeout(
            const Duration(seconds: 20),
            onTimeout: () => throw TimeoutException('socket never connected'),
          );
          // ignore: avoid_print
          print('=== p2 real socket connected');
          await tester.pump(const Duration(seconds: 3));
          p2Socket.dispose();
          // ignore: avoid_print
          print('=== p2 real socket dropped');
        } catch (err) {
          // ignore: avoid_print
          print('=== p2 socket connect/dispose failed: $err');
        }

        final deadline = DateTime.now().add(const Duration(minutes: 2));
        while (find.text('OPPONENT DISCONNECTED').evaluate().isEmpty &&
            DateTime.now().isBefore(deadline)) {
          await tester.pump(const Duration(seconds: 1));
        }
        expect(
          find.text('OPPONENT DISCONNECTED').evaluate(),
          isNotEmpty,
          reason: 'the parked opponent should surface the pre-start disconnect',
        );
        logVisible(tester, 'OPPONENT DISCONNECTED');
        logVisible(tester, '=== PARK: opponent disconnected screen held for recording');
        await parkOnScreen(tester);
        return;
      }

      if (parkSeconds > 0) {
        final holdUntil = DateTime.now().add(Duration(seconds: parkSeconds));
        while (DateTime.now().isBefore(holdUntil)) {
          await tester.pump(const Duration(seconds: 5));
        }
      }
    },
    timeout: const Timeout(Duration(minutes: 9)),
  );
}