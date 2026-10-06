import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../models/dispute.dart';

/// Central wrapper around [FlutterSecureStorage].
///
/// The design doc mandates that credentials live in secure storage and that
/// providers never touch [FlutterSecureStorage] directly. All token/preference
/// keys are defined here so the rest of the app reads and writes them through
/// this single source of truth.
class SecureStorageService {
  SecureStorageService([FlutterSecureStorage? storage])
    : _storage = storage ?? const FlutterSecureStorage();

  static const _accessTokenKey = 'jwt';
  static const _refreshTokenKey = 'refresh_token';
  static const _userIdKey = 'user_id';
  static const _activeMatchIdKey = 'active_match_id';
  static const _activeDepositReferenceKey = 'active_deposit_reference';
  // GET /withdrawals/{withdrawalId} resolves on the row id, so recovery has to
  // persist the id. The old reference key is kept only to clear on logout.
  static const _activeWithdrawalIdKey = 'active_withdrawal_id';
  static const _activeWithdrawalReferenceKey = 'active_withdrawal_reference';
  static const _submittedDisputesKey = 'submitted_disputes';

  final FlutterSecureStorage _storage;

  Future<String?> get accessToken => _storage.read(key: _accessTokenKey);
  Future<String?> get refreshToken => _storage.read(key: _refreshTokenKey);
  Future<String?> get userId => _storage.read(key: _userIdKey);
  Future<String?> get activeMatchId => _storage.read(key: _activeMatchIdKey);
  Future<String?> get activeDepositReference =>
      _storage.read(key: _activeDepositReferenceKey);
  Future<String?> get activeWithdrawalId =>
      _storage.read(key: _activeWithdrawalIdKey);

  Future<List<DisputeCaseRef>> loadDisputeRefs() async {
    final raw = await _storage.read(key: _submittedDisputesKey);
    if (raw == null || raw.isEmpty) return const [];
    final parsed = jsonDecode(raw);
    if (parsed is! List) return const [];
    return parsed
        .map(DisputeCaseRef.tryFromJson)
        .whereType<DisputeCaseRef>()
        .toList(growable: false);
  }

  Future<void> storeDisputeRef(DisputeCaseRef ref) async {
    final existing = await loadDisputeRefs();
    final next = <DisputeCaseRef>[
      for (final entry in existing)
        if (entry.matchId != ref.matchId && entry.disputeId != ref.disputeId)
          entry,
      ref,
    ];
    await saveDisputeRefs(next);
  }

  /// Replaces the whole remembered-submission list (used when the server has
  /// dropped a case so a stale "Reported" row stops lingering on the results).
  Future<void> saveDisputeRefs(List<DisputeCaseRef> refs) =>
      _storage.write(
        key: _submittedDisputesKey,
        value: jsonEncode([for (final entry in refs) entry.toJson()]),
      );

  Future<void> setAccessToken(String token) =>
      _storage.write(key: _accessTokenKey, value: token);

  Future<void> setRefreshToken(String token) =>
      _storage.write(key: _refreshTokenKey, value: token);

  Future<void> setUserId(String id) =>
      _storage.write(key: _userIdKey, value: id);

  Future<void> setActiveMatchId(String id) =>
      _storage.write(key: _activeMatchIdKey, value: id);

  Future<void> clearActiveMatchId() => _storage.delete(key: _activeMatchIdKey);

  Future<void> setActiveDepositReference(String reference) =>
      _storage.write(key: _activeDepositReferenceKey, value: reference);

  Future<void> clearActiveDepositReference() =>
      _storage.delete(key: _activeDepositReferenceKey);

  Future<void> setActiveWithdrawalId(String id) =>
      _storage.write(key: _activeWithdrawalIdKey, value: id);

  Future<void> clearActiveWithdrawalId() =>
      _storage.delete(key: _activeWithdrawalIdKey);

  /// Removes the pre-§6 key so a stale reference cannot be mistaken for an id.
  Future<void> clearLegacyActiveWithdrawalReference() =>
      _storage.delete(key: _activeWithdrawalReferenceKey);

  /// Wipes every credential the app owns (used on logout / expiry).
  Future<void> clearCredentials() async {
    await _storage.delete(key: _accessTokenKey);
    await _storage.delete(key: _refreshTokenKey);
    await _storage.delete(key: _userIdKey);
    await _storage.delete(key: _activeMatchIdKey);
    await _storage.delete(key: _activeDepositReferenceKey);
    await _storage.delete(key: _activeWithdrawalIdKey);
    await _storage.delete(key: _activeWithdrawalReferenceKey);
    await _storage.delete(key: _submittedDisputesKey);
  }

  Future<String?> read({required String key}) => _storage.read(key: key);

  Future<void> write({required String key, required String value}) =>
      _storage.write(key: key, value: value);

  Future<void> delete({required String key}) => _storage.delete(key: key);
}
