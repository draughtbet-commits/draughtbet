import 'dart:async';

import 'package:dio/dio.dart';
import 'package:draughts_arena/models/deposit_flow.dart';
import 'package:draughts_arena/models/wallet_read.dart';
import 'package:draughts_arena/providers/deposit_provider.dart';
import 'package:draughts_arena/providers/wallet_provider.dart';
import 'package:draughts_arena/screens/deposit_flow_screens.dart';
import 'package:draughts_arena/screens/checkout_webview_screen.dart';
import 'package:draughts_arena/screens/wallet_read_screens.dart';
import 'package:draughts_arena/services/deposit_gateway.dart';
import 'package:draughts_arena/services/deposit_recovery_store.dart';
import 'package:draughts_arena/services/socket_service.dart';
import 'package:draughts_arena/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'deposit_fixtures.dart';

class FakeDepositGateway extends DepositGateway {
  FakeDepositGateway({
    this.quote,
    this.intent,
    List<DepositIntentData?>? statuses,
  }) : statuses = statuses ?? <DepositIntentData?>[],
       super(Dio());

  DepositQuote? quote;
  DepositIntentData? intent;
  final List<DepositIntentData?> statuses;
  bool throwQuote = false;
  bool blockIntent = false;
  final Completer<void> intentGate = Completer<void>();
  int quoteCalls = 0;
  int intentCalls = 0;
  int statusReads = 0;
  String? lastStatusReference;

  @override
  Future<DepositQuote?> createQuote(int amountMinorUnits) async {
    quoteCalls += 1;
    if (throwQuote) throw DioException(requestOptions: RequestOptions());
    return quote;
  }

  @override
  Future<DepositIntentData?> createIntent({
    required DepositQuote quote,
    required DepositPaymentMethod method,
  }) async {
    intentCalls += 1;
    if (blockIntent) await intentGate.future;
    return intent;
  }

  @override
  Future<DepositIntentData?> fetchStatus(
    String reference, {
    DepositIntentData? previous,
  }) async {
    statusReads += 1;
    lastStatusReference = reference;
    if (statuses.isEmpty) return previous;
    return statuses.removeAt(0);
  }
}

class MemoryRecoveryStore implements DepositRecoveryStore {
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

class SeededDepositNotifier extends DepositNotifier {
  // Positional private fields in DepositNotifier cannot be forwarded as
  // public super-parameters from this test library.
  // ignore: use_super_parameters
  SeededDepositNotifier(
    DepositGateway gateway,
    DepositRecoveryStore store,
    DepositFlowState initial, {
    List<Duration>? backoff,
  }) : super(gateway, store, backoff: backoff) {
    state = initial;
  }
}

final walletProjectionFixture = WalletProjection(
  availableMinorUnits: 3245000,
  currency: 'NGN',
  lockedMinorUnits: 200000,
  pendingMinorUnits: 0,
  verifiedAt: DateTime.utc(2026, 9, 17, 9, 41),
);

final walletEntriesFixture = [
  WalletEntry(
    id: 'tx-1',
    kind: WalletEntryKind.deposit,
    amountMinorUnits: 200000,
    status: 'SUCCESS',
    createdAt: DateTime.utc(2026, 9, 17, 9, 41),
    reference: 'DBT78456213',
    feeMinorUnits: 0,
    balanceImpactMinorUnits: 200000,
  ),
];

class StaticWalletNotifier extends WalletNotifier {
  StaticWalletNotifier(WalletState initial) : super(SocketService(), Dio()) {
    state = initial;
  }

  @override
  Future<void> fetchBalance({bool silent = false}) async {}

  @override
  Future<void> fetchTransactions({
    int page = 1,
    int limit = 20,
    bool silent = false,
  }) async {}
}

DepositFlowState depositState({
  DepositFlowPhase phase = DepositFlowPhase.selectingMethod,
  DepositQuote? quote,
  DepositPaymentMethod? selectedMethod,
  DepositIntentData? intent,
  String? error,
}) => DepositFlowState(
  phase: phase,
  quote: quote,
  selectedMethod: selectedMethod,
  intent: intent,
  error: error,
);

Widget depositApp(
  Widget child,
  DepositNotifier notifier, {
  Size size = const Size(412, 915),
  double textScale = 1,
}) => ProviderScope(
  overrides: [depositProvider.overrideWith((ref) => notifier)],
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
  test('active backend gaps do not call nonexistent deposit reads', () async {
    final gateway = DepositGateway(Dio());

    expect(await gateway.createQuote(200000), isNull);
    expect(await gateway.fetchStatus('deposit-reference'), isNull);
  });

  test(
    'quote parser preserves server totals and never calculates a payout',
    () {
      final quote = DepositQuote.tryFromServer({
        'id': 'q1',
        'amountMinorUnits': 200000,
        'feeMinorUnits': 12345,
        'totalMinorUnits': 277777,
        'currency': 'NGN',
        'paymentMethods': <Object>[],
      });
      expect(quote?.feeMinorUnits, 12345);
      expect(quote?.totalMinorUnits, 277777);
    },
  );

  test('missing or invalid server deposit data is rejected', () {
    expect(DepositQuote.tryFromServer({'id': 'q1'}), isNull);
    expect(
      DepositIntentData.tryFromServer({
        'reference': 'r1',
        'amountMinorUnits': 100,
        'currency': 'NGN',
        'status': 'mystery',
      }),
      isNull,
    );
  });

  test('sensitive references and instruments are masked', () {
    final intent = DepositIntentData.tryFromServer({
      'reference': 'PRIVATE-12345678',
      'amountMinorUnits': 10000,
      'currency': 'NGN',
      'status': 'pending',
      'maskedInstrument': '5399838312344242',
    });
    expect(intent?.maskedReference, '••••5678');
    expect(intent?.maskedInstrument, '•••• 4242');
    expect(intent?.maskedInstrument, isNot(contains('539983831234')));
  });

  testWidgets('Add Money validates amount before requesting a quote', (
    tester,
  ) async {
    setPhoneViewport(tester);
    final gateway = FakeDepositGateway(quote: depositQuoteFixture);
    final notifier = DepositNotifier(gateway, MemoryRecoveryStore());
    await tester.pumpWidget(depositApp(const AddMoneyScreen(), notifier));
    await tester.tap(find.text('Continue'));
    await tester.pump();
    expect(
      find.text('Enter a valid amount greater than zero.'),
      findsOneWidget,
    );
    expect(gateway.quoteCalls, 0);
  });

  testWidgets('payment methods render only server-provided values', (
    tester,
  ) async {
    setPhoneViewport(tester);
    final gateway = FakeDepositGateway();
    final notifier = SeededDepositNotifier(
      gateway,
      MemoryRecoveryStore(),
      depositState(quote: depositQuoteFixture),
    );
    await tester.pumpWidget(depositApp(const PaymentMethodScreen(), notifier));
    expect(find.text('Card'), findsOneWidget);
    expect(find.text('Bank Transfer'), findsOneWidget);
    expect(find.text('USSD'), findsNothing);
    expect(find.text('Mobile Money'), findsNothing);
  });

  testWidgets('empty payment methods show an approved unavailable state', (
    tester,
  ) async {
    setPhoneViewport(tester);
    final emptyQuote = DepositQuote(
      id: 'empty',
      amountMinorUnits: 200000,
      currency: 'NGN',
      paymentMethods: const [],
    );
    final notifier = SeededDepositNotifier(
      FakeDepositGateway(),
      MemoryRecoveryStore(),
      depositState(quote: emptyQuote),
    );
    await tester.pumpWidget(depositApp(const PaymentMethodScreen(), notifier));
    expect(find.text('No payment methods available'), findsOneWidget);
    expect(
      tester
          .widget<FilledButton>(
            find.descendant(
              of: find.byKey(const ValueKey('create-deposit-button')),
              matching: find.byType(FilledButton),
            ),
          )
          .onPressed,
      isNull,
    );
  });

  test(
    'duplicate intent submissions are ignored while one is in flight',
    () async {
      final gateway = FakeDepositGateway(intent: depositIntentFixture())
        ..blockIntent = true;
      final notifier = SeededDepositNotifier(
        gateway,
        MemoryRecoveryStore(),
        depositState(
          quote: depositQuoteFixture,
          selectedMethod: depositMethodsFixture.first,
        ),
      );
      final first = notifier.createIntent();
      final second = await notifier.createIntent();
      expect(second, isFalse);
      expect(gateway.intentCalls, 1);
      gateway.intentGate.complete();
      expect(await first, isTrue);
    },
  );

  testWidgets(
    'hosted checkout return always enters authoritative status read',
    (tester) async {
      setPhoneViewport(tester);
      final gateway = FakeDepositGateway(
        statuses: [depositIntentFixture(status: DepositStatus.pending)],
      );
      final notifier = SeededDepositNotifier(
        gateway,
        MemoryRecoveryStore(),
        depositState(
          phase: DepositFlowPhase.checkoutReady,
          quote: depositQuoteFixture,
          intent: depositIntentFixture(),
        ),
        backoff: const [Duration(days: 1)],
      );
      final router = GoRouter(
        initialLocation: '/checkout',
        routes: [
          GoRoute(
            path: '/checkout',
            builder: (_, _) => HostedCheckoutScreen(
              checkoutLauncher: (_, _) async => CheckoutExit.returned,
            ),
          ),
          GoRoute(
            path: '/wallet/deposit-processing',
            builder: (_, _) => const DepositStatusScreen(
              requestedPhase: DepositFlowPhase.processing,
              autoRefresh: false,
            ),
          ),
        ],
      );
      await tester.pumpWidget(
        ProviderScope(
          overrides: [depositProvider.overrideWith((ref) => notifier)],
          child: MaterialApp.router(theme: AppTheme.dark, routerConfig: router),
        ),
      );
      await tester.tap(find.text('Pay now'));
      await tester.pumpAndSettle();
      expect(gateway.statusReads, 1);
      expect(find.text('AWAITING CONFIRMATION'), findsOneWidget);
      expect(find.text('DEPOSIT SUCCESSFUL'), findsNothing);
    },
  );

  test('success is shown only after authoritative confirmation', () async {
    final gateway = FakeDepositGateway(
      statuses: [depositIntentFixture(status: DepositStatus.successful)],
    );
    final store = MemoryRecoveryStore()
      ..reference = depositIntentFixture().reference;
    final notifier = SeededDepositNotifier(
      gateway,
      store,
      depositState(intent: depositIntentFixture()),
    );
    await notifier.refreshStatus();
    expect(notifier.state.phase, DepositFlowPhase.successful);
    expect(store.clears, 1);
  });

  for (final entry in <DepositFlowPhase, String>{
    DepositFlowPhase.processing: 'DEPOSIT PROCESSING',
    DepositFlowPhase.pending: 'AWAITING CONFIRMATION',
    DepositFlowPhase.successful: 'DEPOSIT SUCCESSFUL',
    DepositFlowPhase.failed: 'DEPOSIT FAILED',
  }.entries) {
    testWidgets('renders ${entry.key.name} deposit state', (tester) async {
      setPhoneViewport(tester);
      final status = switch (entry.key) {
        DepositFlowPhase.processing => DepositStatus.processing,
        DepositFlowPhase.pending => DepositStatus.pending,
        DepositFlowPhase.successful => DepositStatus.successful,
        _ => DepositStatus.failed,
      };
      final notifier = SeededDepositNotifier(
        FakeDepositGateway(),
        MemoryRecoveryStore(),
        depositState(
          phase: entry.key,
          intent: depositIntentFixture(status: status),
        ),
      );
      await tester.pumpWidget(
        depositApp(
          DepositStatusScreen(requestedPhase: entry.key, autoRefresh: false),
          notifier,
        ),
      );
      expect(find.text(entry.value), findsWidgets);
      expect(tester.takeException(), isNull);
    });
  }

  test('polling uses bounded reads and stops after disposal', () async {
    final gateway = FakeDepositGateway(
      statuses: List<DepositIntentData?>.filled(
        8,
        depositIntentFixture(status: DepositStatus.pending),
      ),
    );
    final notifier = SeededDepositNotifier(
      gateway,
      MemoryRecoveryStore(),
      depositState(intent: depositIntentFixture()),
      backoff: const [Duration.zero, Duration.zero],
    );
    await notifier.handleProviderReturn();
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(gateway.statusReads, 3);
    notifier.dispose();
    await Future<void>.delayed(const Duration(milliseconds: 10));
    expect(gateway.statusReads, 3);
  });

  test(
    'app reopen recovers existing reference without creating a new intent',
    () async {
      final store = MemoryRecoveryStore()..reference = 'DBT78456213';
      final gateway = FakeDepositGateway(
        statuses: [depositIntentFixture(status: DepositStatus.pending)],
      );
      final notifier = DepositNotifier(
        gateway,
        store,
        backoff: const [Duration(days: 1)],
      );
      expect(await notifier.recover(), isTrue);
      expect(gateway.lastStatusReference, 'DBT78456213');
      expect(gateway.intentCalls, 0);
    },
  );

  test('offline quote can be retried without inventing values', () async {
    final gateway = FakeDepositGateway(quote: depositQuoteFixture)
      ..throwQuote = true;
    final notifier = DepositNotifier(gateway, MemoryRecoveryStore());
    expect(await notifier.requestQuote(200000), isFalse);
    expect(notifier.state.phase, DepositFlowPhase.unavailable);
    expect(notifier.state.quote, isNull);
    gateway.throwQuote = false;
    expect(await notifier.requestQuote(200000), isTrue);
    expect(notifier.state.quote?.amountMinorUnits, 200000);
  });

  testWidgets('small screen and large text do not overflow', (tester) async {
    setPhoneViewport(tester, size: const Size(320, 568));
    final notifier = SeededDepositNotifier(
      FakeDepositGateway(),
      MemoryRecoveryStore(),
      depositState(
        phase: DepositFlowPhase.pending,
        intent: depositIntentFixture(),
      ),
    );
    await tester.pumpWidget(
      depositApp(
        const DepositStatusScreen(
          requestedPhase: DepositFlowPhase.pending,
          autoRefresh: false,
        ),
        notifier,
        size: const Size(320, 568),
        textScale: 1.5,
      ),
    );
    await tester.pump();
    expect(tester.takeException(), isNull);
  });

  testWidgets('wallet dashboard Add money navigates into PR6 flow', (
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
          path: '/wallet/add-money',
          builder: (_, _) => const AddMoneyScreen(),
        ),
      ],
    );
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          walletProvider.overrideWith(
            (ref) => StaticWalletNotifier(
              WalletState(
                projection: walletProjectionFixture,
                transactions: walletEntriesFixture,
                walletPhase: WalletLoadPhase.ready,
                transactionsPhase: WalletLoadPhase.ready,
              ),
            ),
          ),
          depositProvider.overrideWith(
            (ref) =>
                DepositNotifier(FakeDepositGateway(), MemoryRecoveryStore()),
          ),
        ],
        child: MaterialApp.router(theme: AppTheme.dark, routerConfig: router),
      ),
    );
    await tester.tap(find.text('Add money'));
    await tester.pumpAndSettle();
    expect(find.text('ADD MONEY'), findsOneWidget);
  });

  testWidgets('deposit transaction details remain available', (tester) async {
    setPhoneViewport(tester);
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: WalletTransactionDetailScreen(entry: walletEntriesFixture.first),
      ),
    );
    expect(find.text('TRANSACTION DETAILS'), findsOneWidget);
    expect(find.text('DBT78456213'), findsOneWidget);
    expect(find.text('₦2,000.00'), findsOneWidget);
  });
}
