import 'package:draughts_arena/models/wallet_read.dart';
import 'package:draughts_arena/providers/wallet_provider.dart';
import 'package:draughts_arena/screens/wallet_read_screens.dart';
import 'package:draughts_arena/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'wallet_read_test.dart';

const _captureKey = ValueKey('wallet-capture');

void _setViewport(WidgetTester tester) {
  tester.view.physicalSize = const Size(412, 915);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

Widget _capture(Widget child, WalletState state) => ProviderScope(
  overrides: [
    walletProvider.overrideWith((ref) => StaticWalletNotifier(state)),
  ],
  child: MaterialApp(
    theme: AppTheme.dark,
    home: child,
    builder: (context, child) => RepaintBoundary(
      key: _captureKey,
      child: child ?? const SizedBox.shrink(),
    ),
  ),
);

Future<void> _verify(WidgetTester tester, String name) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 180));
  expect(tester.takeException(), isNull);
  await expectLater(
    find.byKey(_captureKey),
    matchesGoldenFile('goldens/wallet_read/$name.png'),
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

  testWidgets('capture wallet dashboard', (tester) async {
    _setViewport(tester);
    await tester.pumpWidget(
      _capture(
        const WalletDashboardScreen(autoLoad: false),
        WalletState(
          projection: walletProjectionFixture,
          walletPhase: WalletLoadPhase.ready,
          transactions: walletEntriesFixture,
          transactionsPhase: WalletLoadPhase.ready,
        ),
      ),
    );
    await _verify(tester, '44_wallet_dashboard');
  });

  testWidgets('capture transaction history', (tester) async {
    _setViewport(tester);
    await tester.pumpWidget(
      _capture(
        const TransactionHistoryScreen(autoLoad: false),
        WalletState(
          transactions: walletEntriesFixture,
          transactionsPhase: WalletLoadPhase.ready,
        ),
      ),
    );
    await _verify(tester, '50_transaction_history');
  });

  testWidgets('capture transaction filters', (tester) async {
    _setViewport(tester);
    await tester.pumpWidget(
      _capture(
        const TransactionHistoryScreen(autoLoad: false),
        WalletState(
          transactions: walletEntriesFixture,
          transactionsPhase: WalletLoadPhase.ready,
        ),
      ),
    );
    await tester.tap(find.byTooltip('Filter transactions'));
    await tester.pumpAndSettle();
    await _verify(tester, 'transaction_filters');
  });

  testWidgets('capture transaction details', (tester) async {
    _setViewport(tester);
    await tester.pumpWidget(
      _capture(
        WalletTransactionDetailScreen(entry: walletEntriesFixture.first),
        const WalletState(),
      ),
    );
    await _verify(tester, '51_transaction_details');
  });

  testWidgets('capture locked funds', (tester) async {
    _setViewport(tester);
    await tester.pumpWidget(
      _capture(
        const LockedFundsScreen(),
        WalletState(
          projection: walletProjectionFixture,
          walletPhase: WalletLoadPhase.ready,
        ),
      ),
    );
    await _verify(tester, '52_locked_funds');
  });

  testWidgets('capture empty transaction history', (tester) async {
    _setViewport(tester);
    await tester.pumpWidget(
      _capture(
        const TransactionHistoryScreen(autoLoad: false),
        const WalletState(transactionsPhase: WalletLoadPhase.empty),
      ),
    );
    await _verify(tester, '110_empty_transaction_history');
  });

  testWidgets('capture wallet loading', (tester) async {
    _setViewport(tester);
    await tester.pumpWidget(
      _capture(
        const WalletDashboardScreen(autoLoad: false),
        const WalletState(walletPhase: WalletLoadPhase.loading),
      ),
    );
    await _verify(tester, 'wallet_loading');
  });

  testWidgets('capture transaction failure', (tester) async {
    _setViewport(tester);
    await tester.pumpWidget(
      _capture(
        const TransactionHistoryScreen(autoLoad: false),
        const WalletState(
          transactionsPhase: WalletLoadPhase.failure,
          error: 'Transactions could not be loaded.',
        ),
      ),
    );
    await _verify(tester, 'transaction_failure');
  });

  testWidgets('capture wallet unavailable', (tester) async {
    _setViewport(tester);
    await tester.pumpWidget(
      _capture(
        const WalletDashboardScreen(autoLoad: false),
        const WalletState(walletPhase: WalletLoadPhase.unavailable),
      ),
    );
    await _verify(tester, 'wallet_unavailable');
  });
}
