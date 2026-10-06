import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/app_notification.dart';
import '../services/api_client.dart';
import '../services/socket_service.dart';

enum NotificationLoadPhase { initial, loading, ready, empty, refreshing, error }

class NotificationState {
  const NotificationState({
    required this.notifications,
    required this.unreadCount,
    required this.isLoading,
    this.phase = NotificationLoadPhase.initial,
    this.page = 1,
    this.totalPages = 1,
    this.message,
  });

  final List<AppNotification> notifications;
  final int unreadCount;
  final bool isLoading;
  final NotificationLoadPhase phase;
  final int page;
  final int totalPages;
  final String? message;

  bool get hasMore => page < totalPages;

  NotificationState copyWith({
    List<AppNotification>? notifications,
    int? unreadCount,
    bool? isLoading,
    NotificationLoadPhase? phase,
    int? page,
    int? totalPages,
    String? message,
    bool clearMessage = false,
  }) => NotificationState(
    notifications: notifications ?? this.notifications,
    unreadCount: unreadCount ?? this.unreadCount,
    isLoading: isLoading ?? this.isLoading,
    phase: phase ?? this.phase,
    page: page ?? this.page,
    totalPages: totalPages ?? this.totalPages,
    message: clearMessage ? null : message ?? this.message,
  );
}

typedef NotificationDelay = Future<void> Function(Duration duration);

class NotificationNotifier extends StateNotifier<NotificationState> {
  NotificationNotifier(
    this._dio,
    this._socket, {
    bool initialize = true,
    NotificationDelay delay = Future<void>.delayed,
  }) : _delay = delay,
       super(
         const NotificationState(
           notifications: [],
           unreadCount: 0,
           isLoading: true,
           phase: NotificationLoadPhase.initial,
         ),
       ) {
    if (initialize) _init();
  }

  final Dio _dio;
  final SocketService _socket;
  final NotificationDelay _delay;
  StreamSubscription<Map<String, dynamic>>? _socketSub;
  bool _requestInFlight = false;

  void _init() {
    unawaited(refresh());
    _socketSub = _socket.onNotification.listen(_onNewNotification);
  }

  void _onNewNotification(Map<String, dynamic> data) {
    final incoming = AppNotification.tryFromJson(data);
    if (incoming == null) return;
    final withoutReplay = state.notifications
        .where((notification) => notification.id != incoming.id)
        .toList();
    final notifications = [incoming, ...withoutReplay]
      ..sort((a, b) => b.createdAt.compareTo(a.createdAt));
    state = state.copyWith(
      notifications: notifications,
      unreadCount: _unreadCount(notifications),
      isLoading: false,
      phase: NotificationLoadPhase.ready,
      clearMessage: true,
    );
  }

  Future<bool> refresh({int maxAttempts = 3}) async {
    if (_requestInFlight) return false;
    _requestInFlight = true;
    state = state.copyWith(
      isLoading: state.notifications.isEmpty,
      phase: state.notifications.isEmpty
          ? NotificationLoadPhase.loading
          : NotificationLoadPhase.refreshing,
      clearMessage: true,
    );
    try {
      for (var attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          final response = await _dio.get<Map<String, dynamic>>(
            '/notifications',
            queryParameters: const {'page': 1, 'limit': 20},
          );
          final parsed = _parsePage(response.data);
          if (parsed == null) {
            throw const FormatException('Invalid notification response');
          }
          if (!mounted) return false;
          state = NotificationState(
            notifications: parsed.items,
            unreadCount: _unreadCount(parsed.items),
            isLoading: false,
            phase: parsed.items.isEmpty
                ? NotificationLoadPhase.empty
                : NotificationLoadPhase.ready,
            page: parsed.page,
            totalPages: parsed.totalPages,
          );
          return true;
        } catch (_) {
          if (attempt == maxAttempts) rethrow;
          await _delay(Duration(milliseconds: 250 * (1 << (attempt - 1))));
        }
      }
    } catch (_) {
      if (!mounted) return false;
      state = state.copyWith(
        isLoading: false,
        phase: NotificationLoadPhase.error,
        message:
            'Notifications could not be refreshed. Your account activity is unchanged.',
      );
    } finally {
      _requestInFlight = false;
    }
    return false;
  }

  Future<bool> loadMore() async {
    if (_requestInFlight || !state.hasMore) return false;
    _requestInFlight = true;
    try {
      final nextPage = state.page + 1;
      final response = await _dio.get<Map<String, dynamic>>(
        '/notifications',
        queryParameters: {'page': nextPage, 'limit': 20},
      );
      final parsed = _parsePage(response.data);
      if (parsed == null || parsed.page != nextPage) return false;
      final byId = <String, AppNotification>{
        for (final item in state.notifications) item.id: item,
        for (final item in parsed.items) item.id: item,
      };
      final notifications = byId.values.toList()
        ..sort((a, b) => b.createdAt.compareTo(a.createdAt));
      if (!mounted) return false;
      state = state.copyWith(
        notifications: notifications,
        unreadCount: _unreadCount(notifications),
        page: parsed.page,
        totalPages: parsed.totalPages,
        phase: NotificationLoadPhase.ready,
        clearMessage: true,
      );
      return true;
    } catch (_) {
      if (!mounted) return false;
      state = state.copyWith(
        message: 'More notifications could not be loaded.',
      );
      return false;
    } finally {
      _requestInFlight = false;
    }
  }

  Future<bool> markAsRead(String id) async {
    AppNotification? notification;
    for (final item in state.notifications) {
      if (item.id == id) {
        notification = item;
        break;
      }
    }
    if (notification == null || notification.isRead) {
      return notification != null;
    }
    try {
      await _dio.patch<void>('/notifications/$id/read');
      final notifications = state.notifications
          .map((item) => item.id == id ? item.copyWith(isRead: true) : item)
          .toList();
      if (!mounted) return false;
      state = state.copyWith(
        notifications: notifications,
        unreadCount: _unreadCount(notifications),
        clearMessage: true,
      );
      return true;
    } catch (_) {
      if (!mounted) return false;
      state = state.copyWith(
        message: 'This notification could not be marked as read.',
      );
      return false;
    }
  }

  Future<bool> markAllAsRead() async {
    if (state.unreadCount == 0) return true;
    try {
      await _dio.patch<void>('/notifications/read-all');
      final notifications = state.notifications
          .map((item) => item.copyWith(isRead: true))
          .toList();
      if (!mounted) return false;
      state = state.copyWith(
        notifications: notifications,
        unreadCount: 0,
        clearMessage: true,
      );
      return true;
    } catch (_) {
      if (!mounted) return false;
      state = state.copyWith(
        message: 'Notifications could not be marked as read.',
      );
      return false;
    }
  }

  _NotificationPage? _parsePage(Map<String, dynamic>? json) {
    if (json == null || json['items'] is! List) return null;
    final items =
        (json['items'] as List)
            .map(AppNotification.tryFromJson)
            .whereType<AppNotification>()
            .toList()
          ..sort((a, b) => b.createdAt.compareTo(a.createdAt));
    final page = int.tryParse(json['page']?.toString() ?? '');
    final totalPages = int.tryParse(json['totalPages']?.toString() ?? '');
    if (page == null || page < 1 || totalPages == null || totalPages < 0) {
      return null;
    }
    return _NotificationPage(
      items: items,
      page: page,
      totalPages: totalPages == 0 ? 1 : totalPages,
    );
  }

  int _unreadCount(List<AppNotification> items) =>
      items.where((item) => !item.isRead).length;

  @override
  void dispose() {
    _socketSub?.cancel();
    super.dispose();
  }
}

class _NotificationPage {
  const _NotificationPage({
    required this.items,
    required this.page,
    required this.totalPages,
  });

  final List<AppNotification> items;
  final int page;
  final int totalPages;
}

final notificationProvider =
    StateNotifierProvider<NotificationNotifier, NotificationState>((ref) {
      return NotificationNotifier(ref.watch(apiClientProvider), socketService);
    });
