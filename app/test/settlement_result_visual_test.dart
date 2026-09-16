import 'package:draughts_arena/models/match_flow.dart';
import 'package:draughts_arena/screens/match_result_screen.dart';
import 'package:draughts_arena/screens/settlement_result_screens.dart';
import 'package:draughts_arena/theme/app_theme.dart';
import 'package:draughts_arena/theme/colors.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'settlement_fixtures.dart';

const _captureKey = ValueKey('settlement-result-capture');

void _setViewport(WidgetTester tester) {
  tester.view.physicalSize = const Size(412, 915);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

Widget _capture(Widget child) => ProviderScope(
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
    matchesGoldenFile('goldens/settlement_result/$name.png'),
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

  final screens = <String, Widget>{
    '67_victory': MatchResultScreen(
      result: settlementResult(ResultKind.victory),
      autoRefresh: false,
    ),
    '68_defeat': MatchResultScreen(
      result: settlementResult(ResultKind.defeat),
      autoRefresh: false,
    ),
    '69_draw': MatchResultScreen(
      result: settlementResult(ResultKind.draw),
      autoRefresh: false,
    ),
    '70_timeout': MatchResultScreen(
      result: settlementResult(ResultKind.timeout),
      autoRefresh: false,
    ),
    '71_resignation': MatchResultScreen(
      result: settlementResult(ResultKind.resignation),
      autoRefresh: false,
    ),
    '72_disconnect_forfeit': MatchResultScreen(
      result: settlementResult(ResultKind.disconnectForfeit),
      autoRefresh: false,
    ),
    '73_cancelled': MatchResultScreen(
      result: settlementResult(ResultKind.cancelled),
      autoRefresh: false,
    ),
    '74_settlement_processing': SettlementStatusScreen(
      result: settlementResult(
        ResultKind.victory,
        phase: SettlementPhase.pending,
      ),
      phase: SettlementPhase.pending,
      autoRefresh: false,
    ),
    '75_settlement_complete': SettlementStatusScreen(
      result: settlementResult(ResultKind.victory),
      phase: SettlementPhase.confirmed,
      autoRefresh: false,
    ),
    '76_settlement_delayed': SettlementStatusScreen(
      result: settlementResult(
        ResultKind.victory,
        phase: SettlementPhase.delayed,
      ),
      phase: SettlementPhase.delayed,
      autoRefresh: false,
    ),
    '77_match_receipt': MatchReceiptScreen(
      matchId: settlementReceipt.matchId,
      initialReceipt: settlementReceipt,
      autoLoad: false,
    ),
    '78_share_result': Scaffold(
      backgroundColor: AppColors.background,
      body: Align(
        alignment: Alignment.bottomCenter,
        child: Material(
          color: AppColors.surface,
          borderRadius: const BorderRadius.vertical(top: Radius.circular(22)),
          child: ShareResultSheet(
            shareText: settlementResult(
              ResultKind.victory,
            ).privacySafeShareText(),
          ),
        ),
      ),
    ),
  };

  for (final entry in screens.entries) {
    testWidgets('capture ${entry.key}', (tester) async {
      _setViewport(tester);
      await tester.pumpWidget(_capture(entry.value));
      await _verify(tester, entry.key);
    });
  }
}
