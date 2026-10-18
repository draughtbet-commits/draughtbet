import 'dart:async';

import 'package:dio/dio.dart';
import 'package:draughts_arena/config/backend_contract.dart';
import 'package:draughts_arena/models/game_state.dart';
import 'package:draughts_arena/providers/match_provider.dart';
import 'package:draughts_arena/services/socket_service.dart';
import 'package:flutter_test/flutter_test.dart';

// In-match chat is real-time only: the server fans `chat.message` to the room
// and never persists it. These tests pin the client side of that contract —
// match-scoped delivery, duplicate suppression, own-vs-opponent attribution and
// the send guard.
class ChatSocket extends SocketService {
  ChatSocket()
    : super(contract: const BackendContractConfig(BackendContractMode.v2));

  final chat = StreamController<Map<String, dynamic>>.broadcast();
  final List<Map<String, dynamic>> sent = [];

  @override
  Stream<Map<String, dynamic>> get onChatMessage => chat.stream;

  @override
  void sendChatMessage({
    required String matchId,
    required String actionId,
    required String text,
  }) {
    sent.add({'matchId': matchId, 'actionId': actionId, 'text': text});
  }
}

GameState _liveGame() => const GameState(
  board: <int>[],
  currentTurn: 'WHITE',
  player1: 'me',
  player2: 'opponent',
  status: 'in_progress',
  moveCount: 0,
  consecutiveKingMoves: 0,
  protocolVersion: 2,
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late ChatSocket socket;
  late MatchNotifier notifier;

  setUp(() {
    socket = ChatSocket();
    notifier = MatchNotifier(socket, Dio());
    notifier.state = notifier.state.copyWith(currentMatchId: 'm1');
  });

  tearDown(() async {
    notifier.dispose();
    await socket.chat.close();
  });

  test('appends a message fanned out to the current match', () async {
    socket.chat.add({
      'matchId': 'm1',
      'messageId': 'c1',
      'senderId': 'opponent',
      'text': 'good luck',
      'sentAtMs': 1,
    });
    await Future<void>.delayed(Duration.zero);

    expect(notifier.state.chatMessages, hasLength(1));
    expect(notifier.state.chatMessages.first.text, 'good luck');
    expect(notifier.state.chatMessages.first.isMine('me'), isFalse);
  });

  test('ignores a message addressed to another match', () async {
    socket.chat.add({
      'matchId': 'm2',
      'messageId': 'c2',
      'senderId': 'opponent',
      'text': 'wrong room',
      'sentAtMs': 1,
    });
    await Future<void>.delayed(Duration.zero);

    expect(notifier.state.chatMessages, isEmpty);
  });

  test('drops a duplicate delivery of the same message id', () async {
    final payload = {
      'matchId': 'm1',
      'messageId': 'c3',
      'senderId': 'me',
      'text': 'hello',
      'sentAtMs': 1,
    };
    socket.chat.add(payload);
    socket.chat.add(payload);
    await Future<void>.delayed(Duration.zero);

    expect(notifier.state.chatMessages, hasLength(1));
    expect(notifier.state.chatMessages.first.isMine('me'), isTrue);
  });

  test('drops a malformed message without a sender or text', () async {
    socket.chat.add({'matchId': 'm1', 'messageId': 'c4', 'text': 'no sender'});
    await Future<void>.delayed(Duration.zero);

    expect(notifier.state.chatMessages, isEmpty);
  });

  test('sendChat refuses when there is no live game', () {
    expect(notifier.sendChat('hi'), isFalse);
    expect(socket.sent, isEmpty);
  });

  test('sendChat trims the text and spends one action id', () {
    notifier.state = notifier.state.copyWith(gameState: _liveGame());
    expect(notifier.sendChat('  hello there  '), isTrue);
    expect(socket.sent, hasLength(1));
    expect(socket.sent.first['matchId'], 'm1');
    expect(socket.sent.first['text'], 'hello there');
    expect(
      (socket.sent.first['actionId'] as String).startsWith('chat-'),
      isTrue,
    );
  });

  test('sendChat refuses blank and over-long text', () {
    notifier.state = notifier.state.copyWith(gameState: _liveGame());
    expect(notifier.sendChat('   '), isFalse);
    expect(notifier.sendChat('x' * 501), isFalse);
    expect(socket.sent, isEmpty);
  });
}
