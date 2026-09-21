import 'package:dio/dio.dart';
import '../models/match_flow.dart';

class MatchFlowGateway {
  const MatchFlowGateway(this._dio);

  final Dio _dio;

  Future<List<OpenMatch>> loadOpenMatches() async {
    final response = await _dio.get('/callouts/open');
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
          final stakeMinorUnits = int.tryParse(
            json['stakeMinorUnits']?.toString() ?? '',
          );
          final expiresAt = DateTime.tryParse(
            json['expiresAt']?.toString() ?? '',
          );
          if (id.isEmpty ||
              challengerId.isEmpty ||
              stakeMinorUnits == null ||
              stakeMinorUnits <= 0 ||
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
              rating: int.tryParse(playerJson['rating']?.toString() ?? ''),
              winRate: int.tryParse(playerJson['winRate']?.toString() ?? ''),
              level: int.tryParse(playerJson['level']?.toString() ?? ''),
            ),
            terms: MatchTerms(
              stakeMinorUnits: stakeMinorUnits,
              timeControl:
                  json['timeControl']?.toString() ?? 'Server configured',
              gameType: json['gameType']?.toString() ?? 'Server configured',
              board: json['board']?.toString() ?? 'Server configured',
              serverQuoted: false,
            ),
            expiresAt: expiresAt,
          );
        })
        .whereType<OpenMatch>()
        .toList(growable: false);
  }

  Future<String?> acceptOpenMatch(String calloutId) async {
    final response = await _dio.post('/callouts/$calloutId/accept');
    final body = response.data;
    if (body is Map) {
      final match = body['match'];
      if (match is Map) return match['id']?.toString();
    }
    return null;
  }

  Future<String?> createOpenMatch(MatchTerms terms) async {
    final response = await _dio.post(
      '/callouts',
      data: {'stakeMinorUnits': terms.stakeMinorUnits},
    );
    final body = response.data;
    if (body is Map) {
      final callout = body['callout'];
      if (callout is Map) return callout['id']?.toString();
    }
    return null;
  }

  Future<void> joinQueue(MatchTerms terms) => _dio.post(
    '/matchmaking/join',
    data: {'stakeMinorUnits': terms.stakeMinorUnits},
  );

  Future<void> leaveQueue(MatchTerms terms) => _dio.post(
    '/matchmaking/leave',
    data: {'stakeMinorUnits': terms.stakeMinorUnits},
  );
}
