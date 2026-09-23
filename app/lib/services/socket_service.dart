import 'dart:async';
import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:socket_io_client/socket_io_client.dart' as socket_io;
import '../config/backend_contract.dart';
import 'secure_storage.dart';

enum SocketConnectionPhase { connected, disconnected, reconnecting, failed }

class SocketService {
  SocketService({BackendContractConfig? contract}) : _contract = contract;

  final BackendContractConfig? _contract;
  BackendContractConfig get contract =>
      _contract ?? BackendContractConfig.fromEnvironment();
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
  final _clockSyncController =
      StreamController<Map<String, dynamic>>.broadcast();
  final _settlementCompletedController =
      StreamController<Map<String, dynamic>>.broadcast();
  final _connectionPhaseController =
      StreamController<SocketConnectionPhase>.broadcast();

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
  Stream<Map<String, dynamic>> get onClockSync => _clockSyncController.stream;
  Stream<Map<String, dynamic>> get onSettlementCompleted =>
      _settlementCompletedController.stream;
  Stream<SocketConnectionPhase> get onConnectionPhase =>
      _connectionPhaseController.stream;
  bool get isV2 => contract.isV2;

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
    final appVersion = (await PackageInfo.fromPlatform()).version;

    _socket = socket_io.io(
      backendUrl,
      socket_io.OptionBuilder()
          .setTransports(['websocket'])
          .disableAutoConnect()
          .setAuth({'token': token, 'version': appVersion})
          .setExtraHeaders(
            contract.isV2
                ? {
                    'Authorization': 'Bearer $token',
                    'x-app-version': appVersion,
                  }
                : {},
          )
          .build(),
    );

    _socket!.onConnect((_) {
      _connectionPhaseController.add(SocketConnectionPhase.connected);
    });
    _socket!.onDisconnect((_) {
      _connectionPhaseController.add(SocketConnectionPhase.disconnected);
    });
    _socket!.onReconnectAttempt((_) {
      _connectionPhaseController.add(SocketConnectionPhase.reconnecting);
    });
    _socket!.onReconnecting((_) {
      _connectionPhaseController.add(SocketConnectionPhase.reconnecting);
    });
    _socket!.onConnectError((_) {
      _connectionPhaseController.add(SocketConnectionPhase.failed);
    });
    _socket!.onReconnectError((_) {
      _connectionPhaseController.add(SocketConnectionPhase.failed);
    });
    _socket!.onReconnectFailed((_) {
      _connectionPhaseController.add(SocketConnectionPhase.failed);
    });

    _socket!.on('match_found', (data) {
      if (data is Map) {
        _matchFoundController.add(Map<String, dynamic>.from(data));
      }
    });

    _socket!.on('game_state', (data) {
      if (contract.isV2) return;
      if (data is Map) {
        _gameStateController.add(Map<String, dynamic>.from(data));
      }
    });
    _socket!.on('match.state', (data) {
      if (data is Map) {
        final payload = Map<String, dynamic>.from(data);
        payload['_protocolVersion'] = 2;
        _forwardClocks(payload);
        _gameStateController.add(payload);
      }
    });
    _socket!.on('game.started', (data) {
      if (data is Map) {
        final payload = Map<String, dynamic>.from(data);
        _forwardClocks(payload);
        final matchId = payload['matchId']?.toString();
        if (matchId != null && matchId.isNotEmpty) {
          _socket?.emit('match.join', {'matchId': matchId});
        }
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
        _forwardClocks(payload);
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
    _socket!.on('clock.sync', (data) {
      if (data is Map) {
        _clockSyncController.add(Map<String, dynamic>.from(data));
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

    _socket!.on('settlement.completed', (data) {
      if (data is Map) {
        _settlementCompletedController.add(Map<String, dynamic>.from(data));
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
    _socket?.emit(contract.isV2 ? 'match.join' : 'join_match', {
      'matchId': matchId,
    });
  }

  void requestCanonicalState(String matchId) => joinMatch(matchId);

  void requestClockSync(String matchId) {
    if (!contract.isV2) return;
    _socket?.emit('clock.sync', {'matchId': matchId});
  }

  Future<void> reconnect() => initSocket();

  void markReady(String matchId, String actionId) {
    if (!contract.isV2) return;
    _socket?.emit('player.ready', {'matchId': matchId, 'actionId': actionId});
  }

  void _forwardClocks(Map<String, dynamic> payload) {
    final clocks = payload['clocks'];
    final clockPayload = <String, dynamic>{
      if (clocks is Map) ...Map<String, dynamic>.from(clocks),
    };
    const clockKeys = <String>[
      'matchId',
      'serverNowMs',
      'clientSentAt',
      'version',
      'stateVersion',
      'status',
      'currentTurn',
      'currentTurnUserId',
      'turnStartedAtServer',
      'deadlineAt',
      'timeControlSeconds',
      'remainingMs',
      'disconnectGraceMs',
    ];
    for (final key in clockKeys) {
      if (payload[key] != null) clockPayload[key] = payload[key];
    }
    if (clockPayload['remainingMs'] == null &&
        clockPayload['deadlineAt'] == null &&
        clockPayload['serverNowMs'] == null) {
      return;
    }
    _clockSyncController.add(clockPayload);
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
    // Backend V2 currently exposes no draw-offer command. Keep this method as
    // a compatibility seam, but never invent or emit an unsupported event.
  }

  void respondToDraw({
    required String matchId,
    required String actionId,
    required String offerId,
    required String response,
  }) {
    // Backend V2 currently exposes no draw-response command.
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
    _clockSyncController.close();
    _settlementCompletedController.close();
    _connectionPhaseController.close();
    disconnect();
  }
}

// Global instance (can also be provided via Riverpod provider)
final socketService = SocketService();
