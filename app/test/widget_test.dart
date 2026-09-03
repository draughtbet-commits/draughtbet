import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:draughts_arena/main.dart';

void main() {
  testWidgets('App boots and renders the login screen', (WidgetTester tester) async {
    // Mock secure storage so the auth session restore completes (token absent).
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
      const MethodChannel('plugins.it_nomads.com/flutter_secure_storage'),
      (call) async => null,
    );

    await tester.pumpWidget(const ProviderScope(child: DraughtsArenaApp()));
    await tester.pump(const Duration(seconds: 1));
    await tester.pump(const Duration(seconds: 1));

    expect(find.text('Draught Bet'), findsOneWidget);
    expect(find.text('Sign in'), findsOneWidget);
  });
}