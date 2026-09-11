import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:draughts_arena/screens/match_screen.dart';
import 'package:draughts_arena/providers/match_provider.dart';
import 'package:draughts_arena/models/game_state.dart';
import 'package:draughts_arena/models/match_flow.dart';
import 'package:draughts_arena/services/socket_service.dart';
import 'package:dio/dio.dart';
import 'package:mocktail/mocktail.dart';

class MockSocketService extends Mock implements SocketService {}

class MockDio extends Mock implements Dio {}

class TestMatchNotifier extends MatchNotifier {
  TestMatchNotifier(super.socketService, super.dio);

  @override
  Future<void> fetchGameState(String matchId) async {
    // do nothing to prevent connectivity_plus from overriding state
  }
}

void main() {
  testWidgets(
    'MatchScreen resyncs after a version rejection without blind retry',
    (WidgetTester tester) async {
      final mockSocketService = MockSocketService();
      final mockDio = MockDio();

      // Setup socket streams
      final moveRejectedController =
          StreamController<Map<String, dynamic>>.broadcast();
      final matchEndedController =
          StreamController<Map<String, dynamic>>.broadcast();
      when(
        () => mockSocketService.onMoveRejected,
      ).thenAnswer((_) => moveRejectedController.stream);
      when(
        () => mockSocketService.onGameState,
      ).thenAnswer((_) => const Stream.empty());
      when(
        () => mockSocketService.onMatchFound,
      ).thenAnswer((_) => const Stream.empty());
      when(
        () => mockSocketService.onMoveApplied,
      ).thenAnswer((_) => const Stream.empty());
      when(
        () => mockSocketService.onCalloutCreated,
      ).thenAnswer((_) => const Stream.empty());
      when(
        () => mockSocketService.onOpponentDisconnected,
      ).thenAnswer((_) => const Stream.empty());
      when(
        () => mockSocketService.onOpponentReconnected,
      ).thenAnswer((_) => const Stream.empty());
      when(
        () => mockSocketService.onMatchEndedResign,
      ).thenAnswer((_) => const Stream.empty());
      when(
        () => mockSocketService.onMatchEnded,
      ).thenAnswer((_) => matchEndedController.stream);
      when(
        () => mockSocketService.attemptMove(any(), any(), any()),
      ).thenReturn(null);

      final realNotifier = TestMatchNotifier(mockSocketService, mockDio);

      final mockGameState = GameState(
        board: List.filled(50, 0),
        currentTurn: 'WHITE',
        player1: 'uuid-1',
        player2: 'uuid-2',
        status: 'in_progress',
        moveCount: 0,
        consecutiveKingMoves: 0,
        legalMoves: [const LegalMove(from: 33, to: 28)],
      );

      // Initial state: synced
      realNotifier.state = realNotifier.state.copyWith(
        currentMatchId: 'test-match',
        gameState: mockGameState,
        syncState: MatchSyncState.synced,
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [matchProvider.overrideWith((ref) => realNotifier)],
          child: const MaterialApp(home: MatchScreen(matchId: 'test-match')),
        ),
      );

      // Board should be visible, no syncing indicator
      expect(
        find.byWidgetPredicate(
          (widget) => widget is CustomPaint && widget.painter is BoardPainter,
        ),
        findsOneWidget,
      );
      expect(find.text('Syncing...'), findsNothing);

      // 1. User attempts a move
      realNotifier.attemptMove(33, 28);

      // 2. Simulate first rejection (version mismatch, server busy)
      moveRejectedController.add({'reason': 'server_busy'});
      await tester.pump();

      expect(realNotifier.state.syncState, MatchSyncState.syncing);
      verify(
        () => mockSocketService.attemptMove('test-match', 33, 28),
      ).called(1);

      // Settlement truth is accepted only from the existing server event.
      matchEndedController.add({
        'winnerId': 'uuid-1',
        'payout': '390000',
        'reason': 'capture',
      });
      await tester.pump();

      expect(realNotifier.state.gameState?.status, 'completed');
      expect(realNotifier.state.gameState?.winnerId, 'uuid-1');
      expect(realNotifier.state.settlementPhase, SettlementPhase.confirmed);
      expect(realNotifier.state.confirmedPayoutMinorUnits, 390000);
    },
  );
}
