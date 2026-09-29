import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'secure_storage.dart';

/// Persists the active withdrawal so the app can resume tracking it after a
/// restart. This holds the row **id**, because the contract's status route is
/// `GET /withdrawals/{withdrawalId}` and a `wit-` reference 404s there.
abstract class WithdrawalRecoveryStore {
  Future<String?> readWithdrawalId();
  Future<void> saveWithdrawalId(String id);
  Future<void> clearWithdrawalId();
}

class SecureWithdrawalRecoveryStore implements WithdrawalRecoveryStore {
  SecureWithdrawalRecoveryStore(this._storage);

  final SecureStorageService _storage;

  @override
  Future<String?> readWithdrawalId() => _storage.activeWithdrawalId;

  @override
  Future<void> saveWithdrawalId(String id) =>
      _storage.setActiveWithdrawalId(id);

  @override
  Future<void> clearWithdrawalId() => _storage.clearActiveWithdrawalId();
}

final withdrawalRecoveryStoreProvider = Provider<WithdrawalRecoveryStore>(
  (ref) => SecureWithdrawalRecoveryStore(SecureStorageService()),
);
