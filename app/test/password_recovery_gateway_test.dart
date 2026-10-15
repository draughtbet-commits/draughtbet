import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:draughts_arena/services/password_recovery_gateway.dart';
import 'package:flutter_test/flutter_test.dart';

class RecordingAdapter implements HttpClientAdapter {
  final requests = <RequestOptions>[];
  final _responses = <(int, Object)>[];

  void enqueue(Object response, {int status = 200}) =>
      _responses.add((status, response));

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requests.add(options);
    if (_responses.isEmpty) {
      throw StateError('No response queued for ${options.method} ${options.path}');
    }
    final (status, response) = _responses.removeAt(0);
    return ResponseBody.fromString(
      jsonEncode(response),
      status,
      headers: {
        Headers.contentTypeHeader: ['application/json'],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

(Dio, RecordingAdapter) client() {
  final adapter = RecordingAdapter();
  final dio = Dio(BaseOptions(baseUrl: 'https://api.example.test/api/v1'));
  dio.httpClientAdapter = adapter;
  return (dio, adapter);
}

void main() {
  group('HttpPasswordRecoveryGateway.requestCode', () {
    test('posts the identifier and unwraps the data envelope', () async {
      final (dio, adapter) = client();
      adapter.enqueue({
        'data': {
          'accepted': true,
          'maskedContact': 't***@example.com',
          'challengeId': 'challenge-1',
          'expiresInSeconds': 300,
          'resendAfterSeconds': 45,
        },
      });

      final challenge = await HttpPasswordRecoveryGateway(
        dio,
      ).requestCode('test@example.com');

      expect(adapter.requests.single.path, '/auth/forgot-password');
      expect(adapter.requests.single.method, 'POST');
      expect(
        (adapter.requests.single.data as Map)['identifier'],
        'test@example.com',
      );
      expect(challenge.id, 'challenge-1');
      expect(challenge.maskedContact, 't***@example.com');
      expect(challenge.resendAfter, const Duration(seconds: 45));
    });

    test('accepts a flat body with no envelope too', () async {
      final (dio, adapter) = client();
      adapter.enqueue({
        'accepted': true,
        'maskedContact': 'f***@example.com',
        'challengeId': 'challenge-flat',
        'resendAfterSeconds': 60,
      });

      final challenge = await HttpPasswordRecoveryGateway(
        dio,
      ).requestCode('flat@example.com');

      expect(challenge.id, 'challenge-flat');
      expect(challenge.maskedContact, 'f***@example.com');
    });

    test('surfaces unavailable when no challengeId comes back', () async {
      final (dio, adapter) = client();
      adapter.enqueue({'data': {'accepted': true}});

      await expectLater(
        HttpPasswordRecoveryGateway(dio).requestCode('nobody@example.com'),
        throwsA(
          isA<RecoveryException>().having(
            (e) => e.failure,
            'failure',
            RecoveryFailure.unavailable,
          ),
        ),
      );
    });
  });

  group('HttpPasswordRecoveryGateway.resetPassword', () {
    test('decodes the grant and posts challengeId + code + newPassword',
        () async {
      final (dio, adapter) = client();
      final gateway = HttpPasswordRecoveryGateway(dio);
      final grant = await gateway.verifyCode('challenge-1', '123456');
      expect(grant, isNotEmpty);

      adapter.enqueue({
        'data': {'reset': true, 'sessionsRevoked': true},
      });
      final ok = await gateway.resetPassword(grant, 'NewPassword1');

      expect(ok, isTrue);
      final request = adapter.requests.single;
      expect(request.path, '/auth/reset-password');
      expect(request.data, {
        'challengeId': 'challenge-1',
        'code': '123456',
        'newPassword': 'NewPassword1',
      });
    });

    test('maps an invalid code envelope to invalidCode', () async {
      final (dio, adapter) = client();
      final gateway = HttpPasswordRecoveryGateway(dio);
      final grant = await gateway.verifyCode('challenge-1', '000000');
      adapter.enqueue(
        {
          'error': {'code': 'OTP_INVALID', 'message': 'Invalid code'},
        },
        status: 400,
      );

      await expectLater(
        gateway.resetPassword(grant, 'NewPassword1'),
        throwsA(
          isA<RecoveryException>().having(
            (e) => e.failure,
            'failure',
            RecoveryFailure.invalidCode,
          ),
        ),
      );
    });

    test('maps an expired challenge to expired', () async {
      final (dio, adapter) = client();
      final gateway = HttpPasswordRecoveryGateway(dio);
      final grant = await gateway.verifyCode('challenge-1', '123456');
      adapter.enqueue(
        {
          'error': {'code': 'OTP_EXPIRED', 'message': 'Challenge expired'},
        },
        status: 410,
      );

      await expectLater(
        gateway.resetPassword(grant, 'NewPassword1'),
        throwsA(
          isA<RecoveryException>().having(
            (e) => e.failure,
            'failure',
            RecoveryFailure.expired,
          ),
        ),
      );
    });

    test('rejects a grant it cannot decode', () async {
      final (dio, _) = client();
      await expectLater(
        HttpPasswordRecoveryGateway(dio).resetPassword('not-a-grant', 'NewPass1'),
        throwsA(
          isA<RecoveryException>().having(
            (e) => e.failure,
            'failure',
            RecoveryFailure.expired,
          ),
        ),
      );
    });
  });
}
