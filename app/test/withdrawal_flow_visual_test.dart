import 'package:dio/dio.dart';
import 'package:draughts_arena/models/withdrawal_flow.dart';
import 'package:draughts_arena/providers/withdrawal_provider.dart';
import 'package:draughts_arena/screens/withdrawal_flow_screens.dart';
import 'package:draughts_arena/services/withdrawal_gateway.dart';
import 'package:draughts_arena/services/withdrawal_recovery_store.dart';
import 'package:draughts_arena/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'withdrawal_fixtures.dart';

const _captureKey = ValueKey('withdrawal-flow-capture');

class _VisualGateway extends WithdrawalGateway {
  _VisualGateway() : super(Dio());
}

class _VisualStore implements WithdrawalRecoveryStore {
  @override
  Future<void> clearReference() async {}

  @override
  Future<String?> readReference() async => null;

  @override
  Future<void> saveReference(String reference) async {}
}

class _VisualNotifier extends WithdrawalNotifier {
  _VisualNotifier(WithdrawalFlowState initial)
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

Widget _capture(Widget child, WithdrawalFlowState state) => ProviderScope(
  overrides: [withdrawalProvider.overrideWith((ref) => _VisualNotifier(state))],
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
    matchesGoldenFile('goldens/withdrawal_flow/$name.png'),
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

  final pending = withdrawalDataFixture();
  final captures = <String, (Widget, WithdrawalFlowState)>{
    '53_withdraw_money': (
      const WithdrawMoneyScreen(initialAmount: '5000'),
      WithdrawalFlowState(
        phase: WithdrawalFlowPhase.selectingBank,
        quote: withdrawalQuoteFixture,
      ),
    ),
    '54_select_bank_account': (
      const SelectBankAccountScreen(autoLoad: false),
      WithdrawalFlowState(
        phase: WithdrawalFlowPhase.selectingBank,
        quote: withdrawalQuoteFixture,
        bankAccounts: withdrawalBanksFixture,
        selectedBankAccount: withdrawalBanksFixture.first,
      ),
    ),
    '55_add_bank_account': (
      const AddBankAccountScreen(),
      WithdrawalFlowState(
        phase: WithdrawalFlowPhase.selectingBank,
        quote: withdrawalQuoteFixture,
      ),
    ),
    '56_verifying_bank_account': (
      const VerifyingBankAccountScreen(),
      WithdrawalFlowState(
        phase: WithdrawalFlowPhase.verifyingBank,
        quote: withdrawalQuoteFixture,
      ),
    ),
    '57_withdrawal_review': (
      const WithdrawalReviewScreen(),
      WithdrawalFlowState(
        phase: WithdrawalFlowPhase.reviewing,
        quote: withdrawalQuoteFixture,
        bankAccounts: withdrawalBanksFixture,
        selectedBankAccount: withdrawalBanksFixture.first,
      ),
    ),
    '58_verification_required': (
      const WithdrawalGateScreen(
        phase: WithdrawalFlowPhase.verificationRequired,
      ),
      WithdrawalFlowState(
        phase: WithdrawalFlowPhase.verificationRequired,
        quote: WithdrawalQuote(
          id: 'kyc-gate',
          amountMinorUnits: 500000,
          currency: 'NGN',
          eligibility: WithdrawalEligibility.verificationRequired,
        ),
      ),
    ),
    '59_withdrawal_pending_review': (
      const WithdrawalStatusScreen(
        requestedPhase: WithdrawalFlowPhase.pendingReview,
        autoRefresh: false,
      ),
      WithdrawalFlowState(
        phase: WithdrawalFlowPhase.pendingReview,
        withdrawal: pending,
      ),
    ),
    '60_withdrawal_processing': (
      const WithdrawalStatusScreen(
        requestedPhase: WithdrawalFlowPhase.processing,
        autoRefresh: false,
      ),
      WithdrawalFlowState(
        phase: WithdrawalFlowPhase.processing,
        withdrawal: withdrawalDataFixture(status: WithdrawalStatus.processing),
      ),
    ),
    '61_withdrawal_successful': (
      const WithdrawalStatusScreen(
        requestedPhase: WithdrawalFlowPhase.successful,
        autoRefresh: false,
      ),
      WithdrawalFlowState(
        phase: WithdrawalFlowPhase.successful,
        withdrawal: withdrawalDataFixture(status: WithdrawalStatus.successful),
      ),
    ),
    '62_withdrawal_reversed': (
      const WithdrawalStatusScreen(
        requestedPhase: WithdrawalFlowPhase.reversed,
        autoRefresh: false,
      ),
      WithdrawalFlowState(
        phase: WithdrawalFlowPhase.reversed,
        withdrawal: withdrawalDataFixture(
          status: WithdrawalStatus.reversed,
          failureReason:
              'The provider could not complete the payout. Funds were returned.',
        ),
      ),
    ),
    '63_withdrawal_limit_reached': (
      const WithdrawalGateScreen(phase: WithdrawalFlowPhase.limitReached),
      const WithdrawalFlowState(
        phase: WithdrawalFlowPhase.limitReached,
        quote: WithdrawalQuote(
          id: 'limit-gate',
          amountMinorUnits: 500000,
          currency: 'NGN',
          eligibility: WithdrawalEligibility.limitReached,
          limitMinorUnits: 200000,
        ),
      ),
    ),
    '134_saved_bank_accounts': (
      const SavedBankAccountsScreen(autoLoad: false),
      const WithdrawalFlowState(
        phase: WithdrawalFlowPhase.selectingBank,
        bankAccounts: withdrawalBanksFixture,
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
