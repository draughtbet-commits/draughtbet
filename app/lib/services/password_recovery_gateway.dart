import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/backend_contract.dart';
import 'api_client.dart';

/// Client boundary for the password-recovery flow. The reviewed server contract
/// is the backend's `/auth/forgot-password` + `/auth/reset-password` pair; the
/// screen's three steps map onto them (see [HttpPasswordRecoveryGateway]).
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

/// Always reports recovery as unavailable. Used as the test/offline fallback.
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

/// Maps the three UI steps onto the backend's two endpoints:
///
/// * [requestCode] -> `POST /auth/forgot-password { identifier }`, which now
///   returns `{ accepted, maskedContact, challengeId, resendAfterSeconds }`.
///   The server deliberately answers an identical shape for unknown accounts
///   (with an unpersisted decoy challengeId), so this never leaks existence.
/// * [verifyCode] cannot hit a dedicated endpoint — the backend validates the
///   code inside reset-password — so it packs `challengeId` + `code` into an
///   opaque grant the screen carries to the final step. The code is not a
///   secret from this client, so encoding it is safe.
/// * [resetPassword] -> `POST /auth/reset-password { challengeId, code,
///   newPassword }`, unpacking the grant.
class HttpPasswordRecoveryGateway implements PasswordRecoveryGateway {
  HttpPasswordRecoveryGateway(this._dio);

  final Dio _dio;

  @override
  Future<RecoveryChallenge> requestCode(String contact) async {
    try {
      final response = await _dio.post<dynamic>(
        '/auth/forgot-password',
        data: {'identifier': contact},
      );
      final data = unwrapData(response.data) ?? <String, dynamic>{};
      final id = data['challengeId']?.toString().trim() ?? '';
      if (id.isEmpty) {
        // No challengeId means recovery is genuinely unavailable; stop before
        // advancing to a code step that could never succeed.
        throw const RecoveryException(RecoveryFailure.unavailable);
      }
      return RecoveryChallenge(
        id: id,
        maskedContact: data['maskedContact']?.toString() ?? contact,
        resendAfter: _seconds(data['resendAfterSeconds']),
      );
    } on DioException catch (error) {
      throw _mapError(error);
    }
  }

  @override
  Future<String> verifyCode(String challengeId, String code) async {
    return base64Url.encode(utf8.encode('$challengeId\u0000$code'));
  }

  @override
  Future<bool> resetPassword(String resetGrant, String password) async {
    final decoded = _decodeGrant(resetGrant);
    if (decoded == null) {
      throw const RecoveryException(RecoveryFailure.expired);
    }
    try {
      final response = await _dio.post<dynamic>(
        '/auth/reset-password',
        data: {
          'challengeId': decoded.$1,
          'code': decoded.$2,
          'newPassword': password,
        },
      );
      final data = unwrapData(response.data);
      return data != null && data['reset'] == true;
    } on DioException catch (error) {
      throw _mapError(error);
    }
  }

  (String, String)? _decodeGrant(String grant) {
    try {
      final raw = utf8.decode(base64Url.decode(grant));
      final separator = raw.indexOf('\u0000');
      if (separator <= 0) return null;
      return (raw.substring(0, separator), raw.substring(separator + 1));
    } catch (_) {
      return null;
    }
  }

  Duration _seconds(Object? value) {
    final parsed = int.tryParse(value?.toString() ?? '');
    return Duration(seconds: parsed != null && parsed >= 0 ? parsed : 60);
  }

  RecoveryException _mapError(DioException error) {
    final status = error.response?.statusCode;
    final code = _errorCode(error);
    final failure = switch (code) {
      'OTP_INVALID' || 'FORBIDDEN' => RecoveryFailure.invalidCode,
      'OTP_EXPIRED' => RecoveryFailure.expired,
      'OTP_ATTEMPTS_EXCEEDED' || 'RATE_LIMITED' => RecoveryFailure.rateLimited,
      _ when _isNetwork(error) => RecoveryFailure.network,
      _ when status == 410 => RecoveryFailure.expired,
      _ when status == 429 => RecoveryFailure.rateLimited,
      _ => RecoveryFailure.unavailable,
    };
    return RecoveryException(failure);
  }

  bool _isNetwork(DioException error) =>
      error.type == DioExceptionType.connectionError ||
      error.type == DioExceptionType.connectionTimeout ||
      error.type == DioExceptionType.receiveTimeout ||
      error.type == DioExceptionType.sendTimeout;

  String? _errorCode(DioException error) {
    final data = error.response?.data;
    if (data is Map) {
      final nested = data['error'];
      if (nested is Map) return nested['code']?.toString();
      return data['code']?.toString();
    }
    return null;
  }
}

final passwordRecoveryGatewayProvider = Provider<PasswordRecoveryGateway>(
  (ref) => HttpPasswordRecoveryGateway(ref.watch(apiClientProvider)),
);
