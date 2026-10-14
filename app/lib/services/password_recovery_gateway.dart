import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Client boundary only. The checked-in auth controller does not expose
/// recovery routes. A future adapter must map its reviewed server contract.
abstract interface class PasswordRecoveryGateway {
  Future<RecoveryChallenge> requestCode(String contact);
  Future<String> verifyCode(String challengeId, String code);
  Future<bool> resetPassword(String resetGrant, String password);
}

class RecoveryChallenge {
  const RecoveryChallenge({
    required this.id,
    required this.maskedContact,
    required this.resendAfter,
  });
  final String id;
  final String maskedContact;
  final Duration resendAfter;
}

enum RecoveryFailure { unavailable, invalidCode, expired, rateLimited, network }

class RecoveryException implements Exception {
  const RecoveryException(this.failure);
  final RecoveryFailure failure;
}

class UnavailablePasswordRecoveryGateway implements PasswordRecoveryGateway {
  const UnavailablePasswordRecoveryGateway();

  @override
  Future<RecoveryChallenge> requestCode(String contact) async =>
      throw const RecoveryException(RecoveryFailure.unavailable);

  @override
  Future<String> verifyCode(String challengeId, String code) async =>
      throw const RecoveryException(RecoveryFailure.unavailable);

  @override
  Future<bool> resetPassword(String resetGrant, String password) async =>
      throw const RecoveryException(RecoveryFailure.unavailable);
}

final passwordRecoveryGatewayProvider = Provider<PasswordRecoveryGateway>(
  (ref) => const UnavailablePasswordRecoveryGateway(),
);
