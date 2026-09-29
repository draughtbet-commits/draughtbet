import 'package:dio/dio.dart';
import 'package:draughts_arena/models/app_notification.dart';
import 'package:draughts_arena/providers/notification_provider.dart';
import 'package:draughts_arena/screens/notification_screens.dart';
import 'package:draughts_arena/services/socket_service.dart';
import 'package:draughts_arena/theme/app_theme.dart';
import 'package:draughts_arena/widgets/main_layout.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

const _captureKey = ValueKey('pr12-capture');

final _notices = [
  AppNotification(
    id: 'notice-1',
    type: 'DISPUTE_UPDATED',
    title: 'Dispute update',
    message: 'Your report #DRP89231 is under review.',
    link: '/profile/dispute-status?id=DRP89231',
    isRead: false,
    createdAt: DateTime.utc(2024, 5, 11, 19, 41),
  ),
  AppNotification(
    id: 'notice-2',
    type: 'MATCH_ENDED_WIN',
    title: 'Match settled',
    message: 'You won against KingMoves.',
    link: '/results',
    matchId: 'DB241567',
    isRead: false,
    createdAt: DateTime.utc(2024, 5, 11, 18, 41),
  ),
  AppNotification(
    id: 'notice-3',
    type: 'SUPPORT_MESSAGE',
    title: 'New message',
    message: 'Support replied to your report.',
    isRead: true,
    createdAt: DateTime.utc(2024, 5, 11, 16, 41),
  ),
  AppNotification(
    id: 'notice-4',
    type: 'PROMOTIONAL',
    title: 'Promotion!',
    message: 'King Promotion is live this weekend.',
    isRead: true,
    createdAt: DateTime.utc(2024, 5, 10, 19, 41),
  ),
  AppNotification(
    id: 'notice-5',
    type: 'WITHDRAWAL_CONFIRMED',
    title: 'Withdrawal successful',
    message: 'Your bank payout was confirmed.',
    link: '/wallet',
    isRead: true,
    createdAt: DateTime.utc(2024, 5, 9, 19, 41),
  ),
  AppNotification(
    id: 'notice-6',
    type: 'MATCH_REMINDER',
    title: 'Match reminder',
    message: 'Your match with QueenBee starts in 10 minutes.',
    link: '/arena',
    matchId: 'DB241568',
    isRead: true,
    createdAt: DateTime.utc(2024, 5, 8, 19, 41),
  ),
];

class _VisualNotifier extends NotificationNotifier {
  _VisualNotifier(List<AppNotification> notifications)
    : super(Dio(), SocketService(), initialize: false) {
    state = NotificationState(
      notifications: notifications,
      unreadCount: notifications.where((item) => !item.isRead).length,
      isLoading: false,
      phase: notifications.isEmpty
          ? NotificationLoadPhase.empty
          : NotificationLoadPhase.ready,
    );
  }

  @override
  Future<bool> refresh({int maxAttempts = 3}) async => true;
}

void _setViewport(WidgetTester tester) {
  tester.view.physicalSize = const Size(412, 915);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

Future<void> _capture(
  WidgetTester tester, {
  required Widget screen,
  required String name,
  List<AppNotification> notifications = const [],
}) async {
  _setViewport(tester);
  final notifier = _VisualNotifier(notifications);
  final router = GoRouter(
    initialLocation: '/profile/capture',
    routes: [
      ShellRoute(
        builder: (_, _, child) => MainLayout(child: child),
        routes: [GoRoute(path: '/profile/capture', builder: (_, _) => screen)],
      ),
      GoRoute(path: '/arena', builder: (_, _) => const SizedBox.shrink()),
    ],
  );
  addTearDown(router.dispose);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [notificationProvider.overrideWith((ref) => notifier)],
      child: MaterialApp.router(
        theme: AppTheme.dark,
        routerConfig: router,
        builder: (context, child) => RepaintBoundary(
          key: _captureKey,
          child: child ?? const SizedBox.shrink(),
        ),
      ),
    ),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
  expect(tester.takeException(), isNull);
  await expectLater(
    find.byKey(_captureKey),
    matchesGoldenFile('goldens/pr12/$name.png'),
  );
}

void main() {
  setUpAll(() async {
    FlutterSecureStorage.setMockInitialValues({
      'pref_notification_matches': 'true',
      'pref_notification_disputes': 'true',
      'pref_notification_promotions': 'false',
    });
    final inter = FontLoader('Inter')
      ..addFont(rootBundle.load('assets/fonts/Inter-Variable.ttf'));
    final sora = FontLoader('Sora')
      ..addFont(rootBundle.load('assets/fonts/Sora-Variable.ttf'));
    final lucide = FontLoader('packages/lucide_icons_flutter/Lucide')
      ..addFont(
        rootBundle.load('packages/lucide_icons_flutter/assets/lucide.ttf'),
      );
    await Future.wait([inter.load(), sora.load(), lucide.load()]);
  });

  testWidgets('124 notifications', (tester) async {
    await _capture(
      tester,
      screen: const NotificationsScreen(),
      notifications: _notices,
      name: '124_notifications',
    );
  });

  testWidgets('125 no notifications', (tester) async {
    await _capture(
      tester,
      screen: const NotificationsScreen(),
      name: '125_no_notifications',
    );
  });

  testWidgets('126 notification details', (tester) async {
    await _capture(
      tester,
      screen: NotificationDetailsScreen(notification: _notices.first),
      notifications: _notices,
      name: '126_notification_details',
    );
  });

  testWidgets('133 notification preferences', (tester) async {
    await _capture(
      tester,
      screen: const NotificationPreferencesScreen(),
      name: '133_notification_preferences',
    );
  });
}
