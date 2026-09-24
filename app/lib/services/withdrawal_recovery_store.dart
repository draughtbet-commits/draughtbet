import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'secure_storage.dart';

abstract class WithdrawalRecoveryStore {
  Future<String?> readReference();
  Future<void> saveReference(String reference);
  Future<void> clearReference();
}

class SecureWithdrawalRecoveryStore implements WithdrawalRecoveryStore {
  SecureWithdrawalRecoveryStore(this._storage);

  final SecureStorageService _storage;

  @override
  Future<String?> readReference() => _storage.activeWithdrawalReference;

  @override
  Future<void> saveReference(String reference) =>
      _storage.setActiveWithdrawalReference(reference);

  @override
  Future<void> clearReference() => _storage.clearActiveWithdrawalReference();
}

final withdrawalRecoveryStoreProvider = Provider<WithdrawalRecoveryStore>(
  (ref) => SecureWithdrawalRecoveryStore(SecureStorageService()),
);
