import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'socket_service.dart';

/// Background/terminated FCM handler. The OS delivers notification-type messages
/// itself; this exists so data-only messages are still processed with Firebase
/// available in the background isolate.
@pragma('vm:entry-point')
Future<void> firebaseMessagingBackgroundHandler(RemoteMessage message) async {
  try {
    await Firebase.initializeApp();
  } catch (_) {
    // Firebase not configured on this build; nothing to do.
  }
}

/// Real push transport. Everything here is best-effort and never throws: when
/// Firebase is not configured (no google-services.json / initializeApp skipped),
/// [getToken] returns null and the app simply keeps using the socket path. The
/// foreground socket banner below remains the live in-app path; FCM is the
/// offline fallback delivered by the backend outbox drainer.
class FCMService {
  final FlutterLocalNotificationsPlugin _flutterLocalNotificationsPlugin =
      FlutterLocalNotificationsPlugin();

  FirebaseMessaging? _messaging;
  bool _ready = false;
  bool _initAttempted = false;

  /// Invoked when FCM rotates the device token, so the caller can re-register.
  void Function(String token)? onTokenRefresh;

  FCMService() {
    _initLocalNotifications();
    _listenToSocketForForegroundMock();
  }

  /// Initializes Firebase Messaging and notification permission. Safe to call
  /// repeatedly; returns true only when push delivery is actually available.
  Future<bool> init() async {
    if (_ready) return true;
    if (_initAttempted) return false;
    _initAttempted = true;

    try {
      // Firebase.initializeApp() must have succeeded first (see main()).
      if (Firebase.apps.isEmpty) return false;

      final messaging = FirebaseMessaging.instance;
      _messaging = messaging;

      await messaging.requestPermission(
        alert: true,
        badge: true,
        sound: true,
      );
      // iOS foreground presentation.
      await messaging.setForegroundNotificationPresentationOptions(
        alert: true,
        badge: true,
        sound: true,
      );

      FirebaseMessaging.onMessage.listen(_onForegroundMessage);
      messaging.onTokenRefresh.listen((token) => onTokenRefresh?.call(token));

      _ready = true;
      return true;
    } catch (e) {
      debugPrint('FCM init failed: $e');
      return false;
    }
  }

  Future<String?> getToken() async {
    final available = await init();
    if (!available) return null;
    try {
      return await _messaging!.getToken();
    } catch (e) {
      debugPrint('FCM getToken failed: $e');
      return null;
    }
  }

  void _onForegroundMessage(RemoteMessage message) {
    final notification = message.notification;
    final title = notification?.title ?? message.data['title'] as String?;
    final body = notification?.body ?? message.data['message'] as String?;
    if (title != null && body != null) {
      showForegroundBanner(title, body);
    }
  }

  Future<void> _initLocalNotifications() async {
    const AndroidInitializationSettings initializationSettingsAndroid =
        AndroidInitializationSettings('@mipmap/ic_launcher');

    const InitializationSettings initializationSettings =
        InitializationSettings(android: initializationSettingsAndroid);

    try {
      await _flutterLocalNotificationsPlugin.initialize(
        initializationSettings,
        onDidReceiveNotificationResponse: (NotificationResponse response) {
          // Handle tap on notification here (e.g., navigate to link)
        },
      );
    } catch (e) {
      debugPrint('Local notifications init failed: $e');
    }
  }

  void _listenToSocketForForegroundMock() {
    // Foreground in-app notification path: the live socket delivers a
    // notification event and we surface it as a local banner. This keeps
    // foreground UX working even when FCM is not configured.
    socketService.onNotification.listen((data) {
      final title = data['title'] as String?;
      final body = data['message'] as String?;
      if (title != null && body != null) {
        showForegroundBanner(title, body);
      }
    });
  }

  Future<void> showForegroundBanner(String title, String body) async {
    const AndroidNotificationDetails androidPlatformChannelSpecifics =
        AndroidNotificationDetails(
      'high_importance_channel', // id
      'High Importance Notifications', // name
      channelDescription: 'This channel is used for important notifications.',
      importance: Importance.max,
      priority: Priority.high,
    );
    const NotificationDetails platformChannelSpecifics =
        NotificationDetails(android: androidPlatformChannelSpecifics);

    try {
      await _flutterLocalNotificationsPlugin.show(
        DateTime.now().millisecond, // unique id
        title,
        body,
        platformChannelSpecifics,
      );
    } catch (e) {
      debugPrint('Foreground banner failed: $e');
    }
  }
}

final fcmService = FCMService();
