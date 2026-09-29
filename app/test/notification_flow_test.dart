import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:draughts_arena/models/app_notification.dart';
import 'package:draughts_arena/providers/notification_provider.dart';
import 'package:draughts_arena/screens/notification_screens.dart';
import 'package:draughts_arena/services/socket_service.dart';
import 'package:draughts_arena/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

final _now = DateTime.now().toUtc();

final _matchNotice = AppNotification(
  id: 'notice-match',
  type: 'MATCH_ENDED_WIN',
  title: 'Match won',
  message: 'You defeated KingMoves.',
  link: '/results',
  matchId: 'match-1',
  isRead: false,
  createdAt: _now.subtract(const Duration(minutes: 2)),
);

final _disputeNotice = AppNotification(
  id: 'notice-dispute',
  type: 'DISPUTE_UPDATED',
  title: 'Dispute update',
  message: 'Your report is under review.',
  link: '/profile/dispute-status?id=DRP1',
  isRead: true,
  createdAt: _now.subtract(const Duration(hours: 2)),
);

Map<String, Object?> _json(AppNotification item) => {
  'id': item.id,
  'type': item.type,
  'title': item.title,
  'message': item.message,
  'link': item.link,
  'matchId': item.matchId,
  'isRead': item.isRead,
  'createdAt': item.createdAt.toIso8601String(),
};

class _RecordingAdapter implements HttpClientAdapter {
  final requests = <RequestOptions>[];
  final responses = <({int status, Object body})>[];

  void enqueue(Object body, {int status = 200}) =>
      responses.add((status: status, body: body));

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requests.add(options);
    final response = responses.removeAt(0);
    return ResponseBody.fromString(
      jsonEncode(response.body),
      response.status,
      headers: {
        Headers.contentTypeHeader: ['application/json'],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

class _Socket extends SocketService {
  final controller = StreamController<Map<String, dynamic>>.broadcast();

  @override
  Stream<Map<String, dynamic>> get onNotification => controller.stream;

  Future<void> emit(AppNotification notification) async {
    controller.add(_json(notification));
    await Future<void>.delayed(Duration.zero);
  }

  @override
  void dispose() {
    controller.close();
    super.dispose();
  }
}

class _SeededNotifier extends NotificationNotifier {
  _SeededNotifier(NotificationState initial)
    : super(Dio(), _Socket(), initialize: false) {
    state = initial;
  }

  @override
  Future<bool> refresh({int maxAttempts = 3}) async => true;

  @override
  Future<bool> markAsRead(String id) async {
    final items = state.notifications
        .map((item) => item.id == id ? item.copyWith(isRead: true) : item)
        .toList();
    state = state.copyWith(
      notifications: items,
      unreadCount: items.where((item) => !item.isRead).length,
    );
    return true;
  }
}

class _HttpNotifier extends NotificationNotifier {
  // Private positional fields in NotificationNotifier cannot be forwarded as
  // public super-parameters from this test library.
  // ignore: use_super_parameters
  _HttpNotifier(Dio dio, SocketService socket)
    : super(dio, socket, initialize: false);

  void seed(NotificationState value) => state = value;
}

NotificationState _state(List<AppNotification> items) => NotificationState(
  notifications: items,
  unreadCount: items.where((item) => !item.isRead).length,
  isLoading: false,
  phase: items.isEmpty
      ? NotificationLoadPhase.empty
      : NotificationLoadPhase.ready,
);

void main() {
  setUp(() {
    FlutterSecureStorage.setMockInitialValues({
      'pref_notification_matches': 'true',
      'pref_notification_disputes': 'true',
      'pref_notification_promotions': 'false',
    });
  });

  test('parses only complete server notification data and safe links', () {
    final parsed = AppNotification.tryFromJson(_json(_matchNotice));
    expect(parsed?.id, _matchNotice.id);
    expect(parsed?.category, NotificationCategory.matches);
    expect(parsed?.hasSafeLink, isTrue);
    expect(
      AppNotification.tryFromJson({..._json(_matchNotice), 'isRead': 'no'}),
      isNull,
    );
    expect(
      AppNotification.tryFromJson({..._json(_matchNotice), 'title': ''}),
      isNull,
    );
    expect(
      AppNotification.tryFromJson({
        ..._json(_matchNotice),
        'link': 'https://bad.example/token',
      })?.hasSafeLink,
      isFalse,
    );
  });

  test(
    'loads the documented paginated endpoint and trusts server fields',
    () async {
      final adapter = _RecordingAdapter()
        ..enqueue({
          'items': [_json(_matchNotice), _json(_disputeNotice)],
          'total': 2,
          'page': 1,
          'limit': 20,
          'totalPages': 1,
        });
      final dio = Dio(BaseOptions(baseUrl: 'https://api.example.test'))
        ..httpClientAdapter = adapter;
      final socket = _Socket();
      addTearDown(socket.dispose);
      final notifier = NotificationNotifier(dio, socket, initialize: false);

      expect(await notifier.refresh(maxAttempts: 1), isTrue);
      expect(adapter.requests.single.path, '/notifications');
      expect(adapter.requests.single.queryParameters, {'page': 1, 'limit': 20});
      expect(notifier.state.notifications.first.title, 'Match won');
      expect(notifier.state.unreadCount, 1);
    },
  );

  test('safe read retry uses bounded exponential backoff', () async {
    final adapter = _RecordingAdapter()
      ..enqueue({'error': 'offline'}, status: 503)
      ..enqueue({'error': 'offline'}, status: 503)
      ..enqueue({
        'items': <Object>[],
        'total': 0,
        'page': 1,
        'limit': 20,
        'totalPages': 0,
      });
    final dio = Dio(BaseOptions(baseUrl: 'https://api.example.test'))
      ..httpClientAdapter = adapter;
    final delays = <Duration>[];
    final socket = _Socket();
    addTearDown(socket.dispose);
    final notifier = NotificationNotifier(
      dio,
      socket,
      initialize: false,
      delay: (duration) async => delays.add(duration),
    );

    expect(await notifier.refresh(), isTrue);
    expect(delays, const [
      Duration(milliseconds: 250),
      Duration(milliseconds: 500),
    ]);
    expect(notifier.state.phase, NotificationLoadPhase.empty);
  });

  test('outbox replay is deduplicated by the server notification id', () async {
    final adapter = _RecordingAdapter()
      ..enqueue({
        'items': <Object>[],
        'total': 0,
        'page': 1,
        'limit': 20,
        'totalPages': 0,
      });
    final dio = Dio(BaseOptions(baseUrl: 'https://api.example.test'))
      ..httpClientAdapter = adapter;
    final socket = _Socket();
    final notifier = NotificationNotifier(
      dio,
      socket,
      initialize: true,
      delay: (_) async {},
    );
    addTearDown(notifier.dispose);
    await Future<void>.delayed(Duration.zero);
    await socket.emit(_matchNotice);
    await socket.emit(_matchNotice);
    expect(
      notifier.state.notifications.where((item) => item.id == _matchNotice.id),
      hasLength(1),
    );
    expect(notifier.state.unreadCount, 1);
  });

  test(
    'mark read changes local state only after backend confirmation',
    () async {
      final adapter = _RecordingAdapter()..enqueue({'success': true});
      final dio = Dio(BaseOptions(baseUrl: 'https://api.example.test'))
        ..httpClientAdapter = adapter;
      final socket = _Socket();
      addTearDown(socket.dispose);
      final notifier = _HttpNotifier(dio, socket)..seed(_state([_matchNotice]));

      expect(await notifier.markAsRead(_matchNotice.id), isTrue);
      expect(adapter.requests.single.path, '/notifications/notice-match/read');
      expect(notifier.state.unreadCount, 0);
      expect(notifier.state.notifications.single.isRead, isTrue);
    },
  );

  testWidgets('renders all filters and notification details navigation', (
    tester,
  ) async {
    final notifier = _SeededNotifier(_state([_matchNotice, _disputeNotice]));
    final router = GoRouter(
      initialLocation: '/profile/notifications',
      routes: [
        GoRoute(
          path: '/profile/notifications',
          builder: (_, _) => const NotificationsScreen(),
        ),
        GoRoute(
          path: '/profile/notification-details',
          builder: (_, state) => NotificationDetailsScreen(
            notification: state.extra! as AppNotification,
          ),
        ),
      ],
    );
    addTearDown(router.dispose);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [notificationProvider.overrideWith((ref) => notifier)],
        child: MaterialApp.router(theme: AppTheme.dark, routerConfig: router),
      ),
    );
    await tester.pump();
    expect(find.text('Match won'), findsOneWidget);
    expect(find.text('Dispute update'), findsOneWidget);
    await tester.tap(find.text('Disputes'));
    await tester.pump();
    expect(find.text('Match won'), findsNothing);
    await tester.tap(find.text('Dispute update'));
    await tester.pumpAndSettle();
    expect(find.text('NOTIFICATION DETAILS'), findsOneWidget);
    expect(find.text('Your report is under review.'), findsOneWidget);
  });

  testWidgets('empty, error and invalid-link states are safe', (tester) async {
    await _pump(
      tester,
      const NotificationsScreen(),
      _SeededNotifier(_state(const [])),
    );
    expect(find.text('YOU’RE ALL CAUGHT UP'), findsOneWidget);

    await _pump(
      tester,
      const NotificationsScreen(),
      _SeededNotifier(
        const NotificationState(
          notifications: [],
          unreadCount: 0,
          isLoading: false,
          phase: NotificationLoadPhase.error,
          message: 'Offline',
        ),
      ),
    );
    expect(find.text('NOTIFICATIONS UNAVAILABLE'), findsOneWidget);

    final unsafe = AppNotification(
      id: 'unsafe',
      type: 'SYSTEM',
      title: 'Account update',
      message: 'Review your account.',
      link: 'https://bad.example/private',
      isRead: false,
      createdAt: _now,
    );
    await _pump(
      tester,
      NotificationDetailsScreen(notification: unsafe),
      _SeededNotifier(_state([unsafe])),
    );
    expect(find.text('Open related item'), findsNothing);
  });

  testWidgets('preferences keep critical money and security alerts enabled', (
    tester,
  ) async {
    await _pump(
      tester,
      const NotificationPreferencesScreen(),
      _SeededNotifier(_state(const [])),
    );
    await tester.pumpAndSettle();
    expect(find.text('Money and security updates'), findsOneWidget);
    final switches = tester.widgetList<Switch>(find.byType(Switch)).toList();
    expect(switches, hasLength(4));
    expect(switches.last.value, isTrue);
    expect(switches.last.onChanged, isNull);
    await tester.ensureVisible(find.text('Save preferences'));
    await tester.tap(find.text('Save preferences'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('Notification preferences saved.'), findsOneWidget);
  });

  testWidgets('PR12 screens do not overflow on compact phones and text scale', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(320, 568);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final notifier = _SeededNotifier(_state([_matchNotice, _disputeNotice]));
    for (final screen in <Widget>[
      const NotificationsScreen(),
      NotificationDetailsScreen(notification: _matchNotice),
      const NotificationPreferencesScreen(),
    ]) {
      await _pump(
        tester,
        screen,
        notifier,
        textScaler: const TextScaler.linear(1.25),
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull, reason: '$screen');
    }
  });
}

Future<void> _pump(
  WidgetTester tester,
  Widget screen,
  NotificationNotifier notifier, {
  TextScaler textScaler = TextScaler.noScaling,
}) async {
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pumpWidget(
    ProviderScope(
      overrides: [notificationProvider.overrideWith((ref) => notifier)],
      child: MaterialApp(
        theme: AppTheme.dark,
        home: MediaQuery(
          data: MediaQueryData(textScaler: textScaler),
          child: screen,
        ),
      ),
    ),
  );
  await tester.pump();
}
