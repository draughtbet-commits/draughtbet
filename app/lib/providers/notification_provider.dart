import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'package:dio/dio.dart';
import '../services/socket_service.dart';

// Very simple notification model to handle JSON from backend
class AppNotification {
  final String id;
  final String type;
  final String title;
  final String message;
  final String? link;
  final bool isRead;
  final DateTime createdAt;

  AppNotification({
    required this.id,
    required this.type,
    required this.title,
    required this.message,
    this.link,
    required this.isRead,
    required this.createdAt,
  });

  factory AppNotification.fromJson(Map<String, dynamic> json) {
    return AppNotification(
      id: json['id'],
      type: json['type'],
      title: json['title'],
      message: json['message'],
      link: json['link'],
      isRead: json['isRead'],
      createdAt: DateTime.parse(json['createdAt']),
    );
  }
}

class NotificationState {
  final List<AppNotification> notifications;
  final int unreadCount;
  final bool isLoading;

  NotificationState({
    required this.notifications,
    required this.unreadCount,
    required this.isLoading,
  });

  NotificationState copyWith({
    List<AppNotification>? notifications,
    int? unreadCount,
    bool? isLoading,
  }) {
    return NotificationState(
      notifications: notifications ?? this.notifications,
      unreadCount: unreadCount ?? this.unreadCount,
      isLoading: isLoading ?? this.isLoading,
    );
  }
}

class NotificationNotifier extends StateNotifier<NotificationState> {
  final Dio _dio;
  final SocketService _socket;
  StreamSubscription? _socketSub;

  NotificationNotifier(this._dio, this._socket)
      : super(NotificationState(
            notifications: [], unreadCount: 0, isLoading: true)) {
    _init();
  }

  void _init() {
    _fetchNotifications();
    _socketSub = _socket.onNotification.listen(_onNewNotification);
  }

  void _onNewNotification(dynamic data) {
    final newNotification = AppNotification.fromJson(data);
    
    // Add to top of list and increment unread count
    state = state.copyWith(
      notifications: [newNotification, ...state.notifications],
      unreadCount: state.unreadCount + 1,
    );
  }

  Future<void> _fetchNotifications() async {
    try {
      final storage = const FlutterSecureStorage();
      final token = await storage.read(key: 'jwt');
      final backendUrl = dotenv.env['BACKEND_URL'] ?? 'http://localhost:3000';

      final response = await _dio.get(
        '$backendUrl/notifications?limit=20',
        options: Options(headers: {'Authorization': 'Bearer $token'}),
      );
      
      final items = (response.data['items'] as List)
          .map((item) => AppNotification.fromJson(item))
          .toList();
          
      // Calculate unread from fetched list
      final unread = items.where((n) => !n.isRead).length;

      state = state.copyWith(
        notifications: items,
        unreadCount: unread,
        isLoading: false,
      );
    } catch (e) {
      state = state.copyWith(isLoading: false);
    }
  }

  Future<void> markAsRead(String id) async {
    try {
      final storage = const FlutterSecureStorage();
      final token = await storage.read(key: 'jwt');
      final backendUrl = dotenv.env['BACKEND_URL'] ?? 'http://localhost:3000';

      await _dio.patch(
        '$backendUrl/notifications/$id/read',
        options: Options(headers: {'Authorization': 'Bearer $token'}),
      );
      
      final updatedNotifications = state.notifications.map((n) {
        if (n.id == id && !n.isRead) {
          return AppNotification(
            id: n.id,
            type: n.type,
            title: n.title,
            message: n.message,
            link: n.link,
            isRead: true,
            createdAt: n.createdAt,
          );
        }
        return n;
      }).toList();

      state = state.copyWith(
        notifications: updatedNotifications,
        unreadCount: (state.unreadCount > 0) ? state.unreadCount - 1 : 0,
      );
    } catch (e) {
      // Handle error gracefully
    }
  }

  Future<void> markAllAsRead() async {
    try {
      final storage = const FlutterSecureStorage();
      final token = await storage.read(key: 'jwt');
      final backendUrl = dotenv.env['BACKEND_URL'] ?? 'http://localhost:3000';

      await _dio.patch(
        '$backendUrl/notifications/read-all',
        options: Options(headers: {'Authorization': 'Bearer $token'}),
      );
      
      final updatedNotifications = state.notifications.map((n) {
        return AppNotification(
          id: n.id,
          type: n.type,
          title: n.title,
          message: n.message,
          link: n.link,
          isRead: true,
          createdAt: n.createdAt,
        );
      }).toList();

      state = state.copyWith(
        notifications: updatedNotifications,
        unreadCount: 0,
      );
    } catch (e) {
      // Handle error
    }
  }

  @override
  void dispose() {
    _socketSub?.cancel();
    super.dispose();
  }
}

final notificationProvider =
    StateNotifierProvider<NotificationNotifier, NotificationState>((ref) {
  final dio = Dio();
  return NotificationNotifier(dio, socketService);
});
