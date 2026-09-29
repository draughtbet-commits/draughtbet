import 'package:draughts_arena/models/dispute.dart';
import 'package:draughts_arena/providers/dispute_provider.dart';
import 'package:draughts_arena/screens/dispute_screens.dart';
import 'package:draughts_arena/services/dispute_gateway.dart';
import 'package:draughts_arena/theme/app_theme.dart';
import 'package:draughts_arena/widgets/main_layout.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

const _captureKey = ValueKey('pr11-capture');
const _match = DisputeMatchSummary(
  matchId: 'DB241567',
  opponentName: 'KingMoves',
  opponentAvatarId: 'avatar_02',
);
final _case = DisputeCaseData(
  id: 'DRP89231',
  matchId: _match.matchId,
  status: DisputeStatus.underReview,
  reason: 'Suspected cheating',
  createdAt: DateTime.utc(2026, 9, 28, 20, 3),
  updatedAt: DateTime.utc(2026, 9, 28, 22, 17),
);

class _VisualGateway implements DisputeGateway {
  const _VisualGateway(this.result);

  final DisputeCaseData? result;

  @override
  bool get playerContractAvailable => true;

  @override
  Future<DisputeCaseData?> fetchStatus(String disputeId) async => result;

  @override
  Future<DisputeCaseData?> submit({
    required DisputeMatchSummary match,
    required DisputeReason reason,
    required String details,
  }) async => result;
}

void _setViewport(WidgetTester tester) {
  tester.view.physicalSize = const Size(412, 915);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

Future<void> _capture(
  WidgetTester tester,
  Widget screen,
  DisputeState state,
  String name,
) async {
  _setViewport(tester);
  final router = GoRouter(
    initialLocation: '/capture',
    routes: [
      ShellRoute(
        builder: (context, routeState, child) => MainLayout(child: child),
        routes: [
          GoRoute(path: '/capture', builder: (context, routeState) => screen),
        ],
      ),
    ],
  );
  addTearDown(router.dispose);
  final notifier = DisputeNotifier(
    _VisualGateway(state.dispute),
    initial: state,
  );
  await tester.pumpWidget(
    ProviderScope(
      overrides: [disputeProvider.overrideWith((ref) => notifier)],
      child: MaterialApp.router(
        theme: AppTheme.dark,
        routerConfig: router,
        builder: (context, child) => RepaintBoundary(
          key: _captureKey,
          child: child ?? const SizedBox.shrink(),
        ),
      ),
    ),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
  expect(tester.takeException(), isNull);
  await expectLater(
    find.byKey(_captureKey),
    matchesGoldenFile('goldens/pr11/$name.png'),
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

  testWidgets('119 report match', (tester) async {
    await _capture(
      tester,
      const ReportMatchScreen(match: _match),
      const DisputeState(phase: DisputeLoadPhase.drafting, match: _match),
      '119_report_match',
    );
  });

  testWidgets('120 dispute reason', (tester) async {
    await _capture(
      tester,
      const DisputeReasonScreen(),
      const DisputeState(phase: DisputeLoadPhase.drafting, match: _match),
      '120_dispute_reason',
    );
  });

  testWidgets('121 add evidence', (tester) async {
    await _capture(
      tester,
      const AddEvidenceScreen(),
      const DisputeState(
        phase: DisputeLoadPhase.drafting,
        match: _match,
        reason: DisputeReason.suspectedCheating,
      ),
      '121_add_evidence',
    );
  });

  testWidgets('122 dispute submitted', (tester) async {
    await _capture(
      tester,
      const DisputeSubmittedScreen(),
      DisputeState(
        phase: DisputeLoadPhase.ready,
        match: _match,
        reason: DisputeReason.suspectedCheating,
        dispute: _case,
      ),
      '122_dispute_submitted',
    );
  });

  testWidgets('123 dispute status', (tester) async {
    await _capture(
      tester,
      const DisputeStatusScreen(autoRefresh: false),
      DisputeState(
        phase: DisputeLoadPhase.ready,
        match: _match,
        reason: DisputeReason.suspectedCheating,
        dispute: _case,
      ),
      '123_dispute_status',
    );
  });
}
