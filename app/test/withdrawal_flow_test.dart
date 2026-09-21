import 'dart:async';

import 'package:dio/dio.dart';
import 'package:draughts_arena/models/withdrawal_flow.dart';
import 'package:draughts_arena/models/wallet_read.dart';
import 'package:draughts_arena/providers/withdrawal_provider.dart';
import 'package:draughts_arena/providers/wallet_provider.dart';
import 'package:draughts_arena/screens/withdrawal_flow_screens.dart';
import 'package:draughts_arena/screens/wallet_read_screens.dart';
import 'package:draughts_arena/services/socket_service.dart';
import 'package:draughts_arena/services/withdrawal_gateway.dart';
import 'package:draughts_arena/services/withdrawal_recovery_store.dart';
import 'package:draughts_arena/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'withdrawal_fixtures.dart';

class FakeWithdrawalGateway extends WithdrawalGateway {
  FakeWithdrawalGateway({
    this.quote,
    this.accounts = withdrawalBanksFixture,
    WithdrawalBankAccount? verifiedAccount,
    this.created,
    List<WithdrawalData?>? statuses,
  }) : statuses = statuses ?? <WithdrawalData?>[],
       verifiedAccount = verifiedAccount ?? withdrawalBanksFixture.first,
       super(Dio());

  WithdrawalQuote? quote;
  List<WithdrawalBankAccount>? accounts;
  WithdrawalBankAccount? verifiedAccount;
  WithdrawalData? created;
  final List<WithdrawalData?> statuses;
  bool throwQuote = false;
  bool blockCreate = false;
  final Completer<void> createGate = Completer<void>();
  int quoteCalls = 0;
  int bankReads = 0;
  int verifyCalls = 0;
  int createCalls = 0;
  int statusReads = 0;
  String? lastStatusReference;

  @override
  Future<WithdrawalQuote?> createQuote(int amountMinorUnits) async {
    quoteCalls += 1;
    if (throwQuote) throw DioException(requestOptions: RequestOptions());
    return quote;
  }

  @override
  Future<List<WithdrawalBankAccount>?> fetchBankAccounts() async {
    bankReads += 1;
    return accounts;
  }

  @override
  Future<WithdrawalBankAccount?> verifyBankAccount({
    required String bankCode,
    required String bankName,
    required String accountNumber,
    String? idempotencyKey,
  }) async {
    verifyCalls += 1;
    return verifiedAccount;
  }

  @override
  Future<WithdrawalData?> createWithdrawal({
    required WithdrawalQuote quote,
    required WithdrawalBankAccount bankAccount,
  }) async {
    createCalls += 1;
    if (blockCreate) await createGate.future;
    return created;
  }

  @override
  Future<WithdrawalData?> fetchStatus(
    String reference, {
    WithdrawalData? previous,
  }) async {
    statusReads += 1;
    lastStatusReference = reference;
    if (statuses.isEmpty) return previous;
    return statuses.removeAt(0);
  }
}

class MemoryWithdrawalRecoveryStore implements WithdrawalRecoveryStore {
  String? reference;
  int saves = 0;
  int clears = 0;

  @override
  Future<void> clearReference() async {
    clears += 1;
    reference = null;
  }

  @override
  Future<String?> readReference() async => reference;

  @override
  Future<void> saveReference(String reference) async {
    saves += 1;
    this.reference = reference;
  }
}

class SeededWithdrawalNotifier extends WithdrawalNotifier {
  // Private superclass fields cannot be forwarded as public super parameters.
  // ignore: use_super_parameters
  SeededWithdrawalNotifier(
    WithdrawalGateway gateway,
    WithdrawalRecoveryStore store,
    WithdrawalFlowState initial, {
    List<Duration>? backoff,
  }) : super(gateway, store, backoff: backoff) {
    state = initial;
  }
}

class StaticWalletNotifier extends WalletNotifier {
  StaticWalletNotifier(WalletState initial) : super(SocketService(), Dio()) {
    state = initial;
  }

  @override
  Future<void> fetchBalance() async {}

  @override
  Future<void> fetchTransactions({int page = 1, int limit = 20}) async {}
}

WithdrawalFlowState withdrawalState({
  WithdrawalFlowPhase phase = WithdrawalFlowPhase.selectingBank,
  WithdrawalQuote? quote,
  List<WithdrawalBankAccount> accounts = const [],
  WithdrawalBankAccount? selected,
  WithdrawalData? withdrawal,
  String? error,
}) => WithdrawalFlowState(
  phase: phase,
  quote: quote,
  bankAccounts: accounts,
  selectedBankAccount: selected,
  withdrawal: withdrawal,
  error: error,
);

Widget withdrawalApp(
  Widget child,
  WithdrawalNotifier notifier, {
  Size size = const Size(412, 915),
  double textScale = 1,
}) => ProviderScope(
  overrides: [withdrawalProvider.overrideWith((ref) => notifier)],
  child: MaterialApp(
    theme: AppTheme.dark,
    home: MediaQuery(
      data: MediaQueryData(
        size: size,
        textScaler: TextScaler.linear(textScale),
      ),
      child: child,
    ),
  ),
);

void setPhoneViewport(WidgetTester tester, {Size size = const Size(412, 915)}) {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

void main() {
  test('active backend gaps do not issue unsafe withdrawal requests', () async {
    final gateway = WithdrawalGateway(Dio());

    expect(await gateway.createQuote(200000), isNull);
    expect(await gateway.fetchBankAccounts(), isNull);
    expect(
      await gateway.verifyBankAccount(
        bankCode: '000',
        bankName: 'Bank',
        accountNumber: '0123456789',
      ),
      isNull,
    );
    expect(await gateway.fetchStatus('withdrawal-reference'), isNull);
  });

  test(
    'quote parser preserves server financial values without calculation',
    () {
      final quote = WithdrawalQuote.tryFromServer({
        'id': 'q1',
        'amountMinorUnits': 500000,
        'feeMinorUnits': 12345,
        'netAmountMinorUnits': 432109,
        'availableBalanceMinorUnits': 999999,
        'currency': 'NGN',
      });
      expect(quote?.feeMinorUnits, 12345);
      expect(quote?.netAmountMinorUnits, 432109);
      expect(quote?.netAmountMinorUnits, isNot(500000 - 12345));
    },
  );

  test('missing or invalid server values are rejected', () {
    expect(WithdrawalQuote.tryFromServer({'id': 'q1'}), isNull);
    expect(
      WithdrawalData.tryFromServer({
        'reference': 'w1',
        'amountMinorUnits': 100,
        'currency': 'NGN',
        'status': 'mystery',
      }),
      isNull,
    );
  });

  test('bank accounts and withdrawal references are masked', () {
    final account = WithdrawalBankAccount.tryFromServer({
      'id': 'b1',
      'bankCode': '011',
      'bankName': 'First Bank',
      'accountName': 'PRIVATE USER',
      'accountNumber': '0123456789',
    });
    final withdrawal = WithdrawalData.tryFromServer({
      'reference': 'PRIVATE-WDR-12345678',
      'amountMinorUnits': 10000,
      'currency': 'NGN',
      'status': 'pending_review',
      'bankAccount': {
        'id': 'b1',
        'bankCode': '011',
        'bankName': 'First Bank',
        'accountName': 'PRIVATE USER',
        'accountNumber': '0123456789',
      },
    });
    expect(account?.maskedAccountNumber, '••••6789');
    expect(withdrawal?.maskedReference, '••••5678');
    expect(account?.maskedAccountNumber, isNot(contains('012345')));
  });

  testWidgets('withdraw amount validates before requesting quote', (
    tester,
  ) async {
    setPhoneViewport(tester);
    final gateway = FakeWithdrawalGateway(quote: withdrawalQuoteFixture);
    final notifier = WithdrawalNotifier(
      gateway,
      MemoryWithdrawalRecoveryStore(),
    );
    await tester.pumpWidget(
      withdrawalApp(const WithdrawMoneyScreen(), notifier),
    );
    await tester.tap(find.text('Continue'));
    await tester.pump();
    expect(
      find.text('Enter a valid amount greater than zero.'),
      findsOneWidget,
    );
    expect(gateway.quoteCalls, 0);
  });

  testWidgets('saved banks render only server-provided accounts', (
    tester,
  ) async {
    setPhoneViewport(tester);
    final notifier = SeededWithdrawalNotifier(
      FakeWithdrawalGateway(),
      MemoryWithdrawalRecoveryStore(),
      withdrawalState(accounts: withdrawalBanksFixture),
    );
    await tester.pumpWidget(
      withdrawalApp(const SelectBankAccountScreen(autoLoad: false), notifier),
    );
    expect(find.text('First Bank'), findsOneWidget);
    expect(find.text('GTBank'), findsOneWidget);
    expect(find.text('Access Bank'), findsNothing);
  });

  testWidgets('empty server bank list shows unavailable state', (tester) async {
    setPhoneViewport(tester);
    final notifier = SeededWithdrawalNotifier(
      FakeWithdrawalGateway(accounts: const []),
      MemoryWithdrawalRecoveryStore(),
      withdrawalState(),
    );
    await tester.pumpWidget(
      withdrawalApp(const SelectBankAccountScreen(autoLoad: false), notifier),
    );
    expect(find.text('No saved bank accounts'), findsOneWidget);
  });

  test('server eligibility routes verification and limit gates', () async {
    for (final eligibility in [
      WithdrawalEligibility.verificationRequired,
      WithdrawalEligibility.limitReached,
    ]) {
      final quote = WithdrawalQuote(
        id: 'q-$eligibility',
        amountMinorUnits: 500000,
        currency: 'NGN',
        eligibility: eligibility,
      );
      final notifier = WithdrawalNotifier(
        FakeWithdrawalGateway(quote: quote),
        MemoryWithdrawalRecoveryStore(),
      );
      final phase = await notifier.requestQuote(500000);
      expect(
        phase,
        eligibility == WithdrawalEligibility.verificationRequired
            ? WithdrawalFlowPhase.verificationRequired
            : WithdrawalFlowPhase.limitReached,
      );
    }
  });

  test(
    'duplicate withdrawal submissions are blocked while in flight',
    () async {
      final gateway = FakeWithdrawalGateway(created: withdrawalDataFixture())
        ..blockCreate = true;
      final notifier = SeededWithdrawalNotifier(
        gateway,
        MemoryWithdrawalRecoveryStore(),
        withdrawalState(
          phase: WithdrawalFlowPhase.reviewing,
          quote: withdrawalQuoteFixture,
          accounts: withdrawalBanksFixture,
          selected: withdrawalBanksFixture.first,
        ),
      );
      final first = notifier.createWithdrawal();
      final second = await notifier.createWithdrawal();
      expect(second, isFalse);
      expect(gateway.createCalls, 1);
      gateway.createGate.complete();
      expect(await first, isTrue);
    },
  );

  test('create never marks payout successful without server success', () async {
    final gateway = FakeWithdrawalGateway(
      created: withdrawalDataFixture(status: WithdrawalStatus.pendingReview),
    );
    final notifier = SeededWithdrawalNotifier(
      gateway,
      MemoryWithdrawalRecoveryStore(),
      withdrawalState(
        phase: WithdrawalFlowPhase.reviewing,
        quote: withdrawalQuoteFixture,
        selected: withdrawalBanksFixture.first,
      ),
      backoff: const [Duration(days: 1)],
    );
    expect(await notifier.createWithdrawal(), isTrue);
    expect(notifier.state.phase, WithdrawalFlowPhase.pendingReview);
    expect(notifier.state.phase, isNot(WithdrawalFlowPhase.successful));
  });

  for (final entry in <WithdrawalFlowPhase, String>{
    WithdrawalFlowPhase.pendingReview: 'PENDING REVIEW',
    WithdrawalFlowPhase.processing: 'PAYOUT PROCESSING',
    WithdrawalFlowPhase.successful: 'WITHDRAWAL CONFIRMED',
    WithdrawalFlowPhase.reversed: 'WITHDRAWAL REVERSED',
  }.entries) {
    testWidgets('renders ${entry.key.name} withdrawal state', (tester) async {
      setPhoneViewport(tester);
      final status = switch (entry.key) {
        WithdrawalFlowPhase.pendingReview => WithdrawalStatus.pendingReview,
        WithdrawalFlowPhase.processing => WithdrawalStatus.processing,
        WithdrawalFlowPhase.successful => WithdrawalStatus.successful,
        _ => WithdrawalStatus.reversed,
      };
      final notifier = SeededWithdrawalNotifier(
        FakeWithdrawalGateway(),
        MemoryWithdrawalRecoveryStore(),
        withdrawalState(
          phase: entry.key,
          withdrawal: withdrawalDataFixture(status: status),
        ),
      );
      await tester.pumpWidget(
        withdrawalApp(
          WithdrawalStatusScreen(requestedPhase: entry.key, autoRefresh: false),
          notifier,
        ),
      );
      expect(find.text(entry.value), findsWidgets);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('review displays only server-provided financial values', (
    tester,
  ) async {
    setPhoneViewport(tester);
    final quote = WithdrawalQuote(
      id: 'q1',
      amountMinorUnits: 500000,
      currency: 'NGN',
      eligibility: WithdrawalEligibility.eligible,
      feeMinorUnits: 12345,
      netAmountMinorUnits: 432109,
    );
    final notifier = SeededWithdrawalNotifier(
      FakeWithdrawalGateway(),
      MemoryWithdrawalRecoveryStore(),
      withdrawalState(quote: quote, selected: withdrawalBanksFixture.first),
    );
    await tester.pumpWidget(
      withdrawalApp(const WithdrawalReviewScreen(), notifier),
    );
    expect(find.text('₦123.45'), findsOneWidget);
    expect(find.text('₦4,321.09'), findsOneWidget);
    expect(find.text('₦4,876.55'), findsNothing);
  });

  test('polling is bounded and stops on dispose', () async {
    final gateway = FakeWithdrawalGateway(
      statuses: List<WithdrawalData?>.filled(
        8,
        withdrawalDataFixture(status: WithdrawalStatus.pendingReview),
      ),
    );
    final store = MemoryWithdrawalRecoveryStore()..reference = 'WDR21456789';
    final notifier = SeededWithdrawalNotifier(
      gateway,
      store,
      withdrawalState(withdrawal: withdrawalDataFixture()),
      backoff: const [Duration.zero, Duration.zero],
    );
    await notifier.recover();
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(gateway.statusReads, 3);
    notifier.dispose();
    await Future<void>.delayed(const Duration(milliseconds: 10));
    expect(gateway.statusReads, 3);
  });

  test(
    'reopen recovers reference without creating another withdrawal',
    () async {
      final store = MemoryWithdrawalRecoveryStore()..reference = 'WDR21456789';
      final gateway = FakeWithdrawalGateway(
        statuses: [withdrawalDataFixture()],
      );
      final notifier = WithdrawalNotifier(
        gateway,
        store,
        backoff: const [Duration(days: 1)],
      );
      expect(await notifier.recover(), isTrue);
      expect(gateway.lastStatusReference, 'WDR21456789');
      expect(gateway.createCalls, 0);
    },
  );

  test('offline quote retry never invents financial data', () async {
    final gateway = FakeWithdrawalGateway(quote: withdrawalQuoteFixture)
      ..throwQuote = true;
    final notifier = WithdrawalNotifier(
      gateway,
      MemoryWithdrawalRecoveryStore(),
    );
    expect(
      await notifier.requestQuote(500000),
      WithdrawalFlowPhase.unavailable,
    );
    expect(notifier.state.quote, isNull);
    gateway.throwQuote = false;
    expect(
      await notifier.requestQuote(500000),
      WithdrawalFlowPhase.selectingBank,
    );
    expect(notifier.state.quote?.netAmountMinorUnits, 500000);
  });

  testWidgets('small screen and large text do not overflow', (tester) async {
    const size = Size(320, 568);
    setPhoneViewport(tester, size: size);
    final notifier = SeededWithdrawalNotifier(
      FakeWithdrawalGateway(),
      MemoryWithdrawalRecoveryStore(),
      withdrawalState(
        phase: WithdrawalFlowPhase.pendingReview,
        withdrawal: withdrawalDataFixture(),
      ),
    );
    await tester.pumpWidget(
      withdrawalApp(
        const WithdrawalStatusScreen(
          requestedPhase: WithdrawalFlowPhase.pendingReview,
          autoRefresh: false,
        ),
        notifier,
        size: size,
        textScale: 1.5,
      ),
    );
    await tester.pump();
    expect(tester.takeException(), isNull);
  });

  testWidgets('wallet dashboard navigates into the PR7 withdrawal flow', (
    tester,
  ) async {
    setPhoneViewport(tester);
    final router = GoRouter(
      initialLocation: '/wallet',
      routes: [
        GoRoute(
          path: '/wallet',
          builder: (_, _) => const WalletDashboardScreen(autoLoad: false),
        ),
        GoRoute(
          path: '/wallet/withdraw/withdraw-money',
          builder: (_, _) => const WithdrawMoneyScreen(),
        ),
      ],
    );
    final withdrawalNotifier = WithdrawalNotifier(
      FakeWithdrawalGateway(),
      MemoryWithdrawalRecoveryStore(),
    );
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          walletProvider.overrideWith(
            (ref) => StaticWalletNotifier(
              WalletState(
                projection: WalletProjection(
                  availableMinorUnits: 3245000,
                  lockedMinorUnits: 200000,
                  pendingMinorUnits: 0,
                  verifiedAt: DateTime.utc(2026, 9, 19),
                ),
                transactions: [
                  WalletEntry(
                    id: 'withdrawal-nav-entry',
                    kind: WalletEntryKind.withdrawal,
                    amountMinorUnits: -500000,
                    status: 'PENDING',
                    createdAt: DateTime.utc(2026, 9, 19),
                    reference: 'WDR21456789',
                  ),
                ],
                walletPhase: WalletLoadPhase.ready,
                transactionsPhase: WalletLoadPhase.ready,
              ),
            ),
          ),
          withdrawalProvider.overrideWith((ref) => withdrawalNotifier),
        ],
        child: MaterialApp.router(theme: AppTheme.dark, routerConfig: router),
      ),
    );
    await tester.tap(find.text('Withdraw'));
    await tester.pumpAndSettle();
    expect(find.text('WITHDRAW MONEY'), findsOneWidget);
  });
}
