import 'dart:async';

import 'package:dio/dio.dart';
import 'package:draughts_arena/models/wallet_read.dart';
import 'package:draughts_arena/providers/wallet_provider.dart';
import 'package:draughts_arena/screens/wallet_read_screens.dart';
import 'package:draughts_arena/services/socket_service.dart';
import 'package:draughts_arena/theme/app_theme.dart';
import 'package:draughts_arena/widgets/balance_card.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

final walletProjectionFixture = WalletProjection(
  availableMinorUnits: 3245000,
  currency: 'NGN',
  lockedMinorUnits: 200000,
  pendingMinorUnits: 0,
  verifiedAt: DateTime.utc(2026, 9, 16, 9, 41),
  lockedFunds: const [
    LockedFundItem(
      matchId: 'DB7E4582',
      amountMinorUnits: 120000,
      status: 'IN_PROGRESS',
      opponentName: 'KingMoves',
    ),
    LockedFundItem(
      matchId: 'DB6T4319',
      amountMinorUnits: 80000,
      status: 'WAITING_FOR_OPPONENT',
      opponentName: 'QueenBee',
    ),
  ],
);

final walletEntriesFixture = [
  WalletEntry(
    id: 'tx-1',
    kind: WalletEntryKind.deposit,
    amountMinorUnits: 200000,
    status: 'SUCCESS',
    createdAt: DateTime.utc(2026, 1, 14, 9, 41),
    reference: 'DBT78456213',
    feeMinorUnits: 0,
    balanceImpactMinorUnits: 200000,
  ),
  WalletEntry(
    id: 'tx-2',
    kind: WalletEntryKind.stake,
    amountMinorUnits: 200000,
    status: 'COMPLETED',
    createdAt: DateTime.utc(2026, 1, 13, 18, 20),
    reference: 'DBT2415678',
    relatedMatchId: 'match-2415678',
  ),
  WalletEntry(
    id: 'tx-3',
    kind: WalletEntryKind.payout,
    amountMinorUnits: 390000,
    status: 'SUCCESS',
    createdAt: DateTime.utc(2026, 1, 12, 11, 5),
    reference: 'DBT78459991',
    relatedMatchId: 'match-2415000',
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

  @override
  Future<void> loadMoreTransactions({int limit = 20}) async {}
}

class MockDio extends Mock implements Dio {}

class WalletEventSocket extends SocketService {
  final updates = StreamController<Map<String, dynamic>>.broadcast();

  @override
  Stream<Map<String, dynamic>> get onWalletUpdated => updates.stream;

  Future<void> closeUpdates() => updates.close();
}

Response<dynamic> response(String path, Map<String, dynamic> data) => Response(
  requestOptions: RequestOptions(path: path),
  statusCode: 200,
  data: data,
);

Map<String, dynamic> transactionJson({
  required String id,
  String type = 'DEPOSIT',
  int amountMinorUnits = 200000,
  String status = 'COMPLETED',
  String? relatedMatchId,
}) {
  final json = <String, dynamic>{
    'id': id,
    'type': type,
    'amountMinorUnits': amountMinorUnits,
    'status': status,
    'createdAt': '2026-09-20T10:00:00.000Z',
  };
  if (relatedMatchId != null) json['relatedMatchId'] = relatedMatchId;
  return json;
}

Widget walletTestApp(Widget child, WalletState state) => ProviderScope(
  overrides: [
    walletProvider.overrideWith((ref) => StaticWalletNotifier(state)),
  ],
  child: MaterialApp(theme: AppTheme.dark, home: child),
);

void main() {
  test('wallet projection parses the authoritative nested balance', () {
    final projection = WalletProjection.fromJson({
      'balance': {'currency': 'NGN', 'balanceMinorUnits': 12345},
    });
    expect(projection.availableMinorUnits, 12345);
    expect(projection.currency, 'NGN');
    expect(projection.lockedMinorUnits, isNull);
    expect(projection.pendingMinorUnits, isNull);
    expect(projection.lockedFunds, isEmpty);
  });

  test('wallet projection parses nested locked and pending balances', () {
    final projection = WalletProjection.fromJson(const {
      'balance': {
        'currency': 'NGN',
        'balanceMinorUnits': 12345,
        'lockedMinorUnits': 4000,
        'pendingMinorUnits': 2500,
      },
    });
    expect(projection.availableMinorUnits, 12345);
    expect(projection.lockedMinorUnits, 4000);
    expect(projection.pendingMinorUnits, 2500);
  });

  test('wallet projection rejects every invalid authoritative shape', () {
    final invalid = <Map<String, dynamic>>[
      const {},
      {'balance': '12345'},
      {
        'balance': {'currency': 'NGN'},
      },
      {
        'balance': {'currency': 'NGN', 'balanceMinorUnits': '12.34'},
      },
      {
        'balance': {'balanceMinorUnits': 12345},
      },
    ];
    for (final payload in invalid) {
      expect(
        () => WalletProjection.fromJson(payload),
        throwsFormatException,
        reason: '$payload must not become a fake balance',
      );
    }
  });

  test('invalid balance response enters the safe unavailable state', () async {
    final socket = WalletEventSocket();
    addTearDown(socket.closeUpdates);
    final dio = MockDio();
    when(
      () => dio.get('/wallet/balance'),
    ).thenAnswer((_) async => response('/wallet/balance', const {}));
    final notifier = WalletNotifier(socket, dio);
    addTearDown(notifier.dispose);

    await notifier.fetchBalance();

    expect(notifier.state.projection, isNull);
    expect(notifier.state.walletPhase, WalletLoadPhase.unavailable);
    expect(notifier.state.error, 'Balances could not be verified.');
  });

  test('transaction parser uses only authoritative ledger fields', () {
    final entry = WalletEntry.fromJson(
      transactionJson(
        id: 'ledger-entry-id',
        type: 'REFUND',
        amountMinorUnits: 5100,
        status: 'COMPLETED',
        relatedMatchId: 'match-7',
      ),
    );

    expect(entry.id, 'ledger-entry-id');
    expect(entry.kind, WalletEntryKind.refund);
    expect(entry.amountMinorUnits, 5100);
    expect(entry.status, 'COMPLETED');
    expect(entry.createdAt, DateTime.parse('2026-09-20T10:00:00.000Z'));
    expect(entry.relatedMatchId, 'match-7');
    expect(entry.authoritativeReference, 'ledger-entry-id');
    expect(entry.feeMinorUnits, isNull);
    expect(entry.balanceImpactMinorUnits, isNull);
  });

  test(
    'wallet.updated refetches truth and preserves the verified balance',
    () async {
      final socket = WalletEventSocket();
      addTearDown(socket.closeUpdates);
      final dio = MockDio();
      final balanceCompleter = Completer<Response<dynamic>>();
      final transactionsCompleter = Completer<Response<dynamic>>();
      when(
        () => dio.get('/wallet/balance'),
      ).thenAnswer((_) => balanceCompleter.future);
      when(
        () => dio.get('/wallet/transactions?page=1&limit=20'),
      ).thenAnswer((_) => transactionsCompleter.future);
      final notifier = WalletNotifier(socket, dio);
      addTearDown(notifier.dispose);
      notifier.state = notifier.state.copyWith(
        projection: const WalletProjection(
          availableMinorUnits: 5000,
          currency: 'NGN',
        ),
        walletPhase: WalletLoadPhase.ready,
      );

      socket.updates.add({'balanceChange': '-2000'});
      socket.updates.add({'balanceChange': '-2000'});
      await Future<void>.delayed(Duration.zero);

      expect(notifier.state.projection?.availableMinorUnits, 5000);
      expect(notifier.state.walletPhase, WalletLoadPhase.ready);
      expect(notifier.state.isLoading, isFalse);
      verify(() => dio.get('/wallet/balance')).called(1);
      verify(() => dio.get('/wallet/transactions?page=1&limit=20')).called(1);

      balanceCompleter.complete(
        response('/wallet/balance', {
          'balance': {'currency': 'NGN', 'balanceMinorUnits': 12345},
        }),
      );
      transactionsCompleter.complete(
        response('/wallet/transactions', {
          'transactions': [transactionJson(id: 'entry-1')],
          'total': 1,
          'page': 1,
          'totalPages': 1,
        }),
      );
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      expect(notifier.state.projection?.availableMinorUnits, 12345);
      expect(notifier.state.transactions.single.id, 'entry-1');
      verifyNever(() => dio.get('/wallet'));
    },
  );

  test(
    'pagination respects totalPages, de-duplicates, and refreshes',
    () async {
      final socket = WalletEventSocket();
      addTearDown(socket.closeUpdates);
      final dio = MockDio();
      var firstPageCalls = 0;
      when(() => dio.get('/wallet/transactions?page=1&limit=2')).thenAnswer((
        _,
      ) async {
        firstPageCalls += 1;
        return response('/wallet/transactions', {
          'transactions': firstPageCalls == 1
              ? [transactionJson(id: 'entry-1'), transactionJson(id: 'entry-2')]
              : [transactionJson(id: 'entry-4')],
          'total': firstPageCalls == 1 ? 3 : 1,
          'page': 1,
          'totalPages': firstPageCalls == 1 ? 2 : 1,
        });
      });
      when(() => dio.get('/wallet/transactions?page=2&limit=2')).thenAnswer(
        (_) async => response('/wallet/transactions', {
          'transactions': [
            transactionJson(id: 'entry-2'),
            transactionJson(id: 'entry-3'),
          ],
          'total': 3,
          'page': 2,
          'totalPages': 2,
        }),
      );
      final notifier = WalletNotifier(socket, dio);
      addTearDown(notifier.dispose);

      await notifier.fetchTransactions(limit: 2);
      expect(notifier.state.hasMore, isTrue);
      expect(notifier.state.totalTransactions, 3);
      expect(notifier.state.totalPages, 2);

      await notifier.loadMoreTransactions(limit: 2);
      expect(notifier.state.transactions.map((entry) => entry.id), [
        'entry-1',
        'entry-2',
        'entry-3',
      ]);
      expect(notifier.state.hasMore, isFalse);
      expect(notifier.state.transactionPage, 2);

      await notifier.fetchTransactions(page: 2, limit: 2);
      verify(() => dio.get('/wallet/transactions?page=2&limit=2')).called(1);

      await notifier.fetchTransactions(limit: 2);
      expect(notifier.state.transactions.single.id, 'entry-4');
      expect(notifier.state.transactionPage, 1);
      expect(notifier.state.hasMore, isFalse);
    },
  );

  test('failed pagination preserves verified transactions', () async {
    final socket = WalletEventSocket();
    addTearDown(socket.closeUpdates);
    final dio = MockDio();
    when(() => dio.get('/wallet/transactions?page=2&limit=20')).thenThrow(
      DioException(
        requestOptions: RequestOptions(path: '/wallet/transactions'),
      ),
    );
    final notifier = WalletNotifier(socket, dio);
    addTearDown(notifier.dispose);
    notifier.state = notifier.state.copyWith(
      transactions: [walletEntriesFixture.first],
      transactionsPhase: WalletLoadPhase.ready,
      transactionPage: 1,
      hasMore: true,
    );

    await notifier.loadMoreTransactions();

    expect(notifier.state.transactions, [walletEntriesFixture.first]);
    expect(notifier.state.transactionsPhase, WalletLoadPhase.ready);
    expect(notifier.state.isLoadingMore, isFalse);
  });

  testWidgets('wallet unavailable disables financial actions', (tester) async {
    await tester.pumpWidget(
      walletTestApp(
        const WalletDashboardScreen(autoLoad: false),
        const WalletState(walletPhase: WalletLoadPhase.unavailable),
      ),
    );
    expect(find.text('Wallet unavailable'), findsOneWidget);
    expect(find.textContaining('Money actions are disabled'), findsOneWidget);
    expect(find.text('Add money'), findsNothing);
  });

  testWidgets('transaction filters expose approved type and status controls', (
    tester,
  ) async {
    await tester.pumpWidget(
      walletTestApp(
        const TransactionHistoryScreen(autoLoad: false),
        WalletState(
          transactions: walletEntriesFixture,
          transactionsPhase: WalletLoadPhase.ready,
        ),
      ),
    );
    await tester.tap(find.byTooltip('Filter transactions'));
    await tester.pumpAndSettle();
    expect(find.text('Filter transactions'), findsOneWidget);
    expect(find.text('deposit'), findsOneWidget);
    expect(find.text('PENDING'), findsOneWidget);
    expect(find.text('Apply filters'), findsOneWidget);
  });

  testWidgets('transaction details fall back to the ledger entry id', (
    tester,
  ) async {
    final entry = WalletEntry.fromJson(transactionJson(id: 'ledger-entry-id'));
    await tester.pumpWidget(
      walletTestApp(
        WalletTransactionDetailScreen(entry: entry),
        const WalletState(),
      ),
    );

    expect(find.text('ledger-entry-id'), findsOneWidget);
    expect(find.text('Unavailable'), findsNothing);
  });

  testWidgets('locked and pending balances remain visibly deferred', (
    tester,
  ) async {
    await tester.pumpWidget(
      walletTestApp(
        const LockedFundsScreen(),
        const WalletState(
          projection: WalletProjection(
            availableMinorUnits: 12345,
            currency: 'NGN',
          ),
          walletPhase: WalletLoadPhase.ready,
        ),
      ),
    );

    expect(find.text('Locked funds unavailable'), findsOneWidget);
    expect(find.textContaining('No amount has been estimated'), findsOneWidget);
    expect(find.text('₦0'), findsNothing);
  });

  testWidgets('locked funds screen shows server-provided locked and pending values', (
    tester,
  ) async {
    await tester.pumpWidget(
      walletTestApp(
        const LockedFundsScreen(),
        const WalletState(
          projection: WalletProjection(
            availableMinorUnits: 12345,
            lockedMinorUnits: 4000,
            pendingMinorUnits: 2500,
            currency: 'NGN',
          ),
          walletPhase: WalletLoadPhase.ready,
        ),
      ),
    );

    expect(find.text('Currently locked in matches'), findsOneWidget);
    expect(find.text('₦40.00'), findsOneWidget);
    expect(find.text('Pending withdrawal: ₦25'), findsOneWidget);
    expect(find.text('Locked funds unavailable'), findsNothing);
  });

  testWidgets('home balance card shows the real locked amount', (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          walletProvider.overrideWith(
            (ref) => StaticWalletNotifier(
              const WalletState(
                projection: WalletProjection(
                  availableMinorUnits: 3245000,
                  lockedMinorUnits: 200000,
                  currency: 'NGN',
                ),
                walletPhase: WalletLoadPhase.ready,
              ),
            ),
          ),
        ],
        child: MaterialApp(
          theme: AppTheme.dark,
          home: Scaffold(body: BalanceCard()),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('₦2,000.00'), findsOneWidget);
    expect(find.text('—'), findsNothing);
  });
}
