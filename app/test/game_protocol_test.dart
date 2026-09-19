import 'dart:async';

import 'package:dio/dio.dart';
import 'package:draughts_arena/models/game_protocol.dart';
import 'package:draughts_arena/models/game_state.dart';
import 'package:draughts_arena/providers/match_provider.dart';
import 'package:draughts_arena/screens/game_move_history_screen.dart';
import 'package:draughts_arena/screens/match_screen.dart';
import 'package:draughts_arena/services/socket_service.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

class ProtocolSocket extends SocketService {
  final gameState = StreamController<Map<String, dynamic>>.broadcast();
  final moveApplied = StreamController<Map<String, dynamic>>.broadcast();
  final moveRejected = StreamController<Map<String, dynamic>>.broadcast();
  final drawOffer = StreamController<Map<String, dynamic>>.broadcast();
  final drawResponse = StreamController<Map<String, dynamic>>.broadcast();

  Map<String, dynamic>? v2Move;
  List<Object?>? legacyMove;
  Map<String, dynamic>? drawAction;
  Map<String, dynamic>? drawReply;
  Map<String, dynamic>? resignAction;

  @override
  Stream<Map<String, dynamic>> get onGameState => gameState.stream;
  @override
  Stream<Map<String, dynamic>> get onMoveApplied => moveApplied.stream;
  @override
  Stream<Map<String, dynamic>> get onMoveRejected => moveRejected.stream;
  @override
  Stream<Map<String, dynamic>> get onDrawOffer => drawOffer.stream;
  @override
  Stream<Map<String, dynamic>> get onDrawResponse => drawResponse.stream;
  @override
  Stream<Map<String, dynamic>> get onMatchFound => const Stream.empty();
  @override
  Stream<Map<String, dynamic>> get onCalloutCreated => const Stream.empty();
  @override
  Stream<Map<String, dynamic>> get onOpponentDisconnected =>
      const Stream.empty();
  @override
  Stream<Map<String, dynamic>> get onOpponentReconnected =>
      const Stream.empty();
  @override
  Stream<Map<String, dynamic>> get onMatchEndedResign => const Stream.empty();
  @override
  Stream<Map<String, dynamic>> get onMatchEnded => const Stream.empty();

  @override
  void joinMatch(String matchId) {}

  @override
  void attemptMove(String matchId, int from, int to) {
    legacyMove = [matchId, from, to];
  }

  @override
  void submitMoveV2({
    required String matchId,
    required String clientMoveId,
    required int expectedStateVersion,
    required int from,
    required List<int> path,
  }) {
    v2Move = {
      'matchId': matchId,
      'clientMoveId': clientMoveId,
      'expectedStateVersion': expectedStateVersion,
      'from': from,
      'path': path,
    };
  }

  @override
  void offerDraw({
    required String matchId,
    required String actionId,
    required int expectedStateVersion,
  }) {
    drawAction = {
      'matchId': matchId,
      'actionId': actionId,
      'expectedStateVersion': expectedStateVersion,
    };
  }

  @override
  void respondToDraw({
    required String matchId,
    required String actionId,
    required String offerId,
    required String response,
  }) {
    drawReply = {
      'matchId': matchId,
      'actionId': actionId,
      'offerId': offerId,
      'response': response,
    };
  }

  @override
  void resignV2({
    required String matchId,
    required String actionId,
    required int expectedStateVersion,
  }) {
    resignAction = {
      'matchId': matchId,
      'actionId': actionId,
      'expectedStateVersion': expectedStateVersion,
    };
  }

  @override
  void dispose() {
    gameState.close();
    moveApplied.close();
    moveRejected.close();
    drawOffer.close();
    drawResponse.close();
    super.dispose();
  }
}

class ProtocolNotifier extends MatchNotifier {
  ProtocolNotifier(super.socket, super.dio);

  int fetchCount = 0;

  @override
  Future<void> fetchGameState(String matchId) async {
    fetchCount += 1;
  }
}

GameState game({
  int protocolVersion = 2,
  List<LegalMove> legalMoves = const [],
}) => GameState(
  board: List.filled(50, 0),
  currentTurn: 'WHITE',
  player1: 'player-one',
  player2: 'player-two',
  status: 'in_progress',
  moveCount: 4,
  consecutiveKingMoves: 0,
  protocolVersion: protocolVersion,
  stateVersion: 12,
  legalMoves: legalMoves,
);

void main() {
  test('canonical V2 state parses paths, versions and accepted move log', () {
    final parsed = GameState.fromJson({
      'board': List.filled(50, 0),
      'sideToMove': 'BLACK',
      'players': {'light': 'one', 'dark': 'two'},
      'status': 'in_progress',
      'protocolVersion': 2,
      'stateVersion': 8,
      'legalMoves': [
        {
          'from': 31,
          'to': 13,
          'path': [22, 13],
          'captures': [27, 18],
        },
      ],
      'acceptedMoves': [
        {
          'sequence': 1,
          'clientMoveId': 'move-1',
          'move': {
            'from': 31,
            'path': [22, 13],
          },
          'captures': [27, 18],
          'stateVersion': 8,
        },
      ],
    });

    expect(parsed.currentTurn, 'BLACK');
    expect(parsed.stateVersion, 8);
    expect(parsed.legalMoves.single.path, [22, 13]);
    expect(parsed.legalMoves.single.capturedSquares, [27, 18]);
    expect(parsed.moveHistory.single.clientMoveId, 'move-1');
  });

  test('stable server rejection codes map to safe player copy', () {
    final conflict = MoveRejection.fromServer({
      'code': 'STATE_VERSION_CONFLICT',
      'stateVersion': 20,
    });
    final capture = MoveRejection.fromServer({
      'code': 'MANDATORY_CAPTURE_REQUIRED',
    });

    expect(conflict.requiresResync, isTrue);
    expect(conflict.title, 'STATE RESYNC');
    expect(capture.requiresResync, isFalse);
    expect(capture.message, contains('capture is available'));
  });

  test('V2 move sends full path once and never applies a board locally', () {
    final socket = ProtocolSocket();
    final notifier = ProtocolNotifier(socket, Dio());
    notifier.state = notifier.state.copyWith(
      currentMatchId: 'match-8',
      gameState: game(),
    );

    notifier.attemptMove(31, 13, path: [22, 13]);
    final firstId = socket.v2Move?['clientMoveId'];
    notifier.attemptMove(31, 13, path: [22, 13]);

    expect(socket.v2Move?['expectedStateVersion'], 12);
    expect(socket.v2Move?['path'], [22, 13]);
    expect(firstId, isNotEmpty);
    expect(notifier.state.isMovePending, isTrue);
    expect(notifier.state.gameState?.board, everyElement(0));
  });

  test('V1 move stays on the legacy command during migration', () {
    final socket = ProtocolSocket();
    final notifier = ProtocolNotifier(socket, Dio());
    notifier.state = notifier.state.copyWith(
      currentMatchId: 'legacy-match',
      gameState: game(protocolVersion: 1),
    );

    notifier.attemptMove(33, 28);

    expect(socket.legacyMove, ['legacy-match', 33, 28]);
    expect(socket.v2Move, isNull);
  });

  test(
    'stale rejection forces canonical resync without retrying move',
    () async {
      final socket = ProtocolSocket();
      final notifier = ProtocolNotifier(socket, Dio());
      notifier.state = notifier.state.copyWith(
        currentMatchId: 'match-8',
        gameState: game(),
      );
      notifier.attemptMove(31, 13, path: [22, 13]);
      final firstId = socket.v2Move?['clientMoveId'];

      socket.moveRejected.add({
        'code': 'STATE_VERSION_CONFLICT',
        'clientMoveId': firstId,
        'stateVersion': 13,
      });
      await Future<void>.delayed(Duration.zero);

      expect(notifier.fetchCount, 1);
      expect(notifier.state.syncState, MatchSyncState.syncing);
      expect(socket.v2Move?['clientMoveId'], firstId);
    },
  );

  test(
    'draw and resign actions use server state and block duplicates',
    () async {
      final socket = ProtocolSocket();
      final notifier = ProtocolNotifier(socket, Dio());
      notifier.state = notifier.state.copyWith(
        currentMatchId: 'match-8',
        gameState: game(),
      );

      expect(notifier.offerDraw(), isTrue);
      expect(notifier.offerDraw(), isFalse);
      expect(socket.drawAction?['expectedStateVersion'], 12);

      socket.drawOffer.add({'offerId': 'offer-2', 'opponentName': 'KingMoves'});
      await Future<void>.delayed(Duration.zero);
      notifier.respondToDraw(false);
      expect(socket.drawReply?['offerId'], 'offer-2');
      expect(socket.drawReply?['response'], 'rejected');

      notifier.resign();
      notifier.resign();
      expect(socket.resignAction?['expectedStateVersion'], 12);
      expect(notifier.state.resignPending, isTrue);
    },
  );

  test(
    'canonical state replaces local state and invalid data resyncs',
    () async {
      final socket = ProtocolSocket();
      final notifier = ProtocolNotifier(socket, Dio());
      notifier.state = notifier.state.copyWith(
        currentMatchId: 'match-8',
        gameState: game(),
      );
      final canonicalBoard = List<int>.filled(50, 0)..[18] = 2;

      socket.gameState.add({
        'board': canonicalBoard,
        'sideToMove': 'BLACK',
        'players': {'light': 'player-one', 'dark': 'player-two'},
        'status': 'in_progress',
        'stateVersion': 13,
        'legalMoves': const <dynamic>[],
      });
      await Future<void>.delayed(Duration.zero);

      expect(notifier.state.gameState?.board, canonicalBoard);
      expect(notifier.state.gameState?.protocolVersion, 2);
      expect(notifier.state.gameState?.stateVersion, 13);

      socket.gameState.add({'stateVersion': 14});
      await Future<void>.delayed(Duration.zero);
      expect(notifier.fetchCount, 1);
      expect(notifier.state.syncState, MatchSyncState.syncing);
    },
  );

  testWidgets('approved protocol overlays fit a small screen', (tester) async {
    tester.view.physicalSize = const Size(320, 568);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final socket = ProtocolSocket();
    final notifier = ProtocolNotifier(socket, Dio());
    notifier.state = notifier.state.copyWith(
      currentMatchId: 'match-8',
      gameState: game(
        legalMoves: const [
          LegalMove(
            from: 31,
            to: 13,
            path: [22, 13],
            capturedSquares: [27, 18],
          ),
        ],
      ),
      incomingDrawOffer: const DrawOffer(
        offerId: 'offer-2',
        opponentName: 'KingMoves',
      ),
    );

    await tester.pumpWidget(
      ProviderScope(
        overrides: [matchProvider.overrideWith((ref) => notifier)],
        child: const MaterialApp(home: MatchScreen(matchId: 'match-8')),
      ),
    );
    await tester.pump();

    expect(find.text('DRAW OFFER RECEIVED'), findsOneWidget);
    expect(find.text('Accept draw'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('Move History renders only server-confirmed accepted moves', (
    tester,
  ) async {
    await tester.pumpWidget(
      const ProviderScope(
        child: MaterialApp(
          home: GameMoveHistoryScreen(
            matchId: 'match-8',
            autoLoad: false,
            initialMoves: [
              AcceptedGameMove(
                sequence: 1,
                clientMoveId: 'accepted-1',
                from: 31,
                path: [22, 13],
                capturedSquares: [27, 18],
                promoted: true,
                stateVersion: 8,
              ),
            ],
          ),
        ),
      ),
    );

    expect(find.text('MOVE HISTORY'), findsOneWidget);
    expect(find.text('32–14'), findsOneWidget);
    expect(find.textContaining('payout'), findsNothing);
  });
}
