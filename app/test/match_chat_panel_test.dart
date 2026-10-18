import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:draughts_arena/screens/match_screen.dart';
import 'package:draughts_arena/providers/match_provider.dart';
import 'package:draughts_arena/models/game_state.dart';
import 'package:draughts_arena/services/socket_service.dart';
import 'package:dio/dio.dart';
import 'package:mocktail/mocktail.dart';

class MockSocketService extends Mock implements SocketService {}

class MockDio extends Mock implements Dio {}

class TestMatchNotifier extends MatchNotifier {
  TestMatchNotifier(super.socketService, super.dio);

  @override
  Future<void> fetchGameState(String matchId) async {}
}

void main() {
  testWidgets('the Chat action opens the live panel and sends a message', (
    WidgetTester tester,
  ) async {
    final mockSocketService = MockSocketService();
    final mockDio = MockDio();
    final chatController = StreamController<Map<String, dynamic>>.broadcast();

    when(
      () => mockSocketService.onChatMessage,
    ).thenAnswer((_) => chatController.stream);
    when(() => mockSocketService.onGameState).thenAnswer((_) => const Stream.empty());
    when(() => mockSocketService.onMatchFound).thenAnswer((_) => const Stream.empty());
    when(() => mockSocketService.onMoveApplied).thenAnswer((_) => const Stream.empty());
    when(() => mockSocketService.onMoveRejected).thenAnswer((_) => const Stream.empty());
    when(() => mockSocketService.onCalloutCreated).thenAnswer((_) => const Stream.empty());
    when(() => mockSocketService.onOpponentDisconnected).thenAnswer((_) => const Stream.empty());
    when(() => mockSocketService.onOpponentReconnected).thenAnswer((_) => const Stream.empty());
    when(() => mockSocketService.onMatchEndedResign).thenAnswer((_) => const Stream.empty());
    when(() => mockSocketService.onMatchEnded).thenAnswer((_) => const Stream.empty());
    when(() => mockSocketService.onPreplayReleased).thenAnswer((_) => const Stream.empty());
    when(() => mockSocketService.onDrawOffer).thenAnswer((_) => const Stream.empty());
    when(() => mockSocketService.onDrawResponse).thenAnswer((_) => const Stream.empty());
    when(() => mockSocketService.onClockSync).thenAnswer((_) => const Stream.empty());
    when(() => mockSocketService.onError).thenAnswer((_) => const Stream.empty());
    when(() => mockSocketService.onSettlementCompleted).thenAnswer((_) => const Stream.empty());
    when(() => mockSocketService.onConnectionPhase).thenAnswer((_) => const Stream.empty());
    when(() => mockSocketService.isV2).thenReturn(true);
    when(
      () => mockSocketService.sendChatMessage(
        matchId: any(named: 'matchId'),
        actionId: any(named: 'actionId'),
        text: any(named: 'text'),
      ),
    ).thenReturn(null);

    final notifier = TestMatchNotifier(mockSocketService, mockDio);
    notifier.state = notifier.state.copyWith(
      currentMatchId: 'test-match',
      syncState: MatchSyncState.synced,
      gameState: GameState(
        board: List.filled(50, 0),
        currentTurn: 'WHITE',
        player1: 'uuid-1',
        player2: 'uuid-2',
        status: 'in_progress',
        moveCount: 0,
        consecutiveKingMoves: 0,
        protocolVersion: 2,
        legalMoves: const [LegalMove(from: 33, to: 28)],
      ),
    );

    await tester.pumpWidget(
      ProviderScope(
        overrides: [matchProvider.overrideWith((ref) => notifier)],
        child: const MaterialApp(home: MatchScreen(matchId: 'test-match')),
      ),
    );
    await tester.pump();

    final panelOpacity = find.byKey(const ValueKey('match-chat-animation'));
    expect(tester.widget<AnimatedOpacity>(panelOpacity).opacity, 0);

    // Open the panel from the Chat action.
    await tester.tap(find.text('Chat'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(tester.widget<AnimatedOpacity>(panelOpacity).opacity, 1);
    expect(find.text('Match chat'), findsOneWidget);

    // Send a message; the client must emit chat.send with the trimmed text.
    await tester.enterText(find.byType(TextField), '  hello there  ');
    await tester.pump();
    await tester.tap(find.byTooltip('Send'));
    await tester.pump();

    verify(
      () => mockSocketService.sendChatMessage(
        matchId: 'test-match',
        actionId: any(named: 'actionId'),
        text: 'hello there',
      ),
    ).called(1);

    // A fanned-out message renders as a bubble.
    chatController.add({
      'matchId': 'test-match',
      'messageId': 'c1',
      'senderId': 'uuid-2',
      'text': 'good luck',
      'sentAtMs': 1,
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('good luck'), findsOneWidget);

    await chatController.close();
  });
}
