import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import 'fcm_service.dart';

/// Registers this device's FCM token with the backend so offline notifications
/// can be pushed. Best-effort: never throws, and no-ops when push is unavailable
/// (Firebase not configured or the device denied permission).
Future<void> registerDevicePushToken(Dio dio) async {
  try {
    final token = await fcmService.getToken();
    if (token == null || token.isEmpty) return;
    await dio.post(
      '/me/push-tokens',
      data: {'token': token, 'platform': _platformName()},
    );
  } catch (e) {
    debugPrint('Push token registration failed: $e');
  }
}

String _platformName() {
  if (kIsWeb) return 'web';
  switch (defaultTargetPlatform) {
    case TargetPlatform.iOS:
      return 'ios';
    default:
      return 'android';
  }
}
