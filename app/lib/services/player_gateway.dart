import 'package:dio/dio.dart';

import '../config/backend_contract.dart';
import '../models/match_flow.dart';

/// Player-directory access. The backend surface is v2-only and deliberately
/// exposes only public profile fields (id, username, display name, avatar,
/// tier, rating, win rate); no contact, balance or verification data ever
/// leaves the server.
class PlayerGateway {
  PlayerGateway(this._dio, {BackendContractConfig? contract})
    : contract = contract ?? BackendContractConfig.fromEnvironment();

  final Dio _dio;
  final BackendContractConfig contract;

  Future<List<MatchPlayer>> searchPlayers(
    String query, {
    int limit = 10,
  }) async {
    if (!contract.isV2) return const [];
    final response = await _dio.get<dynamic>(
      '/players/search',
      queryParameters: {'username': query, 'limit': limit},
    );
    final data = unwrapData(response.data);
    final players = data?['players'];
    if (players is! List) return const [];
    return players
        .whereType<Map>()
        .map((raw) => _fromJson(Map<String, dynamic>.from(raw)))
        .toList(growable: false);
  }

  Future<MatchPlayer?> fetchProfile(String playerId) async {
    if (!contract.isV2) return null;
    final response = await _dio.get<dynamic>('/players/$playerId');
    final data = unwrapData(response.data);
    final raw = data?['player'];
    if (raw is! Map) return null;
    return _fromJson(Map<String, dynamic>.from(raw));
  }

  MatchPlayer _fromJson(Map<String, dynamic> json) {
    final username = json['username']?.toString();
    final displayName = json['displayName']?.toString();
    final rating = json['rating'];
    final winRate = json['winRate'];
    return MatchPlayer(
      id: json['id']?.toString().trim() ?? '',
      name: username ?? displayName ?? 'Player',
      avatarId: json['avatar']?.toString() ?? 'avatar_01',
      rank: json['tier']?.toString(),
      rating: rating is num ? rating.toInt() : null,
      winRate: winRate is num ? winRate.toInt() : null,
    );
  }
}