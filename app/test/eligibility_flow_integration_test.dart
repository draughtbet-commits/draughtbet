import 'package:dio/dio.dart';
import 'package:draughts_arena/models/deposit_flow.dart';
import 'package:draughts_arena/models/eligibility.dart';
import 'package:draughts_arena/models/match_flow.dart';
import 'package:draughts_arena/models/withdrawal_flow.dart';
import 'package:draughts_arena/providers/deposit_provider.dart';
import 'package:draughts_arena/providers/match_flow_provider.dart';
import 'package:draughts_arena/providers/withdrawal_provider.dart';
import 'package:draughts_arena/services/deposit_gateway.dart';
import 'package:draughts_arena/services/deposit_recovery_store.dart';
import 'package:draughts_arena/services/match_flow_gateway.dart';
import 'package:draughts_arena/services/withdrawal_gateway.dart';
import 'package:draughts_arena/services/withdrawal_recovery_store.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

class _MockMatchGateway extends Mock implements MatchFlowGateway {}

class _MockDepositGateway extends Mock implements DepositGateway {}

class _MockDepositStore extends Mock implements DepositRecoveryStore {}

class _MockWithdrawalGateway extends Mock implements WithdrawalGateway {}

class _MockWithdrawalStore extends Mock implements WithdrawalRecoveryStore {}

void main() {
  setUpAll(() {
    registerFallbackValue(
      const DepositQuote(
        id: 'fallback',
        amountMinorUnits: 100,
        currency: 'NGN',
        paymentMethods: [],
      ),
    );
    registerFallbackValue(
      const DepositPaymentMethod(id: 'paystack', label: 'Card'),
    );
    registerFallbackValue(
      const WithdrawalQuote(
        id: 'fallback',
        amountMinorUnits: 100,
        currency: 'NGN',
        eligibility: WithdrawalEligibility.eligible,
      ),
    );
    registerFallbackValue(
      const WithdrawalBankAccount(
        id: 'bank-fallback',
        bankCode: '000',
        bankName: 'Bank',
        accountName: 'Player',
        maskedAccountNumber: '••••0000',
      ),
    );
  });

  test('match action preserves typed server eligibility decision', () async {
    final gateway = _MockMatchGateway();
    when(() => gateway.isV2).thenReturn(false);
    when(() => gateway.acceptOpenMatch('open-1')).thenThrow(
      _dioError(
        422,
        'Stake exceeds your safer-play limit',
        '/callouts/open-1/accept',
      ),
    );
    final notifier = MatchFlowNotifier(gateway)
      ..review(
        const MatchFlowIntent(
          kind: MatchEntryKind.openMatch,
          openMatchId: 'open-1',
          terms: MatchTerms(
            stakeMinorUnits: 200000,
            timeControl: '10 minutes',
            gameType: 'Classic',
            board: '10x10',
          ),
        ),
      );
    expect(await notifier.confirm(), isNull);
    expect(
      notifier.state.eligibilityDecision?.reason,
      EligibilityReason.stakeLimitExceeded,
    );
    expect(notifier.state.actionPhase, MatchActionPhase.failed);
  });

  test(
    'deposit intent surfaces self-exclusion without crediting locally',
    () async {
      final gateway = _MockDepositGateway();
      final store = _MockDepositStore();
      const method = DepositPaymentMethod(id: 'paystack', label: 'Card');
      const quote = DepositQuote(
        id: 'quote-1',
        amountMinorUnits: 500000,
        currency: 'NGN',
        paymentMethods: [method],
      );
      when(() => gateway.createQuote(500000)).thenAnswer((_) async => quote);
      when(() => gateway.createIntent(quote: quote, method: method)).thenThrow(
        _dioError(
          403,
          'Self-exclusion is active until 2026-10-24T10:00:00.000Z',
          '/wallet/deposit-intent',
        ),
      );
      final notifier = DepositNotifier(gateway, store);
      expect(await notifier.requestQuote(500000), isTrue);
      notifier.selectMethod(method);
      expect(await notifier.createIntent(), isFalse);
      expect(notifier.state.intent, isNull);
      expect(
        notifier.state.eligibilityDecision?.reason,
        EligibilityReason.selfExcluded,
      );
    },
  );

  test('withdrawal submission routes KYC-required server response', () async {
    final gateway = _MockWithdrawalGateway();
    final store = _MockWithdrawalStore();
    const quote = WithdrawalQuote(
      id: 'withdraw-quote',
      amountMinorUnits: 200000,
      currency: 'NGN',
      eligibility: WithdrawalEligibility.eligible,
    );
    const bank = WithdrawalBankAccount(
      id: 'bank-1',
      bankCode: '044',
      bankName: 'Access Bank',
      accountName: 'Verified Player',
      maskedAccountNumber: '••••7890',
    );
    when(() => gateway.createQuote(200000)).thenAnswer((_) async => quote);
    when(() => gateway.fetchBankAccounts()).thenAnswer((_) async => [bank]);
    when(
      () => gateway.createWithdrawal(quote: quote, bankAccount: bank),
    ).thenThrow(
      _dioError(
        403,
        'KYC verification is required for this action',
        '/wallet/withdrawal-request',
      ),
    );
    final notifier = WithdrawalNotifier(gateway, store);
    expect(
      await notifier.requestQuote(200000),
      WithdrawalFlowPhase.selectingBank,
    );
    expect(await notifier.loadBankAccounts(), isTrue);
    notifier.selectBankAccount(bank);
    expect(await notifier.createWithdrawal(), isFalse);
    expect(notifier.state.phase, WithdrawalFlowPhase.verificationRequired);
    expect(
      notifier.state.eligibilityDecision?.reason,
      EligibilityReason.kycRequired,
    );
  });
}

DioException _dioError(int status, String message, String path) {
  final request = RequestOptions(path: path);
  return DioException(
    requestOptions: request,
    response: Response<dynamic>(
      requestOptions: request,
      statusCode: status,
      data: {'error': message},
    ),
    type: DioExceptionType.badResponse,
  );
}
