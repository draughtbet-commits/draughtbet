import 'dart:async';

import 'package:dio/dio.dart';
import 'package:draughts_arena/config/backend_contract.dart';
import 'package:draughts_arena/providers/match_provider.dart';
import 'package:draughts_arena/services/socket_service.dart';
import 'package:flutter_test/flutter_test.dart';

// Regression: the server told the opponent "connected" on every join, and this
// client answered that notification by requesting canonical state, which
// re-joins. Two players therefore dragged each other into an unbounded join
// loop that drained the 30/min match.join budget, after which no join was
// processed, presence was never recorded, and both players were stuck in the
// room with the entry action disabled.
class EchoSocket extends SocketService {
  EchoSocket()
    : super(contract: const BackendContractConfig(BackendContractMode.v2));

  final reconnected = StreamController<Map<String, dynamic>>.broadcast();
  final disconnected = StreamController<Map<String, dynamic>>.broadcast();
  final phases = StreamController<SocketConnectionPhase>.broadcast();
  final clocks = StreamController<Map<String, dynamic>>.broadcast();
  final states = StreamController<Map<String, dynamic>>.broadcast();
  final List<String> joined = [];
  final List<String> clockRequests = [];

  @override
  Stream<Map<String, dynamic>> get onOpponentReconnected => reconnected.stream;
  @override
  Stream<Map<String, dynamic>> get onOpponentDisconnected =>
      disconnected.stream;
  @override
  Stream<SocketConnectionPhase> get onConnectionPhase => phases.stream;
  @override
  Stream<Map<String, dynamic>> get onClockSync => clocks.stream;
  @override
  Stream<Map<String, dynamic>> get onGameState => states.stream;

  @override
  void joinMatch(String matchId) => joined.add(matchId);
  @override
  void requestClockSync(String matchId) => clockRequests.add(matchId);
}

MatchNotifier _seated(EchoSocket socket) {
  final notifier = MatchNotifier(socket, Dio());
  // Pre-play: no board projection exists yet.
  notifier.state = notifier.state.copyWith(
    currentMatchId: 'match-9',
    opponentConnected: true,
  );
  return notifier;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late EchoSocket socket;
  late MatchNotifier notifier;

  setUp(() {
    socket = EchoSocket();
    notifier = _seated(socket);
  });

  tearDown(() async {
    notifier.dispose();
    await socket.reconnected.close();
    await socket.disconnected.close();
    await socket.phases.close();
    await socket.clocks.close();
    await socket.states.close();
  });

  test('repeated presence echoes never re-join once the opponent is known', () async {
    for (var i = 0; i < 20; i += 1) {
      socket.reconnected.add({'userId': 'opponent', 'status': 'connected'});
      await Future<void>.delayed(Duration.zero);
    }

    expect(socket.joined, isEmpty);
    expect(socket.clockRequests, isEmpty);
  });

  test('the first genuine arrival resyncs exactly once', () async {
    notifier.state = notifier.state.copyWith(opponentConnected: false);

    socket.reconnected.add({'userId': 'opponent', 'status': 'connected'});
    await Future<void>.delayed(Duration.zero);

    expect(notifier.state.opponentConnected, isTrue);
    expect(socket.joined, ['match-9']);
    expect(socket.clockRequests, ['match-9']);
  });

  test('a later arrival resyncs again after the opponent drops', () async {
    notifier.state = notifier.state.copyWith(opponentConnected: false);
    socket.reconnected.add({'userId': 'opponent', 'status': 'connected'});
    await Future<void>.delayed(Duration.zero);

    socket.disconnected.add({'userId': 'opponent'});
    await Future<void>.delayed(Duration.zero);
    expect(notifier.state.opponentConnected, isFalse);

    socket.reconnected.add({'userId': 'opponent', 'status': 'connected'});
    await Future<void>.delayed(Duration.zero);

    expect(socket.joined, ['match-9', 'match-9']);
  });

  test('an echo burst while the opponent is present stays silent', () async {
    notifier.state = notifier.state.copyWith(opponentConnected: false);
    socket.reconnected.add({'userId': 'opponent', 'status': 'connected'});
    await Future<void>.delayed(Duration.zero);

    // The opponent re-joins repeatedly; every echo must be absorbed.
    for (var i = 0; i < 50; i += 1) {
      socket.reconnected.add({'userId': 'opponent', 'status': 'connected'});
      await Future<void>.delayed(Duration.zero);
    }

    expect(socket.joined, hasLength(1));
  });
}