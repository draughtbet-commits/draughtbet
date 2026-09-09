import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:draughts_arena/main.dart';

void main() {
  testWidgets('App boots and renders the landing/onboarding screen', (WidgetTester tester) async {
    // Mock secure storage so the auth session restore completes (token absent).
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
      const MethodChannel('plugins.it_nomads.com/flutter_secure_storage'),
      (call) async => null,
    );
    // LandingPage awaits SharedPreferences.getInstance() on boot; without mock
    // values that future never settles in a widget test.
    SharedPreferences.setMockInitialValues({'onboarding_completed': false});

    await tester.pumpWidget(const ProviderScope(child: DraughtsArenaApp()));
    await tester.pump(const Duration(seconds: 1));
    await tester.pump(const Duration(seconds: 1));

    expect(find.text('DRAUGHT\nBET', findRichText: true), findsOneWidget);
    expect(find.text('Play smart. Compete fairly'), findsOneWidget);
  });
}
