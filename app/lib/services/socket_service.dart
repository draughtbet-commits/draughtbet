import 'dart:async';
import 'dart:math';
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
  final _matchStateController =
      StreamController<Map<String, dynamic>>.broadcast();
  final _reconnectedController = StreamController<void>.broadcast();
  final _walletUpdatedController =
      StreamController<Map<String, dynamic>>.broadcast();
  final _notificationController =
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
  Stream<Map<String, dynamic>> get onMatchState => _matchStateController.stream;
  Stream<void> get onReconnected => _reconnectedController.stream;
  bool get isConnected => _socket?.connected ?? false;
  Stream<Map<String, dynamic>> get onWalletUpdated =>
      _walletUpdatedController.stream;
  Stream<Map<String, dynamic>> get onNotification =>
      _notificationController.stream;

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
    // BACKEND_URL is the REST base (…/api/v1); Socket.IO lives at the bare
    // origin with its default /socket.io path. Connecting via the API prefix
    // 404s, so strip it before handing the URL to socket.io-client.
    final socketUrl = backendUrl.replaceFirst(RegExp(r'/?api/v1/?$'), '');

    _socket = socket_io.io(
      socketUrl,
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

    // V2 canonical room state. Readiness, presence, draw offers, clock and
    // settlement all flow through `match.state`; the V1 aliases below are
    // still emitted (and listened for) for live move deltas.
    _socket!.on('match.state', (data) {
      if (data is Map) {
        _matchStateController.add(Map<String, dynamic>.from(data));
      }
    });

    _socket!.on('game_state', (data) {
      if (data is Map) {
        _gameStateController.add(Map<String, dynamic>.from(data));
      }
    });

    _socket!.on('move_applied', (data) {
      if (data is Map) {
        _moveAppliedController.add(Map<String, dynamic>.from(data));
      }
    });

    _socket!.on('move_rejected', (data) {
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

    void forwardWalletUpdate(dynamic data) {
      if (data is Map) {
        _walletUpdatedController.add(Map<String, dynamic>.from(data));
      }
    }

    _socket!.on('wallet_updated', forwardWalletUpdate);
    _socket!.on('wallet.updated', forwardWalletUpdate);

    _socket!.on('notification', (data) {
      if (data is Map) {
        _notificationController.add(Map<String, dynamic>.from(data));
      }
    });

    _socket!.on('connect', (_) {
      _reconnectedController.add(null);
    });

    _socket!.connect();
  }

  /// Emits the V2 pre-start readiness contract `player.ready`. The server
  /// only starts the clock once BOTH participants have ready'd (LIGHT+DARK),
  /// so a single-sided ready just broadcasts the updated room state back.
  void markReady(String matchId) {
    final actionId =
        '${DateTime.now().microsecondsSinceEpoch}-${Random().nextInt(1 << 31)}';
    _socket?.emit('player.ready', {'matchId': matchId, 'actionId': actionId});
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
    final socket = _socket;
    _socket = null;
    socket?.dispose();
  }

  void dispose() {
    _matchFoundController.close();
    _gameStateController.close();
    _matchStateController.close();
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
    _reconnectedController.close();
    disconnect();
  }
}

// Global instance (can also be provided via Riverpod provider)
final socketService = SocketService();
