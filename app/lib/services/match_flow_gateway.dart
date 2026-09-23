import 'package:dio/dio.dart';

import '../config/backend_contract.dart';
import '../models/match_flow.dart';

class MatchFlowGateway {
  MatchFlowGateway(this._dio, {BackendContractConfig? contract})
    : contract = contract ?? BackendContractConfig.fromEnvironment();

  final Dio _dio;
  final BackendContractConfig contract;
  String? _lastSearchId;
  final Map<String, String> _idempotencyKeys = {};

  bool get isV2 => contract.isV2;
  String? get lastSearchId => _lastSearchId;

  Future<List<OpenMatch>> loadOpenMatches() async {
    if (isV2) {
      final response = await _dio.get<dynamic>('/api/v1/matches');
      return (unwrapDataList(response.data) ?? const [])
          .map(_openMatchFromV2)
          .whereType<OpenMatch>()
          .toList(growable: false);
    }
    final response = await _dio.get<dynamic>('/callouts/open');
    final body = response.data;
    final raw = body is Map ? body['callouts'] : null;
    if (raw is! List) return const [];
    return raw
        .whereType<Map>()
        .map((item) {
          final json = Map<String, dynamic>.from(item);
          final challenger = json['challenger'];
          final playerJson = challenger is Map
              ? Map<String, dynamic>.from(challenger)
              : const <String, dynamic>{};
          final id = json['id']?.toString().trim() ?? '';
          final challengerId = json['challengerId']?.toString().trim() ?? '';
          final stake = _integer(json['stakeMinorUnits']);
          final expiresAt = DateTime.tryParse(
            json['expiresAt']?.toString() ?? '',
          );
          if (id.isEmpty ||
              challengerId.isEmpty ||
              stake == null ||
              stake <= 0 ||
              expiresAt == null) {
            return null;
          }
          return OpenMatch(
            id: id,
            host: MatchPlayer(
              id: challengerId,
              name:
                  playerJson['username']?.toString() ??
                  playerJson['displayName']?.toString() ??
                  json['challengerName']?.toString() ??
                  'Player',
              avatarId: playerJson['avatar']?.toString() ?? 'avatar_01',
              rank: json['tier']?.toString(),
              rating: _integer(playerJson['rating']),
              winRate: _integer(playerJson['winRate']),
              level: _integer(playerJson['level']),
            ),
            terms: MatchTerms(
              stakeMinorUnits: stake,
              timeControl:
                  json['timeControl']?.toString() ?? 'Server configured',
              gameType: json['gameType']?.toString() ?? 'Server configured',
              board: json['board']?.toString() ?? 'Server configured',
            ),
            expiresAt: expiresAt,
          );
        })
        .whereType<OpenMatch>()
        .toList(growable: false);
  }

  Future<String?> acceptOpenMatch(String matchId) async {
    final operation = 'match-join:$matchId';
    final response = await _dio.post<dynamic>(
      isV2 ? '/api/v1/matches/$matchId/join' : '/callouts/$matchId/accept',
      options: isV2 ? _idempotent(operation) : null,
    );
    _complete(operation);
    if (isV2) return unwrapData(response.data)?['id']?.toString();
    final body = response.data;
    if (body is Map && body['match'] is Map) {
      return (body['match'] as Map)['id']?.toString();
    }
    return null;
  }

  Future<String?> createOpenMatch(MatchTerms terms) async {
    final operation =
        'match-create:${terms.stakeMinorUnits}:${terms.timeControl}:${terms.gameType}:${terms.visibility}';
    final response = await _dio.post<dynamic>(
      isV2 ? '/api/v1/matches' : '/callouts',
      data: isV2
          ? {
              'stakeMinor': terms.stakeMinorUnits,
              'timeControlSeconds': _timeControlSeconds(terms.timeControl),
              'ruleset': _ruleset(terms.gameType),
              'visibility': _visibility(terms),
            }
          : {'stakeMinorUnits': terms.stakeMinorUnits},
      options: isV2 ? _idempotent(operation) : null,
    );
    _complete(operation);
    if (isV2) return unwrapData(response.data)?['id']?.toString();
    final body = response.data;
    if (body is Map && body['callout'] is Map) {
      return (body['callout'] as Map)['id']?.toString();
    }
    return null;
  }

  Future<void> joinQueue(MatchTerms terms) async {
    if (!isV2) {
      await _dio.post<dynamic>(
        '/matchmaking/join',
        data: {'stakeMinorUnits': terms.stakeMinorUnits},
      );
      return;
    }
    final operation =
        'matchmaking-search:${terms.stakeMinorUnits}:${terms.timeControl}:${terms.gameType}';
    final response = await _dio.post<dynamic>(
      '/api/v1/matchmaking/search',
      data: {
        'stakeMinor': terms.stakeMinorUnits,
        'timeControlSeconds': _timeControlSeconds(terms.timeControl),
        'ruleset': _ruleset(terms.gameType),
      },
      options: _idempotent(operation),
    );
    _complete(operation);
    _lastSearchId = unwrapData(response.data)?['searchId']?.toString();
  }

  Future<void> leaveQueue(MatchTerms terms, {String? searchId}) async {
    if (!isV2) {
      await _dio.post<dynamic>(
        '/matchmaking/leave',
        data: {'stakeMinorUnits': terms.stakeMinorUnits},
      );
      return;
    }
    final id = searchId ?? _lastSearchId;
    if (id == null || id.trim().isEmpty) {
      throw StateError('Cannot cancel matchmaking without a server searchId.');
    }
    final operation = 'matchmaking-cancel:$id';
    await _dio.delete<dynamic>(
      '/api/v1/matchmaking/search/$id',
      options: _idempotent(operation),
    );
    _complete(operation);
    _lastSearchId = null;
  }

  Future<MatchLifecycleSnapshot?> fetchMatch(
    String matchId,
    MatchTerms fallbackTerms,
  ) async {
    if (!isV2) return null;
    final response = await _dio.get<dynamic>('/api/v1/matches/$matchId');
    return _lifecycleFromV2(unwrapData(response.data), fallbackTerms);
  }

  Future<MatchLifecycleSnapshot?> markReady(
    String matchId,
    MatchTerms fallbackTerms,
  ) async {
    if (!isV2) return null;
    final operation = 'match-ready:$matchId';
    final response = await _dio.post<dynamic>(
      '/api/v1/matches/$matchId/ready',
      options: _idempotent(operation),
    );
    _complete(operation);
    return _lifecycleFromV2(unwrapData(response.data), fallbackTerms);
  }

  Future<MatchLifecycleSnapshot?> cancelMatch(
    String matchId,
    MatchTerms fallbackTerms,
  ) async {
    if (!isV2) return null;
    final operation = 'match-cancel:$matchId';
    final response = await _dio.post<dynamic>(
      '/api/v1/matches/$matchId/cancel',
      data: {'reason': 'CREATOR_CANCELLED'},
      options: _idempotent(operation),
    );
    _complete(operation);
    return _lifecycleFromV2(unwrapData(response.data), fallbackTerms);
  }

  Options _idempotent(String operation) => Options(
    headers: {
      'Idempotency-Key': _idempotencyKeys.putIfAbsent(
        operation,
        () => ClientRequestId.create(operation.split(':').first),
      ),
    },
  );

  void _complete(String operation) {
    _idempotencyKeys.remove(operation);
  }
}

OpenMatch? _openMatchFromV2(dynamic value) {
  if (value is! Map) return null;
  final raw = Map<String, dynamic>.from(value);
  final id = raw['id']?.toString().trim() ?? '';
  final stake = _integer(raw['stakeMinor']);
  final seconds = _integer(raw['timeControlSeconds']);
  final creator = raw['creator'];
  if (id.isEmpty || stake == null || stake <= 0 || creator is! Map) return null;
  final player = Map<String, dynamic>.from(creator);
  final playerId = player['id']?.toString().trim() ?? '';
  final playerName =
      (player['username'] ?? player['displayName'] ?? player['name'])
          ?.toString()
          .trim() ??
      '';
  if (playerId.isEmpty || playerName.isEmpty) return null;
  return OpenMatch(
    id: id,
    host: MatchPlayer(
      id: playerId,
      name: playerName,
      avatarId: player['avatarId']?.toString() ?? 'avatar_01',
      rank: (player['rank'] ?? player['level'])?.toString(),
      rating: _integer(player['rating']),
    ),
    terms: MatchTerms(
      stakeMinorUnits: stake,
      timeControl: seconds == null
          ? 'Server configured'
          : _displayTimeControl(seconds),
      gameType: raw['ruleset']?.toString() ?? 'Server configured',
      board: raw['board']?.toString() ?? 'Server configured',
      visibility: raw['visibility']?.toString() ?? 'Anyone',
      serverQuoted: true,
    ),
    expiresAt: DateTime.tryParse(raw['expiresAt']?.toString() ?? ''),
  );
}

MatchLifecycleSnapshot? _lifecycleFromV2(
  Map<String, dynamic>? raw,
  MatchTerms fallback,
) {
  if (raw == null) return null;
  final id = (raw['id'] ?? raw['matchId'])?.toString().trim() ?? '';
  if (id.isEmpty) return null;
  final status = raw['status']?.toString().toUpperCase();
  final reservationValues = raw['stakeReservations'];
  final reservations = reservationValues is List ? reservationValues : const [];
  final confirmedStakes = reservations.where((item) {
    if (item is! Map) return false;
    final value = item['status']?.toString().toUpperCase();
    return value == 'RESERVED' || value == 'CONFIRMED';
  }).length;
  final yourStakeStatus = raw['yourStake'] is Map
      ? (raw['yourStake'] as Map)['status']?.toString().toUpperCase()
      : null;
  final opponentStakeStatus = raw['opponentStake'] is Map
      ? (raw['opponentStake'] as Map)['status']?.toString().toUpperCase()
      : null;
  final yourStakeConfirmed =
      confirmedStakes >= 1 ||
      yourStakeStatus == 'RESERVED' ||
      yourStakeStatus == 'CONFIRMED';
  final opponentStakeConfirmed =
      confirmedStakes >= 2 ||
      opponentStakeStatus == 'RESERVED' ||
      opponentStakeStatus == 'CONFIRMED';
  final youReady = raw['youReady'] == true;
  final opponentReady = raw['opponentReady'] == true;
  final phase = switch (status) {
    'FUNDED' => MatchLifecyclePhase.readyCheck,
    'READY' =>
      opponentReady
          ? MatchLifecyclePhase.readyCheck
          : MatchLifecyclePhase.waitingOpponentReady,
    'IN_PLAY' => MatchLifecyclePhase.readyCheck,
    'CANCELLED' || 'CANCELED' => MatchLifecyclePhase.unavailable,
    _ => MatchLifecyclePhase.waitingOpponentStake,
  };
  return MatchLifecycleSnapshot(
    phase: phase,
    terms: fallback.copyWith(
      stakeMinorUnits: _integer(raw['stakeMinor']) ?? fallback.stakeMinorUnits,
      platformFeeMinorUnits: _integer(raw['feeMinor']),
      totalPrizeMinorUnits:
          _integer(raw['grossPotMinor']) ?? fallback.totalPrizeMinorUnits,
      serverQuoted: true,
    ),
    matchId: id,
    playerStake: yourStakeConfirmed
        ? AuthoritativeProgress.confirmed
        : AuthoritativeProgress.pending,
    opponentStake: opponentStakeConfirmed
        ? AuthoritativeProgress.confirmed
        : AuthoritativeProgress.pending,
    playerReady: youReady
        ? AuthoritativeProgress.confirmed
        : AuthoritativeProgress.pending,
    opponentReady: opponentReady
        ? AuthoritativeProgress.confirmed
        : AuthoritativeProgress.pending,
    release: raw['stakeReleaseStatus']?.toString().toUpperCase() == 'COMPLETED'
        ? AuthoritativeProgress.confirmed
        : AuthoritativeProgress.unknown,
    reason: raw['reason']?.toString(),
  );
}

int _timeControlSeconds(String value) {
  final number = int.tryParse(RegExp(r'\d+').firstMatch(value)?.group(0) ?? '');
  if (number == null || number <= 0) {
    throw FormatException('Missing server-supported time control.', value);
  }
  return value.toLowerCase().contains('second') ? number : number * 60;
}

String _ruleset(String value) {
  final normalized = value.trim().toUpperCase().replaceAll(' ', '_');
  if (normalized == 'CLASSIC') return 'INTERNATIONAL_10X10';
  return normalized;
}

String _visibility(MatchTerms terms) {
  if (terms.privateRoom) return 'PRIVATE';
  final normalized = terms.visibility.trim().toUpperCase();
  return normalized == 'ANYONE' ? 'PUBLIC' : normalized;
}

String _displayTimeControl(int seconds) {
  if (seconds >= 60 && seconds % 60 == 0) {
    final minutes = seconds ~/ 60;
    return '$minutes ${minutes == 1 ? 'minute' : 'minutes'}';
  }
  return '$seconds seconds';
}

int? _integer(dynamic value) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  return int.tryParse(value?.toString() ?? '');
}
