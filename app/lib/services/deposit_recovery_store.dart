import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'secure_storage.dart';

abstract class DepositRecoveryStore {
  Future<String?> readReference();
  Future<void> saveReference(String reference);
  Future<void> clearReference();
}

class SecureDepositRecoveryStore implements DepositRecoveryStore {
  SecureDepositRecoveryStore(this._storage);

  final SecureStorageService _storage;

  @override
  Future<String?> readReference() => _storage.activeDepositReference;

  @override
  Future<void> saveReference(String reference) =>
      _storage.setActiveDepositReference(reference);

  @override
  Future<void> clearReference() => _storage.clearActiveDepositReference();
}

final depositRecoveryStoreProvider = Provider<DepositRecoveryStore>(
  (ref) => SecureDepositRecoveryStore(SecureStorageService()),
);
