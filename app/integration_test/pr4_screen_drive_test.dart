import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:draughts_arena/main.dart' as app;
import 'package:draughts_arena/models/match_flow.dart';
import 'package:draughts_arena/providers/profile_provider.dart';
import 'package:draughts_arena/router/app_router.dart';

const targetRoute = String.fromEnvironment('TARGET_ROUTE', defaultValue: '');
const targetEmail = String.fromEnvironment(
  'TARGET_EMAIL',
  defaultValue: 'seed.dev@draughtsarena.net',
);
const targetPassword = String.fromEnvironment(
  'TARGET_PASSWORD',
  defaultValue: 'Draughts@Dev2026',
);
const targetStakeMinor = int.fromEnvironment('TARGET_STAKEMINOR', defaultValue: 3000000);

const _base = 'http://10.0.2.2:3000/api/v1';

const _snapshotRoutes = {
  '/play/insufficient-balance',
  '/play/stake-limit',
  '/play/locking-stake',
  '/play/waiting-stake',
  '/play/ready',
  '/play/waiting-ready',
  '/play/ready-timeout',
  '/play/disconnected-before-start',
  '/play/private-room',
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

Future<String> _readJson(HttpClientRequest request) async {
  final response = await request.close();
  final body = await response.transform(utf8.decoder).join();
  return body;
}

Future<String> loginToken() async {
  final client = HttpClient();
  try {
    final request = await client.postUrl(
      Uri.parse('$_base/auth/login'),
    );
    request.headers.contentType = ContentType.json;
    request.write(jsonEncode({
      'email': targetEmail,
      'password': targetPassword,
    }));
    final json = jsonDecode(await _readJson(request)) as Map<String, dynamic>;
    return ((json['data']?['accessToken'] ?? json['accessToken']) as String?) ?? '';
  } finally {
    client.close();
  }
}

/// Creates a real `targetStakeMinor` open match as the logged-in user so the
/// parked snapshot carries truthful server terms (stake, time control, match id).
Future<String> createRealOpenMatch(String token) async {
  final client = HttpClient();
  try {
    final request = await client.postUrl(Uri.parse('$_base/matches'));
    request.headers.contentType = ContentType.json;
    request.headers.set(
      HttpHeaders.authorizationHeader,
      'Bearer $token',
    );
    request.headers.set(
      'Idempotency-Key',
      'drive-3m-${DateTime.now().millisecondsSinceEpoch}-$token.hashCode',
    );
    request.write(jsonEncode({
      'stakeMinor': targetStakeMinor,
      'timeControlSeconds': 600,
      'ruleset': 'INTERNATIONAL_10X10',
      'visibility': 'PUBLIC',
    }));
    final json = jsonDecode(await _readJson(request)) as Map<String, dynamic>;
    return (json['data']?['id'] as String?) ?? '';
  } finally {
    client.close();
  }
}

MatchLifecycleSnapshot snapshotFor(String route, String matchId, int balance) {
  final stake = targetStakeMinor;
  final fee = stake ~/ 10;
  final terms = MatchTerms(
    stakeMinorUnits: stake,
    opponentStakeMinorUnits: stake,
    platformFeeMinorUnits: fee,
    totalPrizeMinorUnits: stake * 2 - fee,
    timeControl: '10 minutes',
    gameType: 'Classic',
    board: '10×10 (International)',
    visibility: 'Anyone',
  );
  final phase = switch (route) {
    '/play/insufficient-balance' => MatchLifecyclePhase.insufficientBalance,
    '/play/stake-limit' => MatchLifecyclePhase.eligibilityBlocked,
    '/play/locking-stake' => MatchLifecyclePhase.lockingStake,
    '/play/waiting-stake' => MatchLifecyclePhase.waitingOpponentStake,
    '/play/ready' => MatchLifecyclePhase.readyCheck,
    '/play/waiting-ready' => MatchLifecyclePhase.waitingOpponentReady,
    '/play/ready-timeout' => MatchLifecyclePhase.readyTimeout,
    '/play/disconnected-before-start' =>
      MatchLifecyclePhase.opponentDisconnected,
    _ => MatchLifecyclePhase.privateRoom,
  };
  return MatchLifecycleSnapshot(
    phase: phase,
    matchId: matchId,
    terms: terms,
    availableBalanceMinorUnits: balance,
    limitMinorUnits: 10000000,
    roomCode: route == '/play/private-room' ? 'BETA-NGX4' : null,
    playerReady: AuthoritativeProgress.confirmed,
    opponentReady:
        route == '/play/ready' || route == '/play/ready-timeout'
        ? AuthoritativeProgress.confirmed
        : AuthoritativeProgress.pending,
    opponent: const MatchPlayer(
      id: 'a337afdc-0b1d-4d13-893d-41bd796441c6',
      name: 'p2arena',
      avatarId: 'avatar_04',
      rank: 'MASTER',
    ),
  );
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'PR4 screen drive: $targetRoute',
    (tester) async {
      app.main();
      await tester.pump(const Duration(seconds: 3));

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

      final navCtx = tester.element(find.byType(Navigator).first);
      final router = ProviderScope.containerOf(navCtx).read(appRouterProvider);

      final needsSnapshot = _snapshotRoutes.contains(targetRoute);
      if (needsSnapshot) {
        final balance =
            ProviderScope.containerOf(navCtx).read(profileProvider).profile
                ?.walletBalanceMinorUnits ??
            9750000;
        final token = await loginToken();
        final matchId = await createRealOpenMatch(token);
        // ignore: avoid_print
        print('=== real open match id for recording: $matchId');
        router.go(targetRoute, extra: snapshotFor(targetRoute, matchId, balance));
      } else {
        router.go(targetRoute);
      }
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