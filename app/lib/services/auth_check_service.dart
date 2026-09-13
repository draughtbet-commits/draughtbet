import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'api_client.dart';

class AvailabilityResult {
  const AvailabilityResult({required this.available});
  final bool available;
}

class GeoLocateResult {
  const GeoLocateResult({required this.allowed, this.countryCode, this.binding});
  final bool allowed;
  final String? countryCode;
  final String? binding;
}

/// Public pre-auth calls used by the register/sign-in forms:
/// real-time uniqueness checks and the behind-the-scenes country gate.
class AuthCheckService {
  AuthCheckService(this._dio);
  final Dio _dio;

  /// Asks the backend whether an email/phone/username is already taken.
  Future<AvailabilityResult> checkAvailability(String type, String value) async {
    final res = await _dio.post('/auth/check-availability', data: {
      'type': type,
      'value': value,
    });
    return AvailabilityResult(
      available: (res.data['available'] as bool?) ?? true,
    );
  }

  /// Sends GPS coordinates so the backend can reverse-geocode and decide if
  /// the country may use the platform. The backend returns an opaque binding
  /// token that must be replayed at registration to prove the country came
  /// from this server-side resolution.
  Future<GeoLocateResult> geoLocate(double lat, double lng) async {
    final res = await _dio.post('/auth/geo-locate', data: {
      'lat': lat,
      'lng': lng,
    });
    return GeoLocateResult(
      allowed: (res.data['allowed'] as bool?) ?? false,
      countryCode: res.data['countryCode'] as String?,
      binding: res.data['binding'] as String?,
    );
  }
}

final authCheckServiceProvider = Provider<AuthCheckService>(
  (ref) => AuthCheckService(ref.watch(apiClientProvider)),
);