import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:draughts_arena/main.dart' as app;

const _base = 'http://10.0.2.2:3000/api/v1';

Future<Map<String, dynamic>> _readJson(HttpClientRequest request) async {
  final response = await request.close();
  final buffer = StringBuffer();
  await for (final chunk in response.transform(utf8.decoder)) {
    buffer.write(chunk);
  }
  return Map<String, dynamic>.from(jsonDecode(buffer.toString()));
}

Future<void> _post(String path, Map<String, dynamic> body,
    {String? token, String? key}) async {
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

Future<void> signIn(WidgetTester tester) async {
  const email = 'seed.dev@draughtsarena.net';
  const password = 'Draughts@Dev2026';
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

Future<String> loginToken(String email, String password) async {
  final client = HttpClient();
  try {
    final request =
        await client.postUrl(Uri.parse('$_base/auth/login'));
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

const parkSeconds = int.fromEnvironment('PARK_SECONDS', defaultValue: 0);
const readytap = int.fromEnvironment('READYTAP', defaultValue: 0);

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
    'Challenge drive: seed sends challenge, p2 joins via API, seed advances to ready',
    (tester) async {
      app.main();
      await tester.pump(const Duration(seconds: 3));
      await signIn(tester);

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
          final texts = find
              .byType(Text)
              .evaluate()
              .map((e) => (e.widget as Text).data)
              .whereType<String>()
              .toSet()
              .toList()
            ..sort();
          // ignore: avoid_print
          print('VISIBLE-TEXTS@create: $texts');
          fail('CHALLENGE SENT never appeared');
        }
        await tester.pump(const Duration(milliseconds: 500));
      }

      // The invitee funds the match through the real API; the inviter's
      // sent screen polls and should advance to the ready check.
      final p2Token = await loginToken(
        'p2.arena+1790254924343@draughtsarena.net',
        'Arena-Match-P2-77!',
      );
      final challenge = await getPendingChallenge(p2Token);
      expect(challenge, isNotNull,
          reason: 'p2 should see the pending challenge');
      final joinKey =
          'drive-join-${DateTime.now().millisecondsSinceEpoch}';
      await _post('/matches/${challenge!['matchId']}/join',
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

      if (readytap > 0) {
        await tester.tap(find.text('I am ready'));
        await tester.pump(const Duration(seconds: 2));
        final waitDeadline = DateTime.now().add(const Duration(seconds: 20));
        while (find.text('WAITING FOR OPPONENT').evaluate().isEmpty &&
            DateTime.now().isBefore(waitDeadline)) {
          await tester.pump(const Duration(seconds: 1));
        }
        expect(
          find.text('WAITING FOR OPPONENT').evaluate(),
          isNotEmpty,
          reason: 'tapping I am ready should land on the waiting-for-opponent screen',
        );
        logVisible(tester, 'WAITING FOR OPPONENT parked');
      } else {
        logVisible(tester, 'READY CHECK parked');
      }
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