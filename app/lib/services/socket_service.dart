import 'dart:async';
import 'package:socket_io_client/socket_io_client.dart' as IO;
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';

class SocketService {
  IO.Socket? _socket;
  final _storage = const FlutterSecureStorage();
  
  // Stream controllers for different events
  final _matchFoundController = StreamController<Map<String, dynamic>>.broadcast();
  final _gameStateController = StreamController<Map<String, dynamic>>.broadcast();
  final _moveAppliedController = StreamController<Map<String, dynamic>>.broadcast();
  final _moveRejectedController = StreamController<Map<String, dynamic>>.broadcast();
  final _matchEndedResignController = StreamController<Map<String, dynamic>>.broadcast();
  final _opponentDisconnectedController = StreamController<Map<String, dynamic>>.broadcast();
  final _opponentReconnectedController = StreamController<Map<String, dynamic>>.broadcast();
  final _errorController = StreamController<Map<String, dynamic>>.broadcast();
  final _calloutCreatedController = StreamController<Map<String, dynamic>>.broadcast();

  Stream<Map<String, dynamic>> get onMatchFound => _matchFoundController.stream;
  Stream<Map<String, dynamic>> get onGameState => _gameStateController.stream;
  Stream<Map<String, dynamic>> get onMoveApplied => _moveAppliedController.stream;
  Stream<Map<String, dynamic>> get onMoveRejected => _moveRejectedController.stream;
  Stream<Map<String, dynamic>> get onMatchEndedResign => _matchEndedResignController.stream;
  Stream<Map<String, dynamic>> get onOpponentDisconnected => _opponentDisconnectedController.stream;
  Stream<Map<String, dynamic>> get onOpponentReconnected => _opponentReconnectedController.stream;
  Stream<Map<String, dynamic>> get onError => _errorController.stream;
  Stream<Map<String, dynamic>> get onCalloutCreated => _calloutCreatedController.stream;

  Future<void> initSocket() async {
    if (_socket != null && _socket!.connected) return;

    final token = await _storage.read(key: 'jwt');
    if (token == null) {
      throw Exception('Cannot initialize socket without JWT token');
    }

    final backendUrl = dotenv.env['BACKEND_URL'] ?? 'http://localhost:3000';

    _socket = IO.io(backendUrl, IO.OptionBuilder()
      .setTransports(['websocket'])
      .disableAutoConnect()
      .setAuth({'token': token})
      .build());

    _socket!.onConnect((_) {
      print('Socket connected');
    });

    _socket!.onDisconnect((_) {
      print('Socket disconnected');
    });

    _socket!.on('match_found', (data) {
      if (data is Map) _matchFoundController.add(Map<String, dynamic>.from(data));
    });

    _socket!.on('game_state', (data) {
      if (data is Map) _gameStateController.add(Map<String, dynamic>.from(data));
    });

    _socket!.on('move_applied', (data) {
      if (data is Map) _moveAppliedController.add(Map<String, dynamic>.from(data));
    });

    _socket!.on('move_rejected', (data) {
      if (data is Map) _moveRejectedController.add(Map<String, dynamic>.from(data));
    });

    _socket!.on('match_ended_resign', (data) {
      if (data is Map) _matchEndedResignController.add(Map<String, dynamic>.from(data));
    });

    _socket!.on('opponent_disconnected', (data) {
      if (data is Map) _opponentDisconnectedController.add(Map<String, dynamic>.from(data));
    });

    _socket!.on('opponent_reconnected', (data) {
      if (data is Map) _opponentReconnectedController.add(Map<String, dynamic>.from(data));
    });

    _socket!.on('error', (data) {
      if (data is Map) _errorController.add(Map<String, dynamic>.from(data));
    });

    _socket!.on('callout_created', (data) {
      if (data is Map) _calloutCreatedController.add(Map<String, dynamic>.from(data));
    });

    _socket!.connect();
  }

  void joinMatch(String matchId) {
    _socket?.emit('join_match', {'matchId': matchId});
  }

  void attemptMove(String matchId, int from, int to) {
    _socket?.emit('move_attempt', {'matchId': matchId, 'from': from, 'to': to});
  }

  void resign(String matchId) {
    _socket?.emit('resign', {'matchId': matchId});
  }

  void disconnect() {
    _socket?.disconnect();
    _socket = null;
  }

  void dispose() {
    _matchFoundController.close();
    _gameStateController.close();
    _moveAppliedController.close();
    _moveRejectedController.close();
    _matchEndedResignController.close();
    _opponentDisconnectedController.close();
    _opponentReconnectedController.close();
    _errorController.close();
    _calloutCreatedController.close();
    disconnect();
  }
}

// Global instance (can also be provided via Riverpod provider)
final socketService = SocketService();
