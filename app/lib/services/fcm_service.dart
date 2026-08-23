import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'socket_service.dart';

class FCMService {
  final FlutterLocalNotificationsPlugin _flutterLocalNotificationsPlugin =
      FlutterLocalNotificationsPlugin();

  FCMService() {
    _initLocalNotifications();
    _listenToSocketForForegroundMock();
  }

  Future<void> _initLocalNotifications() async {
    const AndroidInitializationSettings initializationSettingsAndroid =
        AndroidInitializationSettings('@mipmap/ic_launcher');
        
    const InitializationSettings initializationSettings =
        InitializationSettings(android: initializationSettingsAndroid);
        
    await _flutterLocalNotificationsPlugin.initialize(
      initializationSettings,
      onDidReceiveNotificationResponse: (NotificationResponse response) {
        // Handle tap on notification here (e.g., navigate to link)
      },
    );
  }

  void _listenToSocketForForegroundMock() {
    // MOCK: Since Firebase is not configured, we use the realtime socket event
    // to trigger a local banner when the app is in the foreground.
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
        
    await _flutterLocalNotificationsPlugin.show(
      DateTime.now().millisecond, // unique id
      title,
      body,
      platformChannelSpecifics,
    );
  }

  Future<String?> getToken() async {
    // Return a mock token for now
    return "mock_fcm_token_123456";
  }
}

final fcmService = FCMService();
