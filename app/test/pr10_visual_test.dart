import 'package:draughts_arena/models/eligibility.dart';
import 'package:draughts_arena/providers/eligibility_provider.dart';
import 'package:draughts_arena/screens/eligibility_screens.dart';
import 'package:draughts_arena/screens/safer_play_screens.dart';
import 'package:draughts_arena/screens/verification_screens.dart';
import 'package:draughts_arena/services/eligibility_gateway.dart';
import 'package:draughts_arena/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

const _captureKey = ValueKey('pr10-capture');

class _VisualGateway implements EligibilityGateway {
  const _VisualGateway(this.verification, this.profile);

  final VerificationSnapshot verification;
  final SaferPlayProfile profile;

  @override
  Future<VerificationSnapshot?> fetchVerificationStatus() async => verification;

  @override
  Future<SaferPlayProfile?> fetchSaferPlayProfile() async => profile;

  @override
  Future<VerificationSnapshot?> startVerification(
    VerificationCheckType type,
  ) async => verification;

  @override
  Future<SaferPlayProfile?> setDepositLimit(int? amountMinorUnits) async =>
      profile;

  @override
  Future<SaferPlayProfile?> setStakeLimit(int? amountMinorUnits) async =>
      profile;

  @override
  Future<SaferPlayProfile?> startSelfExclusion(String until) async => profile;

  @override
  Future<SaferPlayProfile?> startTimeout(int minutes) async => profile;
}

class _VisualNotifier extends EligibilityNotifier {
  _VisualNotifier(EligibilityState initial)
    : super(
        _VisualGateway(
          initial.verification ??
              const VerificationSnapshot(
                status: VerificationStatus.notRequired,
              ),
          initial.saferPlay ?? const SaferPlayProfile(),
        ),
        initialState: initial,
      );
}

void _setViewport(WidgetTester tester) {
  tester.view.physicalSize = const Size(412, 915);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

Widget _capture(Widget child, EligibilityState state) => ProviderScope(
  overrides: [
    eligibilityProvider.overrideWith((ref) => _VisualNotifier(state)),
  ],
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
    matchesGoldenFile('goldens/pr10/$name.png'),
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

  final saferProfile = SaferPlayProfile(
    effectiveDepositLimitMinorUnits: 500000,
    effectiveStakeLimitMinorUnits: 100000,
    // Fixed far-future stamp: the dashboard only renders the absolute date, so
    // this stays deterministic while never ageing the fixture into the past.
    timeoutUntil: DateTime(2099, 1, 1, 12),
  );
  final captures = <String, (Widget, EligibilityState)>{
    '24_age_and_legal': (
      const AgeLegalEligibilityScreen(),
      const EligibilityState(phase: EligibilityLoadPhase.ready),
    ),
    '62_verify_identity': (
      const VerificationIntroScreen(),
      const EligibilityState(
        phase: EligibilityLoadPhase.ready,
        verification: VerificationSnapshot(status: VerificationStatus.required),
      ),
    ),
    '67_verification_processing': (
      const VerificationStatusScreen(status: VerificationStatus.pending),
      const EligibilityState(
        phase: EligibilityLoadPhase.ready,
        verification: VerificationSnapshot(status: VerificationStatus.pending),
      ),
    ),
    '68_verification_successful': (
      const VerificationStatusScreen(status: VerificationStatus.verified),
      const EligibilityState(
        phase: EligibilityLoadPhase.ready,
        verification: VerificationSnapshot(status: VerificationStatus.verified),
      ),
    ),
    '69_verification_rejected': (
      const VerificationStatusScreen(status: VerificationStatus.rejected),
      const EligibilityState(
        phase: EligibilityLoadPhase.ready,
        verification: VerificationSnapshot(status: VerificationStatus.rejected),
      ),
    ),
    '98_safer_play': (
      const SaferPlayDashboardScreen(),
      EligibilityState(
        phase: EligibilityLoadPhase.ready,
        saferPlay: saferProfile,
      ),
    ),
    '99_deposit_limit': (
      const LimitEditorScreen(deposit: true),
      EligibilityState(
        phase: EligibilityLoadPhase.ready,
        saferPlay: saferProfile,
      ),
    ),
    '102_self_exclusion': (
      const SelfExclusionScreen(),
      EligibilityState(
        phase: EligibilityLoadPhase.ready,
        saferPlay: saferProfile,
      ),
    ),
    'eligibility_blocked': (
      const EligibilityBlockedScreen(
        decision: EligibilityDecision(
          reason: EligibilityReason.kycRequired,
          message: 'KYC verification is required for this action.',
          remediation: EligibilityRemediation.verifyIdentity,
        ),
      ),
      const EligibilityState(phase: EligibilityLoadPhase.ready),
    ),
    'account_restricted': (
      const AccountRestrictedScreen(caseReference: 'CASE-123456789'),
      const EligibilityState(phase: EligibilityLoadPhase.ready),
    ),
  };

  for (final entry in captures.entries) {
    testWidgets('${entry.key} matches the approved PR10 visual language', (
      tester,
    ) async {
      _setViewport(tester);
      final (screen, state) = entry.value;
      await tester.pumpWidget(_capture(screen, state));
      await _verify(tester, entry.key);
    });
  }
}
