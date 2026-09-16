import 'package:dio/dio.dart';
import 'package:draughts_arena/models/wallet_read.dart';
import 'package:draughts_arena/providers/wallet_provider.dart';
import 'package:draughts_arena/screens/wallet_read_screens.dart';
import 'package:draughts_arena/services/socket_service.dart';
import 'package:draughts_arena/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

final walletProjectionFixture = WalletProjection(
  availableMinorUnits: 3245000,
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
  Future<void> fetchBalance() async {}

  @override
  Future<void> fetchTransactions({int page = 1, int limit = 20}) async {}

  @override
  Future<void> loadMoreTransactions({int limit = 20}) async {}
}

Widget walletTestApp(Widget child, WalletState state) => ProviderScope(
  overrides: [
    walletProvider.overrideWith((ref) => StaticWalletNotifier(state)),
  ],
  child: MaterialApp(theme: AppTheme.dark, home: child),
);

void main() {
  test('wallet projection safely accepts missing optional V2 fields', () {
    final projection = WalletProjection.fromJson({'balance': '3245000'});
    expect(projection.availableMinorUnits, 3245000);
    expect(projection.lockedMinorUnits, isNull);
    expect(projection.pendingMinorUnits, isNull);
    expect(projection.lockedFunds, isEmpty);
  });

  test('wallet projection refuses to invent an available balance', () {
    expect(
      () => WalletProjection.fromJson({'lockedBalanceMinorUnits': '500'}),
      throwsFormatException,
    );
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
}
