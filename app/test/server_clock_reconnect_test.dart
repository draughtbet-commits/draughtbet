import 'dart:async';

import 'package:dio/dio.dart';
import 'package:draughts_arena/config/backend_contract.dart';
import 'package:draughts_arena/models/game_state.dart';
import 'package:draughts_arena/providers/match_provider.dart';
import 'package:draughts_arena/screens/match_screen.dart';
import 'package:draughts_arena/services/socket_service.dart';
import 'package:draughts_arena/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'home_flow_screens_test.dart' as fixtures;

class Pr9Socket extends SocketService {
  Pr9Socket()
    : super(contract: const BackendContractConfig(BackendContractMode.v2));

  final clocks = StreamController<Map<String, dynamic>>.broadcast();
  final states = StreamController<Map<String, dynamic>>.broadcast();
  final phases = StreamController<SocketConnectionPhase>.broadcast();
  final disconnected = StreamController<Map<String, dynamic>>.broadcast();
  final reconnected = StreamController<Map<String, dynamic>>.broadcast();
  final List<String> joined = [];
  final List<String> clockRequests = [];
  int reconnectCalls = 0;

  @override
  Stream<Map<String, dynamic>> get onClockSync => clocks.stream;
  @override
  Stream<Map<String, dynamic>> get onGameState => states.stream;
  @override
  Stream<SocketConnectionPhase> get onConnectionPhase => phases.stream;
  @override
  Stream<Map<String, dynamic>> get onOpponentDisconnected =>
      disconnected.stream;
  @override
  Stream<Map<String, dynamic>> get onOpponentReconnected => reconnected.stream;

  @override
  void joinMatch(String matchId) => joined.add(matchId);
  @override
  void requestClockSync(String matchId) => clockRequests.add(matchId);
  @override
  Future<void> reconnect() async => reconnectCalls += 1;
}

GameState _game() => GameState(
  board: List<int>.filled(50, 0),
  currentTurn: 'WHITE',
  player1: 'player-1',
  player2: 'player-2',
  status: 'in_progress',
  moveCount: 0,
  consecutiveKingMoves: 0,
  protocolVersion: 2,
  stateVersion: 4,
  legalMoves: const [LegalMove(from: 31, to: 26)],
);

Map<String, dynamic> _canonicalState() => {
  'matchId': 'match-9',
  'board': List<int>.filled(50, 0),
  'currentTurn': 'WHITE',
  'currentTurnUserId': 'player-1',
  'status': 'in_progress',
  'stateVersion': 5,
  'legalMoves': [
    {
      'from': 31,
      'to': 26,
      'path': [26],
    },
  ],
};

Widget _app(MatchState state) => ProviderScope(
  key: UniqueKey(),
  overrides: [
    matchProvider.overrideWith((ref) => fixtures.StaticMatchNotifier(state)),
  ],
  child: MaterialApp(
    theme: AppTheme.dark,
    home: const MatchScreen(matchId: 'match-9'),
  ),
);

void main() {
  test(
    'flat Backend V2 clock snapshot is accepted without client authority',
    () {
      final snapshot = ServerClockSnapshot.tryFromServer({
        'matchId': 'match-9',
        'serverNowMs': 100000,
        'deadlineAt': 109500,
        'remainingMs': 9500,
        'currentTurnUserId': 'player-1',
        'version': 8,
      });

      expect(snapshot?.remainingMs, 9500);
      expect(snapshot?.currentTurnUserId, 'player-1');
      expect(snapshot?.version, 8);
      expect(
        ServerClockSnapshot.tryFromServer({
          'matchId': 'match-9',
          'remainingMs': 9500,
        }),
        isNull,
      );
    },
  );

  test(
    'connection recovery requests canonical state and server clock',
    () async {
      final socket = Pr9Socket();
      final notifier = MatchNotifier(socket, Dio());
      notifier.state = notifier.state.copyWith(
        currentMatchId: 'match-9',
        gameState: _game(),
      );

      socket.phases.add(SocketConnectionPhase.disconnected);
      await Future<void>.delayed(Duration.zero);
      expect(notifier.state.recoveryPhase, MatchRecoveryPhase.connectionLost);
      expect(notifier.state.syncState, MatchSyncState.offline);

      socket.phases.add(SocketConnectionPhase.reconnecting);
      await Future<void>.delayed(Duration.zero);
      expect(notifier.state.recoveryPhase, MatchRecoveryPhase.reconnecting);

      socket.phases.add(SocketConnectionPhase.connected);
      await Future<void>.delayed(Duration.zero);
      expect(notifier.state.recoveryPhase, MatchRecoveryPhase.resyncing);
      expect(socket.joined, contains('match-9'));
      expect(socket.clockRequests, contains('match-9'));

      socket.states.add(_canonicalState());
      await Future<void>.delayed(Duration.zero);
      expect(notifier.state.recoveryPhase, MatchRecoveryPhase.none);
      expect(notifier.state.syncState, MatchSyncState.synced);
      notifier.dispose();
    },
  );

  test('app resume cannot resume play before canonical state arrives', () {
    final socket = Pr9Socket();
    final notifier = MatchNotifier(socket, Dio());
    notifier.state = notifier.state.copyWith(
      currentMatchId: 'match-9',
      gameState: _game(),
    );

    notifier.handleAppResumed('match-9');
    expect(notifier.state.recoveryPhase, MatchRecoveryPhase.appResumed);
    expect(notifier.state.syncState, MatchSyncState.syncing);
    expect(socket.joined, ['match-9']);
    expect(socket.clockRequests, ['match-9']);
    notifier.dispose();
  });

  test(
    'opponent reconnect requires canonical resync before moves resume',
    () async {
      final socket = Pr9Socket();
      final notifier = MatchNotifier(socket, Dio());
      notifier.state = notifier.state.copyWith(
        currentMatchId: 'match-9',
        gameState: _game(),
        opponentConnected: false,
        opponentGracePeriodMs: 60000,
      );

      socket.reconnected.add({'userId': 'player-2'});
      await Future<void>.delayed(Duration.zero);

      expect(notifier.state.opponentConnected, isTrue);
      expect(notifier.state.syncState, MatchSyncState.syncing);
      expect(notifier.state.recoveryPhase, MatchRecoveryPhase.resyncing);
      expect(socket.joined, ['match-9']);
      expect(socket.clockRequests, ['match-9']);
      notifier.dispose();
    },
  );

  testWidgets('connection lost and reconnecting states cover the board', (
    tester,
  ) async {
    await tester.pumpWidget(
      _app(
        MatchState(
          currentMatchId: 'match-9',
          currentUserId: 'player-1',
          gameState: _game(),
          syncState: MatchSyncState.offline,
          recoveryPhase: MatchRecoveryPhase.connectionLost,
        ),
      ),
    );
    await tester.pump();
    expect(find.text('CONNECTION LOST'), findsOneWidget);
    expect(find.text('Retry connection'), findsOneWidget);

    await tester.pumpWidget(
      _app(
        MatchState(
          currentMatchId: 'match-9',
          currentUserId: 'player-1',
          gameState: _game(),
          syncState: MatchSyncState.syncing,
          recoveryPhase: MatchRecoveryPhase.reconnecting,
        ),
      ),
    );
    await tester.pump();
    expect(find.text('RECONNECTING'), findsOneWidget);
  });

  testWidgets('server zero state waits without declaring timeout locally', (
    tester,
  ) async {
    await tester.pumpWidget(
      _app(
        MatchState(
          currentMatchId: 'match-9',
          currentUserId: 'player-1',
          gameState: _game(),
          serverClock: const ServerClockSnapshot(
            matchId: 'match-9',
            serverNowMs: 100000,
            remainingMs: 0,
            currentTurnUserId: 'player-1',
          ),
          clockRevision: 1,
        ),
      ),
    );
    await tester.pump();
    expect(find.text('AWAITING SERVER RESULT'), findsOneWidget);
    expect(find.text('TIMEOUT'), findsNothing);
  });

  testWidgets('disconnect grace expiry waits for authoritative outcome', (
    tester,
  ) async {
    await tester.pumpWidget(
      _app(
        MatchState(
          currentMatchId: 'match-9',
          currentUserId: 'player-1',
          gameState: _game(),
          opponentConnected: false,
          opponentGracePeriodMs: 0,
          opponentDisconnectSequence: 1,
        ),
      ),
    );
    await tester.pump();
    expect(find.textContaining('Waiting for the server'), findsOneWidget);
    expect(find.text('VICTORY BY FORFEIT'), findsNothing);
  });

  testWidgets('reconnect overlay has no overflow on a small scaled screen', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(320, 568);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(
      MediaQuery(
        data: const MediaQueryData(
          size: Size(320, 568),
          textScaler: TextScaler.linear(1.25),
        ),
        child: _app(
          MatchState(
            currentMatchId: 'match-9',
            currentUserId: 'player-1',
            gameState: _game(),
            syncState: MatchSyncState.offline,
            recoveryPhase: MatchRecoveryPhase.connectionLost,
          ),
        ),
      ),
    );
    await tester.pump();
    expect(find.text('CONNECTION LOST'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
