import 'package:draughts_arena/models/match_flow.dart';
import 'package:draughts_arena/screens/match_lifecycle_screens.dart';
import 'package:draughts_arena/screens/player_discovery_screens.dart';
import 'package:draughts_arena/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'match_lifecycle_test.dart';

const _captureKey = ValueKey('match-lifecycle-capture');

void _setViewport(WidgetTester tester) {
  tester.view.physicalSize = const Size(412, 915);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

Widget _capture(Widget child) => ProviderScope(
  child: MaterialApp(
    theme: AppTheme.dark,
    home: child,
    builder: (context, child) => RepaintBoundary(
      key: _captureKey,
      child: child ?? const SizedBox.shrink(),
    ),
  ),
);

Future<void> _verify(WidgetTester tester, String name) async {
  await tester.pump();
  if (name == '36_insufficient_balance' ||
      name == '37_stake_limit' ||
      name == '43_opponent_disconnected') {
    final asset = switch (name) {
      '36_insufficient_balance' =>
        'assets/images/match_insufficient_wallet.png',
      '37_stake_limit' => 'assets/images/match_stake_limit.png',
      _ => 'assets/images/match_opponent_disconnected.png',
    };
    await tester.runAsync(() async {
      await precacheImage(
        AssetImage(asset),
        tester.element(find.byKey(_captureKey)),
      );
    });
  }
  await tester.pump(const Duration(milliseconds: 180));
  expect(tester.takeException(), isNull);
  await expectLater(
    find.byKey(_captureKey),
    matchesGoldenFile('goldens/match_lifecycle/$name.png'),
  );
}

void main() {
  setUpAll(() async {
    final inter = FontLoader('Inter')
      ..addFont(rootBundle.load('assets/fonts/Inter-Variable.ttf'));
    final sora = FontLoader('Sora')
      ..addFont(rootBundle.load('assets/fonts/Sora-Variable.ttf'));
    final lucide = FontLoader('packages/lucide_icons_flutter/Lucide')
      ..addFont(
        rootBundle.load('packages/lucide_icons_flutter/assets/lucide.ttf'),
      );
    await Future.wait([inter.load(), sora.load(), lucide.load()]);
  });

  final screens = <String, Widget>{
    '31_player_search': const PlayerSearchScreen(
      players: [
        lifecycleOpponent,
        MatchPlayer(
          id: 'player-3',
          name: 'QueenBee',
          avatarId: 'avatar_07',
          rank: 'PRO',
          rating: 1620,
          winRate: 65,
        ),
        MatchPlayer(
          id: 'player-4',
          name: 'BlackKing',
          avatarId: 'avatar_10',
          rank: 'AMATEUR',
          rating: 980,
          winRate: 52,
        ),
      ],
    ),
    '32_public_profile': const PublicPlayerProfileScreen(
      player: lifecycleOpponent,
    ),
    '33_open_match_details': const OpenMatchDetailsScreen(
      match: OpenMatch(
        id: 'callout-1',
        host: lifecycleOpponent,
        terms: lifecycleTerms,
      ),
    ),
    '35_match_unavailable': const MatchUnavailableScreen(),
    '36_insufficient_balance': InsufficientBalanceScreen(
      snapshot: lifecycleSnapshot(MatchLifecyclePhase.insufficientBalance),
    ),
    '37_stake_limit': StakeEligibilityBlockedScreen(
      snapshot: lifecycleSnapshot(MatchLifecyclePhase.eligibilityBlocked),
    ),
    '38_locking_stake': LockingStakeScreen(
      snapshot: lifecycleSnapshot(MatchLifecyclePhase.lockingStake),
    ),
    '39_waiting_opponent_stake': WaitingOpponentStakeScreen(
      snapshot: lifecycleSnapshot(MatchLifecyclePhase.waitingOpponentStake),
    ),
    '40_ready_check': ReadyCheckScreen(
      snapshot: lifecycleSnapshot(MatchLifecyclePhase.readyCheck),
      onReady: () async {},
    ),
    '41_waiting_opponent_ready': WaitingOpponentReadyScreen(
      snapshot: lifecycleSnapshot(MatchLifecyclePhase.waitingOpponentReady),
    ),
    '42_ready_timeout': ReadyTimeoutScreen(
      snapshot: lifecycleSnapshot(MatchLifecyclePhase.readyTimeout),
    ),
    '43_opponent_disconnected': OpponentDisconnectedBeforeStartScreen(
      snapshot: lifecycleSnapshot(MatchLifecyclePhase.opponentDisconnected),
    ),
    'private_room_code': PrivateRoomCodeScreen(
      snapshot: lifecycleSnapshot(MatchLifecyclePhase.privateRoom),
    ),
    'incoming_challenge': ChallengeStatusScreen(
      snapshot: lifecycleSnapshot(MatchLifecyclePhase.incomingChallenge),
      onAccept: () async {},
      onDecline: () async {},
    ),
    'challenge_sent': ChallengeStatusScreen(
      snapshot: lifecycleSnapshot(MatchLifecyclePhase.challengeSent),
    ),
    'challenge_expired': ChallengeStatusScreen(
      snapshot: lifecycleSnapshot(MatchLifecyclePhase.challengeExpired),
    ),
  };

  for (final entry in screens.entries) {
    testWidgets('capture ${entry.key}', (tester) async {
      _setViewport(tester);
      await tester.pumpWidget(_capture(entry.value));
      await _verify(tester, entry.key);
    });
  }
}
