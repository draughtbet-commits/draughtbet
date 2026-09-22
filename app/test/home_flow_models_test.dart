import 'dart:async';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:draughts_arena/models/game_state.dart';
import 'package:draughts_arena/models/match_flow.dart';
import 'package:draughts_arena/providers/match_flow_provider.dart';
import 'package:draughts_arena/services/match_flow_gateway.dart';

class BlockingGateway extends MatchFlowGateway {
  BlockingGateway() : super(Dio());

  final completer = Completer<String?>();
  int createCalls = 0;

  @override
  Future<String?> createOpenMatch(MatchTerms terms) {
    createCalls += 1;
    return completer.future;
  }
}

void main() {
  test('Money formats integer minor units without floating-point state', () {
    expect(Money(200000).format(), contains('2,000'));
    expect(Money(390000).format(), contains('3,900'));
    expect(Money(10005).format(), contains('100.05'));
    expect(Money(200000).format(showKobo: true), '₦2,000.00');
    expect(Money(-10005).format(), '-₦100.05');
  });

  test('GameState normalizes the current REST players contract', () {
    final state = GameState.fromJson({
      'board': List<int>.filled(50, 0),
      'currentTurn': 'WHITE',
      'players': {'light': 'player-1', 'dark': 'player-2'},
      'status': 'in_progress',
      'moveCount': 3,
      'legalMoves': const [],
    });

    expect(state.player1, 'player-1');
    expect(state.player2, 'player-2');
    expect(state.consecutiveKingMoves, 0);
  });

  test(
    'confirmation guard prevents duplicate state-changing requests',
    () async {
      final gateway = BlockingGateway();
      final notifier = MatchFlowNotifier(gateway);
      notifier.review(
        const MatchFlowIntent(
          kind: MatchEntryKind.created,
          terms: MatchTerms(stakeMinorUnits: 200000),
        ),
      );

      final first = notifier.confirm();
      final second = await notifier.confirm();
      expect(second, isNull);
      expect(gateway.createCalls, 1);

      gateway.completer.complete('callout-1');
      expect(await first, 'callout-1');
      expect(notifier.state.actionPhase, MatchActionPhase.succeeded);
    },
  );
}
