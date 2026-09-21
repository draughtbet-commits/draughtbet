import 'dart:async';
import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'package:socket_io_client/socket_io_client.dart' as socket_io;
import 'secure_storage.dart';

class SocketService {
  socket_io.Socket? _socket;
  final _storage = SecureStorageService();

  // Stream controllers for different events
  final _matchFoundController =
      StreamController<Map<String, dynamic>>.broadcast();
  final _gameStateController =
      StreamController<Map<String, dynamic>>.broadcast();
  final _moveAppliedController =
      StreamController<Map<String, dynamic>>.broadcast();
  final _moveRejectedController =
      StreamController<Map<String, dynamic>>.broadcast();
  final _matchEndedResignController =
      StreamController<Map<String, dynamic>>.broadcast();
  final _matchEndedController =
      StreamController<Map<String, dynamic>>.broadcast();
  final _opponentDisconnectedController =
      StreamController<Map<String, dynamic>>.broadcast();
  final _opponentReconnectedController =
      StreamController<Map<String, dynamic>>.broadcast();
  final _errorController = StreamController<Map<String, dynamic>>.broadcast();
  final _calloutCreatedController =
      StreamController<Map<String, dynamic>>.broadcast();
  final _walletUpdatedController =
      StreamController<Map<String, dynamic>>.broadcast();
  final _notificationController =
      StreamController<Map<String, dynamic>>.broadcast();
  final _drawOfferController =
      StreamController<Map<String, dynamic>>.broadcast();
  final _drawResponseController =
      StreamController<Map<String, dynamic>>.broadcast();

  Stream<Map<String, dynamic>> get onMatchFound => _matchFoundController.stream;
  Stream<Map<String, dynamic>> get onGameState => _gameStateController.stream;
  Stream<Map<String, dynamic>> get onMoveApplied =>
      _moveAppliedController.stream;
  Stream<Map<String, dynamic>> get onMoveRejected =>
      _moveRejectedController.stream;
  Stream<Map<String, dynamic>> get onMatchEndedResign =>
      _matchEndedResignController.stream;
  Stream<Map<String, dynamic>> get onMatchEnded => _matchEndedController.stream;
  Stream<Map<String, dynamic>> get onOpponentDisconnected =>
      _opponentDisconnectedController.stream;
  Stream<Map<String, dynamic>> get onOpponentReconnected =>
      _opponentReconnectedController.stream;
  Stream<Map<String, dynamic>> get onError => _errorController.stream;
  Stream<Map<String, dynamic>> get onCalloutCreated =>
      _calloutCreatedController.stream;
  Stream<Map<String, dynamic>> get onWalletUpdated =>
      _walletUpdatedController.stream;
  Stream<Map<String, dynamic>> get onNotification =>
      _notificationController.stream;
  Stream<Map<String, dynamic>> get onDrawOffer => _drawOfferController.stream;
  Stream<Map<String, dynamic>> get onDrawResponse =>
      _drawResponseController.stream;

  Future<void> initSocket() async {
    if (_socket != null) {
      if (!_socket!.connected) _socket!.connect();
      return;
    }

    final token = await _storage.accessToken;
    if (token == null) {
      throw Exception('Cannot initialize socket without JWT token');
    }

    final backendUrl = dotenv.env['BACKEND_URL'] ?? 'http://localhost:3000';

    _socket = socket_io.io(
      backendUrl,
      socket_io.OptionBuilder()
          .setTransports(['websocket'])
          .disableAutoConnect()
          .setAuth({'token': token})
          .build(),
    );

    _socket!.on('match_found', (data) {
      if (data is Map) {
        _matchFoundController.add(Map<String, dynamic>.from(data));
      }
    });

    _socket!.on('game_state', (data) {
      if (data is Map) {
        _gameStateController.add(Map<String, dynamic>.from(data));
      }
    });
    _socket!.on('match.state', (data) {
      if (data is Map) {
        final payload = Map<String, dynamic>.from(data);
        payload['_protocolVersion'] = 2;
        _gameStateController.add(payload);
      }
    });

    _socket!.on('move_applied', (data) {
      if (data is Map) {
        _moveAppliedController.add(Map<String, dynamic>.from(data));
      }
    });
    _socket!.on('move.accepted', (data) {
      if (data is Map) {
        final payload = Map<String, dynamic>.from(data);
        payload['_protocolVersion'] = 2;
        _moveAppliedController.add(payload);
      }
    });

    _socket!.on('move_rejected', (data) {
      if (data is Map) {
        _moveRejectedController.add(Map<String, dynamic>.from(data));
      }
    });
    _socket!.on('move.rejected', (data) {
      if (data is Map) {
        _moveRejectedController.add(Map<String, dynamic>.from(data));
      }
    });

    _socket!.on('match_ended_resign', (data) {
      if (data is Map) {
        _matchEndedResignController.add(Map<String, dynamic>.from(data));
      }
    });

    _socket!.on('match_ended', (data) {
      if (data is Map) {
        _matchEndedController.add(Map<String, dynamic>.from(data));
      }
    });
    _socket!.on('match.finished', (data) {
      if (data is Map) {
        _matchEndedController.add(Map<String, dynamic>.from(data));
      }
    });

    _socket!.on('draw.offer', (data) {
      if (data is Map) {
        _drawOfferController.add(Map<String, dynamic>.from(data));
      }
    });
    _socket!.on('draw.responded', (data) {
      if (data is Map) {
        _drawResponseController.add(Map<String, dynamic>.from(data));
      }
    });

    _socket!.on('opponent_disconnected', (data) {
      if (data is Map) {
        _opponentDisconnectedController.add(Map<String, dynamic>.from(data));
      }
    });

    _socket!.on('opponent_reconnected', (data) {
      if (data is Map) {
        _opponentReconnectedController.add(Map<String, dynamic>.from(data));
      }
    });

    _socket!.on('error', (data) {
      if (data is Map) _errorController.add(Map<String, dynamic>.from(data));
    });

    _socket!.on('callout_created', (data) {
      if (data is Map) {
        _calloutCreatedController.add(Map<String, dynamic>.from(data));
      }
    });

    _socket!.on('wallet_updated', (data) {
      if (data is Map) {
        _walletUpdatedController.add(Map<String, dynamic>.from(data));
      }
    });

    _socket!.on('notification', (data) {
      if (data is Map) {
        _notificationController.add(Map<String, dynamic>.from(data));
      }
    });

    _socket!.connect();
  }

  void joinMatch(String matchId) {
    // The active backend registers only `join_match`. Emitting the roadmap V2
    // alias as well caused two join attempts against mixed deployments.
    _socket?.emit('join_match', {'matchId': matchId});
  }

  void attemptMove(String matchId, int from, int to) {
    _socket?.emit('move_attempt', {'matchId': matchId, 'from': from, 'to': to});
  }

  void submitMoveV2({
    required String matchId,
    required String clientMoveId,
    required int expectedStateVersion,
    required int from,
    required List<int> path,
  }) {
    _socket?.emit('move.submit', {
      'matchId': matchId,
      'clientMoveId': clientMoveId,
      'expectedStateVersion': expectedStateVersion,
      'from': from,
      'path': path,
    });
  }

  void resign(String matchId) {
    _socket?.emit('resign', {'matchId': matchId});
  }

  void resignV2({
    required String matchId,
    required String actionId,
    required int expectedStateVersion,
  }) {
    _socket?.emit('match.resign', {
      'matchId': matchId,
      'actionId': actionId,
      'expectedStateVersion': expectedStateVersion,
    });
  }

  void offerDraw({
    required String matchId,
    required String actionId,
    required int expectedStateVersion,
  }) {
    _socket?.emit('draw.offer', {
      'matchId': matchId,
      'actionId': actionId,
      'expectedStateVersion': expectedStateVersion,
    });
  }

  void respondToDraw({
    required String matchId,
    required String actionId,
    required String offerId,
    required String response,
  }) {
    _socket?.emit('draw.respond', {
      'matchId': matchId,
      'actionId': actionId,
      'offerId': offerId,
      'response': response,
    });
  }

  void disconnect() {
    final socket = _socket;
    _socket = null;
    socket?.dispose();
  }

  void dispose() {
    _matchFoundController.close();
    _gameStateController.close();
    _moveAppliedController.close();
    _moveRejectedController.close();
    _matchEndedResignController.close();
    _matchEndedController.close();
    _opponentDisconnectedController.close();
    _opponentReconnectedController.close();
    _errorController.close();
    _calloutCreatedController.close();
    _walletUpdatedController.close();
    _notificationController.close();
    _drawOfferController.close();
    _drawResponseController.close();
    disconnect();
  }
}

// Global instance (can also be provided via Riverpod provider)
final socketService = SocketService();
