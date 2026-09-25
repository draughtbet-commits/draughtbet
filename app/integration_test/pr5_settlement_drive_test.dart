import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:draughts_arena/main.dart' as app;
import 'package:draughts_arena/models/match_flow.dart';
import 'package:draughts_arena/router/app_router.dart';

const _base = 'http://10.0.2.2:3000/api/v1';

const targetEmail = 'seed.dev@draughtsarena.net';
const targetPassword = 'Draughts@Dev2026';

// Per-screen park so each terminal screen can be recorded. Override with
// PARK_SECONDS to hold every route for that long.
const parkSeconds = int.fromEnvironment('PARK_SECONDS', defaultValue: 0);
const _holdPerRoute = Duration(seconds: 40);

const _targetLabel = 'seed.dev@draughtsarena.net';

const _settlementScreenTypes = [
  SettlementStatusScreen,
  MatchReceiptScreen,
  MatchResultScreen,
];

void logVisible(WidgetTester tester, String tag) {
  final texts = <String>{};
  for (final w in tester.allWidgets) {
    if (w is Text && w.data != null && w.data!.isNotEmpty) {
      texts.add(w.data!);
    }
  }
  final counts = <String>[];
  for (final type in _settlementScreenTypes) {
    counts.add('${type.toString()}:${tester.widgetList(find.byType(type)).length}');
  }
  final hittable = <String>[];
  for (final type in _settlementScreenTypes) {
    hittable.add('${type.toString()}:${tester.hitTestable(find.byType(type)).evaluate().length}');
  }
  // ignore: avoid_print
  print('=== $tag mounted[$counts] hittable[$hittable]');
  // ignore: avoid_print
  print('=== $tag visible text: ${texts.toList()..sort()}');
}

Future<String> _readBody(HttpClientRequest request) async {
  final response = await request.close();
  final body = await response.transform(utf8.decoder).join();
  return body;
}

Future<String> loginToken() async {
  final client = HttpClient();
  try {
    final request = await client.postUrl(Uri.parse('$_base/auth/login'));
    request.headers.contentType = ContentType.json;
    request.write(jsonEncode({
      'email': targetEmail,
      'password': targetPassword,
    }));
    final json = jsonDecode(await _readBody(request)) as Map<String, dynamic>;
    return ((json['data']?['accessToken'] ?? json['accessToken']) as String?) ?? '';
  } finally {
    client.close();
  }
}

/// Returns a real SETTLED match id (with my outcome and payout) so the drive
/// parks on live server state instead of a fabricated snapshot.
Future<Map<String, dynamic>?> firstSettledMatch(String token) async {
  final client = HttpClient();
  try {
    final request = await client.getUrl(Uri.parse('$_base/me/matches'));
    request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
    final json = jsonDecode(await _readBody(request)) as Map<String, dynamic>;
    final items = (json['data'] ?? const []) as List;
    for (final item in items.whereType<Map>()) {
      final m = Map<String, dynamic>.from(item);
      if (m['status'] == 'SETTLED') return m;
    }
    return null;
  } finally {
    client.close();
  }
}

MatchResultViewData resultViewFor(Map<String, dynamic> match) {
  final outcome = match['outcome']?.toString();
  final kind = switch (outcome) {
    'WON' => ResultKind.victory,
    'DRAW' => ResultKind.draw,
    _ => ResultKind.defeat,
  };
  return MatchResultViewData(
    kind: kind,
    opponent: const MatchPlayer(
      id: 'opponent',
      name: 'Opponent',
      avatarId: 'avatar_04',
    ),
    matchId: match['id']?.toString(),
    reason: 'Result confirmed by server',
    serverVerified: true,
    payoutMinorUnits: int.tryParse(match['payoutMinor']?.toString() ?? ''),
  );
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'PR5 settlement drive: all four settlement/receipt routes',
    (tester) async {
      app.main();
      await tester.pump(const Duration(seconds: 3));

      // Sign in through the real UI so the session + profile are live, which
      // the receipt gateway needs to select the viewer's own receipt row.
      final loginDeadline = DateTime.now().add(const Duration(minutes: 2));
      while (find.text('Arena').evaluate().isEmpty) {
        if (DateTime.now().isAfter(loginDeadline)) {
          logVisible(tester, 'TIMEOUT: never reached Home');
          fail('Timed out reaching the Home bottom nav');
        }
        await tester.pump(const Duration(milliseconds: 500));
        final fields = find.byType(TextFormField);
        if (fields.evaluate().length >= 2) {
          await tester.enterText(fields.at(0), targetEmail);
          await tester.pump(const Duration(milliseconds: 200));
          await tester.enterText(fields.at(1), targetPassword);
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

      final token = await loginToken();
      final match = await firstSettledMatch(token);
      if (match == null) {
        fail('No SETTLED match in $_targetLabel history to park on');
      }
      final matchId = match['id'].toString();
      // ignore: avoid_print
      print('=== real settled match for recording: $matchId outcome=${match['outcome']} payoutMinor=${match['payoutMinor']}');

      final navCtx = tester.element(find.byType(Navigator).first);
      final router = ProviderScope.containerOf(navCtx).read(appRouterProvider);
      final result = resultViewFor(match);

      Future<void> park(String label) async {
        logVisible(tester, label);
        final hold = parkSeconds > 0
            ? Duration(seconds: parkSeconds)
            : _holdPerRoute;
        final until = DateTime.now().add(hold);
        while (DateTime.now().isBefore(until)) {
          await tester.pump(const Duration(seconds: 3));
        }
      }

      // 1. Settlement processing (pending)
      router.go('/matches/$matchId/settlement-processing', extra: result);
      await tester.pump(const Duration(seconds: 3));
      await park('SETTLEMENT PROCESSING');

      // 2. Settlement complete (confirmed)
      router.go('/matches/$matchId/settlement-complete', extra: result);
      await tester.pump(const Duration(seconds: 3));
      await park('SETTLEMENT COMPLETE');

      // 3. Settlement delayed
      router.go('/matches/$matchId/settlement-delayed', extra: result);
      await tester.pump(const Duration(seconds: 3));
      await park('SETTLEMENT DELAYED');

      // 4. Receipt — loads the real server receipt for the parked match.
      router.go('/matches/$matchId/receipt', extra: result);
      await tester.pump(const Duration(seconds: 3));
      await park('MATCH RECEIPT');
    },
    timeout: const Timeout(Duration(minutes: 9)),
  );
}