import 'package:geolocator/geolocator.dart';

class GeoResult {
  const GeoResult({
    required this.success,
    this.latitude,
    this.longitude,
    this.message,
  });

  final bool success;
  final double? latitude;
  final double? longitude;
  final String? message;
}

/// Resolves the device GPS position so it can be sent to the backend's
/// /auth/geo-locate endpoint for a behind-the-scenes country check.
class GeoService {
  /// Requests location permission (if needed) and grabs the current position.
  static Future<GeoResult> checkLocation({
    Future<Position> Function()? getPosition,
  }) async {
    try {
      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
      }
      if (permission == LocationPermission.denied ||
          permission == LocationPermission.deniedForever) {
        return const GeoResult(
          success: false,
          message: 'Location access is required to verify your region.',
        );
      }

      if (getPosition != null) {
        final position = await getPosition();
        return GeoResult(
          success: true,
          latitude: position.latitude,
          longitude: position.longitude,
        );
      }

      Position position;
      try {
        // High accuracy forces GPS, which is what both real devices and the
        // emulator's `geo fix` feed. Low accuracy can resolve to a network
        // default (e.g. the emulator's US fallback) and wrongly geo-block.
        position = await Geolocator.getCurrentPosition(
          desiredAccuracy: LocationAccuracy.high,
          timeLimit: const Duration(seconds: 10),
        );
      } catch (_) {
        // GPS not available (indoor, no fix yet): fall back to any provider.
        position = await Geolocator.getCurrentPosition(
          desiredAccuracy: LocationAccuracy.low,
        );
      }

      return GeoResult(
        success: true,
        latitude: position.latitude,
        longitude: position.longitude,
      );
    } catch (_) {
      return const GeoResult(
        success: false,
        message: 'Could not verify your location. Please try again.',
      );
    }
  }
}
