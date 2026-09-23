import 'package:dio/dio.dart';
import 'package:draughts_arena/models/deposit_flow.dart';
import 'package:draughts_arena/providers/deposit_provider.dart';
import 'package:draughts_arena/screens/deposit_flow_screens.dart';
import 'package:draughts_arena/services/deposit_gateway.dart';
import 'package:draughts_arena/services/deposit_recovery_store.dart';
import 'package:draughts_arena/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'deposit_fixtures.dart';

const _captureKey = ValueKey('deposit-flow-capture');

class _VisualGateway extends DepositGateway {
  _VisualGateway() : super(Dio());
}

class _VisualStore implements DepositRecoveryStore {
  @override
  Future<void> clearReference() async {}

  @override
  Future<String?> readReference() async => null;

  @override
  Future<void> saveReference(String reference) async {}
}

class _VisualNotifier extends DepositNotifier {
  _VisualNotifier(DepositFlowState initial)
    : super(_VisualGateway(), _VisualStore()) {
    state = initial;
  }
}

void _setViewport(WidgetTester tester) {
  tester.view.physicalSize = const Size(412, 915);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

Widget _capture(Widget child, DepositFlowState state) => ProviderScope(
  overrides: [depositProvider.overrideWith((ref) => _VisualNotifier(state))],
  child: MaterialApp(
    theme: AppTheme.dark,
    home: RepaintBoundary(key: _captureKey, child: child),
  ),
);

Future<void> _verify(WidgetTester tester, String name) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 180));
  expect(tester.takeException(), isNull);
  await expectLater(
    find.byKey(_captureKey),
    matchesGoldenFile('goldens/deposit_flow/$name.png'),
  );
}

void main() {
  setUpAll(() async {
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

  final intentByStatus = <DepositStatus, DepositIntentData>{
    for (final status in DepositStatus.values)
      status: depositIntentFixture(
        status: status,
        failureReason: status == DepositStatus.failed
            ? 'The provider declined this payment.'
            : null,
      ),
  };

  final captures = <String, (Widget, DepositFlowState)>{
    '45_add_money': (
      const AddMoneyScreen(initialAmount: '2000'),
      DepositFlowState(
        phase: DepositFlowPhase.selectingMethod,
        quote: depositQuoteFixture,
      ),
    ),
    '46_payment_method': (
      const PaymentMethodScreen(),
      DepositFlowState(
        phase: DepositFlowPhase.selectingMethod,
        quote: depositQuoteFixture,
        selectedMethod: depositMethodsFixture.first,
      ),
    ),
    'm6_hosted_checkout': (
      const HostedCheckoutScreen(),
      DepositFlowState(
        phase: DepositFlowPhase.checkoutReady,
        quote: depositQuoteFixture,
        selectedMethod: depositMethodsFixture.first,
        intent: intentByStatus[DepositStatus.pending],
      ),
    ),
    '47_deposit_processing': (
      const DepositStatusScreen(
        requestedPhase: DepositFlowPhase.processing,
        autoRefresh: false,
      ),
      DepositFlowState(
        phase: DepositFlowPhase.processing,
        intent: intentByStatus[DepositStatus.processing],
      ),
    ),
    '48_deposit_successful': (
      const DepositStatusScreen(
        requestedPhase: DepositFlowPhase.successful,
        autoRefresh: false,
      ),
      DepositFlowState(
        phase: DepositFlowPhase.successful,
        intent: intentByStatus[DepositStatus.successful],
      ),
    ),
    '49_deposit_failed': (
      const DepositStatusScreen(
        requestedPhase: DepositFlowPhase.failed,
        autoRefresh: false,
      ),
      DepositFlowState(
        phase: DepositFlowPhase.failed,
        intent: intentByStatus[DepositStatus.failed],
      ),
    ),
    'm7_deposit_pending': (
      const DepositStatusScreen(
        requestedPhase: DepositFlowPhase.pending,
        autoRefresh: false,
      ),
      DepositFlowState(
        phase: DepositFlowPhase.pending,
        intent: intentByStatus[DepositStatus.pending],
      ),
    ),
  };

  for (final capture in captures.entries) {
    testWidgets('capture ${capture.key}', (tester) async {
      _setViewport(tester);
      await tester.pumpWidget(_capture(capture.value.$1, capture.value.$2));
      await _verify(tester, capture.key);
    });
  }
}
