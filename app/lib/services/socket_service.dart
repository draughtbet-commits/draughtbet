import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:socket_io_client/socket_io_client.dart' as socket_io;
import '../config/backend_contract.dart';
import 'secure_storage.dart';
import 'token_refresher.dart';

enum SocketConnectionPhase { connected, disconnected, reconnecting, failed }

class SocketService {
  SocketService({BackendContractConfig? contract}) : _contract = contract;

  final BackendContractConfig? _contract;
  BackendContractConfig get contract =>
      _contract ?? BackendContractConfig.fromEnvironment();
  socket_io.Socket? _socket;

  /// The match room we intend to be in.
  ///
  /// Room membership lives on the connection, so it is lost on every reconnect
  /// and is absent at cold start: `joinMatch` is routinely called from provider
  /// init, before the socket has connected. Remembering the intent lets
  /// `onConnect` replay the join, so the client never sits outside a room it
  /// believes it entered.
  String? _joinedMatchId;
  final _storage = SecureStorageService();
  late final TokenRefresher _tokenRefresher =
      TokenRefresher(storage: _storage);
  String? _appVersion;
  Future<void>? _refreshInFlight;

  /// Set while a token refresh triggered by a failed handshake is in flight, so
  /// a reconnect storm cannot fan out into parallel refresh calls (each of
  /// which would rotate the refresh token and invalidate the others).
  Future<void>? _handshakeRecovery;

  /// Consecutive failed handshake recoveries. Past a small bound the session is
  /// treated as genuinely dead (bad refresh token, banned account) and we stop
  /// looping rather than retrying forever.
  int _handshakeRecoveryAttempts = 0;
  static const _maxHandshakeRecoveries = 3;

  /// Upper bound on how early the access token is refreshed.
  ///
  /// Recovery used to be purely reactive: the token was only replaced after
  /// something had already failed -- a REST 401, or a socket event the server
  /// refuses. Inside a match neither reliably happens. The board is driven
  /// entirely by socket events and does no REST, so a 15 minute token simply
  /// lapses mid-game; the server then drops the socket, the 60s disconnect
  /// grace starts, and if the reconnect loses the race the match is forfeited on
  /// time. Refreshing ahead of expiry removes that window.
  ///
  /// This is a *cap*, not the actual lead time. A fixed lead larger than the
  /// token lifetime would make every token look due the moment it is issued and
  /// refresh in a tight loop straight into the endpoint's rate limit.
  static const _maxRefreshLeeway = Duration(minutes: 2);

  /// Fraction of the remaining lifetime to leave as headroom.
  static const _remainingLifetimeFraction = 0.5;

  /// Floor for the retry cadence.
  ///
  /// Without it, a token whose expiry cannot be parsed resolves to a zero delay,
  /// and the resulting refresh either re-fails or returns an equally unparseable
  /// token -- an unbounded tight loop hammering the refresh endpoint. Known-past
  /// expiry still refreshes immediately; only the unknown case is floored.
  static const _proactiveRefreshFloor = Duration(minutes: 1);

  Timer? _proactiveRefreshTimer;

  /// Guards timers and async continuations after [dispose].
  bool _disposed = false;

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
  final _rateLimitedController =
      StreamController<Map<String, dynamic>>.broadcast();
  final _calloutCreatedController =
      StreamController<Map<String, dynamic>>.broadcast();
  final _walletUpdatedController =
      StreamController<Map<String, dynamic>>.broadcast();
  final _notificationController =
      StreamController<Map<String, dynamic>>.broadcast();
  final _accountStatusController =
      StreamController<bool>.broadcast();
  final _drawOfferController =
      StreamController<Map<String, dynamic>>.broadcast();
  final _drawResponseController =
      StreamController<Map<String, dynamic>>.broadcast();
  final _preplayReleasedController =
      StreamController<Map<String, dynamic>>.broadcast();
  final _clockSyncController =
      StreamController<Map<String, dynamic>>.broadcast();
  final _settlementCompletedController =
      StreamController<Map<String, dynamic>>.broadcast();
  final _connectionPhaseController =
      StreamController<SocketConnectionPhase>.broadcast();
  final _gameStartedController =
      StreamController<Map<String, dynamic>>.broadcast();

  /// The server's authoritative start signal. A player parked on a pre-play
  /// screen has no other way to learn the match went live.
  Stream<Map<String, dynamic>> get onGameStarted =>
      _gameStartedController.stream;

  Stream<Map<String, dynamic>> get onMatchFound => _matchFoundController.stream;
  Stream<Map<String, dynamic>> get onGameState => _gameStateController.stream;
  Stream<Map<String, dynamic>> get onMoveApplied =>
      _moveAppliedController.stream;
  Stream<Map<String, dynamic>> get onMoveRejected =>
      _moveRejectedController.stream;
  Stream<Map<String, dynamic>> get onMatchEndedResign =>
      _matchEndedResignController.stream;
  Stream<Map<String, dynamic>> get onMatchEnded => _matchEndedController.stream;

  /// A pre-play match left the gate (timeout or pre-play cancel) before play
  /// started. The sweep that releases it is not a request path, so it pushes
  /// this instead of a `match_ended` — there is no result to settle.
  Stream<Map<String, dynamic>> get onPreplayReleased =>
      _preplayReleasedController.stream;
  Stream<Map<String, dynamic>> get onOpponentDisconnected =>
      _opponentDisconnectedController.stream;
  Stream<Map<String, dynamic>> get onOpponentReconnected =>
      _opponentReconnectedController.stream;
  Stream<Map<String, dynamic>> get onError => _errorController.stream;

  /// The server refused one event because the per-user budget for it was spent.
  /// Separate from [onError] so a throttle is never mistaken for a dropped
  /// session (see the handler in [initSocket]).
  Stream<Map<String, dynamic>> get onRateLimited =>
      _rateLimitedController.stream;
  Stream<Map<String, dynamic>> get onCalloutCreated =>
      _calloutCreatedController.stream;
  Stream<Map<String, dynamic>> get onWalletUpdated =>
      _walletUpdatedController.stream;
  Stream<Map<String, dynamic>> get onNotification =>
      _notificationController.stream;

  /// Emits the new banned state whenever an admin suspends or reinstates the
  /// account. The restriction banner and every money/play gate read that flag,
  /// so this is what makes a suspension or reinstatement show up immediately
  /// instead of on the next cold start.
  Stream<bool> get onAccountStatus => _accountStatusController.stream;
  Stream<Map<String, dynamic>> get onDrawOffer => _drawOfferController.stream;
  Stream<Map<String, dynamic>> get onDrawResponse =>
      _drawResponseController.stream;
  Stream<Map<String, dynamic>> get onClockSync => _clockSyncController.stream;
  Stream<Map<String, dynamic>> get onSettlementCompleted =>
      _settlementCompletedController.stream;
  Stream<SocketConnectionPhase> get onConnectionPhase =>
      _connectionPhaseController.stream;
  bool get isV2 => contract.isV2;

  /// Re-reads the access token from storage and, when it differs from the one
  /// the socket is carrying, updates the socket's auth payload and headers so
  /// the in-flight reconnect handshake uses a token that has not expired.
  /// True when the handshake failed because the access token is expired or
  /// malformed — recoverable by refreshing, as opposed to a suspended account
  /// or an unsupported app version, which are not.
  bool _isRecoverableAuthError(dynamic err) {
    final message = err?.toString().toUpperCase() ?? '';
    return message.contains('TOKEN_EXPIRED') ||
        message.contains('TOKEN_INVALID') ||
        message.contains('EXPIRED') ||
        message.contains('JWT');
  }

  /// Refreshes the access token and reconnects, bounded so a permanently dead
  /// session fails fast instead of looping.
  Future<void> _recoverFromAuthFailure() async {
    if (_handshakeRecoveryAttempts >= _maxHandshakeRecoveries) {
      _connectionPhaseController.add(SocketConnectionPhase.failed);
      return;
    }
    final inFlight = _handshakeRecovery;
    if (inFlight != null) return inFlight;

    _connectionPhaseController.add(SocketConnectionPhase.reconnecting);
    final future = _doRecoverFromAuthFailure().whenComplete(() {
      _handshakeRecovery = null;
    });
    _handshakeRecovery = future;
    return future;
  }

  Future<void> _doRecoverFromAuthFailure() async {
    _handshakeRecoveryAttempts++;
    try {
      final tokens = await _tokenRefresher.refresh();
      final socket = _socket;
      if (socket == null) return;
      // Carry the new token into the next handshake. The Authorization extra
      // header is fixed at construction, but the handshake reads `auth`.
      socket.auth = {'token': tokens.accessToken, 'version': ?_appVersion};
      _handshakeRecoveryAttempts = 0;
      _scheduleProactiveRefresh();
      if (!socket.connected) socket.connect();
    } catch (error, stack) {
      // Refresh failed: the refresh token is dead or the session was revoked.
      // Stop trying rather than looping on a token that will never work.
      //
      // Logged because this is the path that locks a player out of a live
      // match with only "failed" on screen.
      debugPrint('handshake auth recovery refresh failed: $error');
      debugPrintStack(stackTrace: stack, maxFrames: 6);
      _connectionPhaseController.add(SocketConnectionPhase.failed);
    }
  }

  /// Reads the `exp` claim from the stored access token. Null when the token is
  /// absent or unparseable, which callers treat as "refresh now".
  Future<DateTime?> _accessTokenExpiry() async {
    try {
      final token = await _storage.accessToken;
      if (token == null || token.isEmpty) return null;
      final parts = token.split('.');
      if (parts.length != 3) return null;
      final payload = jsonDecode(
        utf8.decode(base64Url.decode(base64Url.normalize(parts[1]))),
      );
      if (payload is! Map) return null;
      final exp = payload['exp'];
      if (exp is! num) return null;
      return DateTime.fromMillisecondsSinceEpoch(exp.toInt() * 1000);
    } catch (_) {
      return null;
    }
  }

  /// Schedules the next proactive refresh for the stored access token. Safe to
  /// call repeatedly; each call replaces the pending timer.
  ///
  /// [lastAttemptFailed] applies the retry floor. An expired token whose
  /// refresh keeps failing would otherwise recompute a zero delay forever and
  /// spin, so a failure backs off instead of retrying immediately.
  void _scheduleProactiveRefresh({bool lastAttemptFailed = false}) {
    _proactiveRefreshTimer?.cancel();
    final token = _accessTokenExpiry().then((expiry) {
      if (_disposed) return;
      final now = DateTime.now();
      final remaining = expiry?.difference(now);
      // Headroom scales with what is actually left: half the remaining life,
      // capped so a long-lived token is refreshed a couple of minutes early
      // rather than at its midpoint.
      final leeway = remaining == null
          ? null
          : Duration(
              milliseconds:
                  (remaining.inMilliseconds * _remainingLifetimeFraction)
                      .round(),
            );
      final due = remaining == null
          ? _proactiveRefreshFloor
          : remaining -
              (leeway! < _maxRefreshLeeway ? leeway : _maxRefreshLeeway);
      final delay = due.isNegative ? Duration.zero : due;
      final bounded = lastAttemptFailed && delay < _proactiveRefreshFloor
          ? _proactiveRefreshFloor
          : delay;
      _proactiveRefreshTimer = Timer(
        bounded,
        () => unawaited(_runProactiveRefresh()),
      );
    });
    unawaited(token);
  }

  Future<void> _runProactiveRefresh() async {
    if (_disposed) return;
    var failed = false;
    try {
      await _tokenRefresher.refresh();
      if (_disposed) return;
      // Keep the socket's auth payload aligned with storage so a reconnect
      // racing this refresh uses the new token, not the one it is replacing.
      await _refreshSocketAuth();
    } catch (error) {
      // A failed proactive refresh is not fatal: the reactive paths (REST 401,
      // handshake rejection) still recover. Retry on a bounded cadence rather
      // than giving up on the schedule or spinning on it.
      //
      // Logged, because this is the one failure that silently ends a match:
      // the token lapses, the reconnect handshake is rejected, and the player
      // forfeits on the disconnect grace with nothing on screen to explain it.
      failed = true;
      debugPrint('proactive token refresh failed: $error');
    }
    if (!_disposed) _scheduleProactiveRefresh(lastAttemptFailed: failed);
  }

  Future<void> _refreshSocketAuth() async {
    final inFlight = _refreshInFlight;
    if (inFlight != null) return inFlight;
    final future = _doRefreshSocketAuth().whenComplete(() {
      _refreshInFlight = null;
    });
    _refreshInFlight = future;
    return future;
  }

  Future<void> _doRefreshSocketAuth() async {
    final socket = _socket;
    if (socket == null) return;

    String? fresh;
    try {
      fresh = await _storage.accessToken;
    } catch (_) {
      return;
    }
    if (fresh == null || fresh.isEmpty) return;

    final current = socket.auth is Map ? socket.auth['token'] : null;
    if (current == fresh) return;

    // Only `auth` can be reassigned on a live socket; the Authorization extra
    // header is fixed at construction. The handshake authenticates from the
    // auth payload, so updating it is enough to stop the stale-token retries.
    final version = _appVersion;
    socket.auth = {'token': fresh, 'version': ?version};
  }

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
    _appVersion = appVersion;

    // BACKEND_URL is the REST base (…/api/v1); Socket.IO lives at the bare
    // origin with its default /socket.io path on the root namespace (V2 event
    // names like match.state are served there too). Connecting via the API
    // prefix 404s, so strip it before handing the URL to socket.io-client.
    final socketUrl = backendUrl.replaceFirst(RegExp(r'/?api/v1/?$'), '');

    _socket = socket_io.io(
      socketUrl,
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
      _scheduleProactiveRefresh();
      // Membership does not survive a reconnect, and the first join at cold
      // start is dropped before the socket exists. Re-issue it.
      final joined = _joinedMatchId;
      if (joined != null) _emitJoin(joined);
    });
    _socket!.on('auth_expired', (data) {
      // The server dropped us because the access token lapsed mid-session.
      // Refresh and reconnect immediately rather than waiting for the next
      // handshake to be rejected.
      if (data is Map && (data['code']?.toString().contains('TOKEN') ?? false)) {
        unawaited(_recoverFromAuthFailure());
      }
    });

    _socket!.onDisconnect((_) {
      _connectionPhaseController.add(SocketConnectionPhase.disconnected);
    });
    _socket!.onReconnectAttempt((_) {
      // socket.io replays the token captured at connect time on every attempt,
      // so once the 15 minute access token lapses the handshake fails with
      // "jwt expired" and the client retries that same dead token forever. Pull
      // a current token from storage (the REST interceptor refreshes it there)
      // and swap it in before this attempt goes out.
      unawaited(_refreshSocketAuth());
      _connectionPhaseController.add(SocketConnectionPhase.reconnecting);
    });
    _socket!.onReconnecting((_) {
      _connectionPhaseController.add(SocketConnectionPhase.reconnecting);
    });
    _socket!.onConnectError((err) {
      // A dead access token cannot be fixed by reconnecting: socket.io replays
      // the same auth payload on every attempt, so without an explicit refresh
      // the client retries an expired token forever and the player is locked out
      // of the room until they manually restart the app.
      if (_isRecoverableAuthError(err)) {
        unawaited(_recoverFromAuthFailure());
        return;
      }
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
          _gameStartedController.add(payload);
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

    _socket!.on('match_preplay_released', (data) {
      if (data is Map) {
        _preplayReleasedController.add(Map<String, dynamic>.from(data));
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
    _socket!.on('draw.respond', (data) {
      if (data is Map) {
        _drawResponseController.add(Map<String, dynamic>.from(data));
      }
    });
    _socket!.on('clock.sync', (data) {
      if (data is Map) {
        _clockSyncController.add(Map<String, dynamic>.from(data));
      }
    });

    _socket!.on('opponent.connection', (data) {
      if (data is! Map) return;
      final payload = Map<String, dynamic>.from(data);
      final status = payload['status']?.toString();
      if (status == 'connected') {
        _opponentReconnectedController.add(payload);
      } else if (status == 'disconnected') {
        _opponentDisconnectedController.add(payload);
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

    _socket!.on('rate_limited', (data) {
      if (data is Map) {
        // Deliberately not routed to onError: being throttled is a transient
        // server-side guard, not a failure the player caused or can act on by
        // retrying. Routing it as an error invites exactly the reconnect storm
        // that exhausts the budget in the first place.
        _rateLimitedController.add(Map<String, dynamic>.from(data));
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

    _socket!.on('account_status', (data) {
      if (data is Map && data['isBanned'] is bool) {
        _accountStatusController.add(data['isBanned'] as bool);
      }
    });

    // Start the refresh schedule as soon as the socket exists, not only after a
    // successful connect. A stored token that is already expired is rejected at
    // the handshake, so `onConnect` never fires and the schedule would never be
    // armed -- leaving the app unable to heal itself on launch.
    _scheduleProactiveRefresh();

    // If the stored token is already due, mint a valid one before the first
    // handshake instead of spending failed handshakes discovering that. Without
    // this the client races its own refresh, the server rejects the stale token
    // a few times, and the app flashes "Reconnecting" on every launch.
    unawaited(
      _primeTokenBeforeConnect()
          .timeout(const Duration(seconds: 5), onTimeout: () {})
          .whenComplete(() {
        // Priming defers the connect, so another caller may have connected in
        // the meantime; connecting again would churn the socket.
        final socket = _socket;
        if (!_disposed && socket != null && !socket.connected) {
          socket.connect();
        }
      }),
    );
  }

  /// Refreshes before the first handshake when the stored token is already
  /// inside its refresh window. Never throws: a failure just means the connect
  /// proceeds and the normal recovery path handles it.
  Future<void> _primeTokenBeforeConnect() async {
    if (_disposed) return;
    try {
      final expiry = await _accessTokenExpiry();
      if (expiry == null || _disposed) return;
      final remaining = expiry.difference(DateTime.now());
      final half = Duration(
        milliseconds: (remaining.inMilliseconds * _remainingLifetimeFraction)
            .round(),
      );
      final leeway = half < _maxRefreshLeeway ? half : _maxRefreshLeeway;
      if (remaining > leeway) return;
      await _tokenRefresher.refresh();
      if (_disposed) return;
      await _refreshSocketAuth();
    } catch (error) {
      debugPrint('priming token before connect failed: $error');
    }
  }

  void joinMatch(String matchId) {
    _joinedMatchId = matchId;
    _emitJoin(matchId);
  }

  /// Forgets the current room intent so a later reconnect does not re-enter a
  /// match the player has left or that has already ended.
  void clearJoinedMatch() {
    _joinedMatchId = null;
  }

  void _emitJoin(String matchId) {
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
    if (!contract.isV2) return;
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
    _disposed = true;
    _proactiveRefreshTimer?.cancel();
    _matchFoundController.close();
    _gameStateController.close();
    _moveAppliedController.close();
    _moveRejectedController.close();
    _matchEndedResignController.close();
    _matchEndedController.close();
    _opponentDisconnectedController.close();
    _opponentReconnectedController.close();
    _errorController.close();
    _rateLimitedController.close();
    _preplayReleasedController.close();
    _calloutCreatedController.close();
    _walletUpdatedController.close();
    _notificationController.close();
    _drawOfferController.close();
    _drawResponseController.close();
    _clockSyncController.close();
    _settlementCompletedController.close();
    _connectionPhaseController.close();
    _gameStartedController.close();
    disconnect();
  }
}

// Global instance (can also be provided via Riverpod provider)
final socketService = SocketService();
