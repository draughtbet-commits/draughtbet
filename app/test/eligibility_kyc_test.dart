import 'package:dio/dio.dart';
import 'package:draughts_arena/models/eligibility.dart';
import 'package:draughts_arena/providers/eligibility_provider.dart';
import 'package:draughts_arena/screens/eligibility_screens.dart';
import 'package:draughts_arena/screens/verification_screens.dart';
import 'package:draughts_arena/services/eligibility_gateway.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'dart:async';

class _MockDio extends Mock implements Dio {}

class _FakeGateway implements EligibilityGateway {
  VerificationSnapshot? verification = const VerificationSnapshot(
    status: VerificationStatus.notRequired,
  );
  SaferPlayProfile? profile = const SaferPlayProfile();
  int refreshCount = 0;
  int startCount = 0;
  VerificationCheckType? startedType;
  Completer<VerificationSnapshot?>? pendingVerification;

  @override
  Future<VerificationSnapshot?> fetchVerificationStatus() async {
    refreshCount++;
    return verification;
  }

  @override
  Future<SaferPlayProfile?> fetchSaferPlayProfile() async => profile;

  @override
  Future<VerificationSnapshot?> startVerification(VerificationCheckType type) {
    startCount++;
    startedType = type;
    return pendingVerification?.future ?? Future.value(verification);
  }

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

void main() {
  group('verification contract parsing', () {
    final cases = <String, VerificationStatus>{
      'NOT_REQUIRED': VerificationStatus.notRequired,
      'NONE': VerificationStatus.notRequired,
      'REQUIRED': VerificationStatus.required,
      'STARTED': VerificationStatus.started,
      'PENDING': VerificationStatus.pending,
      'UNDER_REVIEW': VerificationStatus.underReview,
      'VERIFIED': VerificationStatus.verified,
      'REJECTED': VerificationStatus.rejected,
      'EXPIRED': VerificationStatus.expired,
    };

    for (final entry in cases.entries) {
      test('maps ${entry.key}', () {
        expect(verificationStatusFromWire(entry.key), entry.value);
      });
    }

    test('prefers authoritative case status over user projection', () {
      final snapshot = VerificationSnapshot.tryFromServer({
        'kycStatus': 'PENDING',
        'case': {
          'id': 'case-sensitive-reference',
          'status': 'UNDER_REVIEW',
          'updatedAt': '2026-09-24T10:00:00.000Z',
          'checks': [
            {'id': 'check-1', 'type': 'ID_DOCUMENT', 'status': 'PENDING'},
          ],
        },
      });
      expect(snapshot?.status, VerificationStatus.underReview);
      expect(snapshot?.checks.single.type, 'ID_DOCUMENT');
    });

    test('rejects missing or invalid verification data safely', () {
      expect(VerificationSnapshot.tryFromServer(null), isNull);
      expect(
        VerificationSnapshot.tryFromServer({'kycStatus': 'MAGIC'}),
        isNull,
      );
    });
  });

  group('typed eligibility decisions', () {
    test('maps every stable backend eligibility message', () {
      final messages = <String, EligibilityReason>{
        'KYC verification is required for this action':
            EligibilityReason.kycRequired,
        'Age has not been verified': EligibilityReason.ageNotVerified,
        'This app is not available in your country':
            EligibilityReason.countryNotAllowed,
        'This account is restricted': EligibilityReason.accountRestricted,
        'Self-exclusion is active until 2026-10-01T10:00:00.000Z':
            EligibilityReason.selfExcluded,
        'A break is active until the timeout ends':
            EligibilityReason.timeoutActive,
        'Deposit would exceed your daily limit':
            EligibilityReason.depositLimitExceeded,
        'Stake exceeds your safer-play limit':
            EligibilityReason.stakeLimitExceeded,
        'Account eligibility has not been verified':
            EligibilityReason.eligibilityRequired,
      };
      for (final entry in messages.entries) {
        final decision = EligibilityDecision.fromServerError(
          statusCode:
              entry.value == EligibilityReason.depositLimitExceeded ||
                  entry.value == EligibilityReason.stakeLimitExceeded
              ? 422
              : 403,
          body: {'error': entry.key},
        );
        expect(decision?.reason, entry.value);
      }
    });

    test('does not convert unrelated failures into eligibility decisions', () {
      expect(
        EligibilityDecision.fromServerError(
          statusCode: 500,
          body: {'error': 'Server error'},
        ),
        isNull,
      );
    });
  });

  test(
    'safer-play profile keeps server effective and pending values separate',
    () {
      final profile = SaferPlayProfile.tryFromServer({
        'profile': {
          'depositLimitMinorUnits': '500000',
          'effectiveDepositLimitMinorUnits': '500000',
          'pendingDepositLimitMinorUnits': '1000000',
          'pendingDepositLimitRaisedAt': '2026-09-24T10:00:00.000Z',
          'stakeLimitMinorUnits': '100000',
          'effectiveStakeLimitMinorUnits': '100000',
          'timeoutUntil': '2026-09-25T10:00:00.000Z',
        },
      });
      expect(profile?.effectiveDepositLimitMinorUnits, 500000);
      expect(profile?.pendingDepositLimitMinorUnits, 1000000);
      expect(profile?.effectiveStakeLimitMinorUnits, 100000);
    },
  );

  test('safer-play profile rejects malformed financial and date fields', () {
    expect(
      SaferPlayProfile.tryFromServer({
        'profile': {'effectiveDepositLimitMinorUnits': 500000},
      }),
      isNull,
    );
    expect(
      SaferPlayProfile.tryFromServer({
        'profile': {'timeoutUntil': 'not-a-date'},
      }),
      isNull,
    );
    expect(
      SaferPlayProfile.tryFromServer({}, allowMissingProfile: false),
      isNull,
    );
  });

  test('duplicate verification start is prevented', () async {
    final gateway = _FakeGateway()
      ..pendingVerification = Completer<VerificationSnapshot?>();
    final notifier = EligibilityNotifier(gateway);
    final first = notifier.startVerification(VerificationCheckType.idDocument);
    expect(notifier.state.submitting, isTrue);
    expect(
      await notifier.startVerification(VerificationCheckType.selfie),
      VerificationStatus.unavailable,
    );
    expect(gateway.startCount, 1);
    gateway.pendingVerification!.complete(
      const VerificationSnapshot(status: VerificationStatus.pending),
    );
    expect(await first, VerificationStatus.pending);
  });

  test(
    'gateway uses only verified PR10 routes and sends no identity payload',
    () async {
      final dio = _MockDio();
      when(
        () =>
            dio.post<dynamic>('/verification/start', data: any(named: 'data')),
      ).thenAnswer(
        (_) async => Response<dynamic>(
          requestOptions: RequestOptions(path: '/verification/start'),
          statusCode: 201,
          data: {'status': 'VERIFIED'},
        ),
      );
      when(() => dio.get<dynamic>('/verification/status')).thenAnswer(
        (_) async => Response<dynamic>(
          requestOptions: RequestOptions(path: '/verification/status'),
          data: {'kycStatus': 'VERIFIED', 'case': null},
        ),
      );
      final gateway = EligibilityGateway(dio);
      final result = await gateway.startVerification(
        VerificationCheckType.idDocument,
      );
      expect(result?.status, VerificationStatus.verified);
      final captured =
          verify(
                () => dio.post<dynamic>(
                  '/verification/start',
                  data: captureAny(named: 'data'),
                ),
              ).captured.single
              as Map<String, dynamic>;
      expect(captured, {'type': 'ID_DOCUMENT'});
      expect(captured.keys, isNot(contains('document')));
      expect(captured.keys, isNot(contains('selfie')));
      expect(captured.keys, isNot(contains('personalDetails')));
    },
  );

  group('verification screens', () {
    final states = <VerificationStatus, String>{
      VerificationStatus.notRequired: 'VERIFICATION REQUIRED',
      VerificationStatus.required: 'VERIFICATION REQUIRED',
      VerificationStatus.started: 'VERIFICATION PROCESSING',
      VerificationStatus.pending: 'VERIFICATION PROCESSING',
      VerificationStatus.underReview: 'VERIFICATION PROCESSING',
      VerificationStatus.verified: 'IDENTITY VERIFIED',
      VerificationStatus.rejected: 'VERIFICATION REJECTED',
      VerificationStatus.expired: 'VERIFICATION EXPIRED',
      VerificationStatus.unavailable: 'STATUS UNAVAILABLE',
    };

    for (final entry in states.entries) {
      testWidgets('renders ${entry.key.name}', (tester) async {
        await _pump(
          tester,
          VerificationStatusScreen(status: entry.key),
          status: entry.key,
        );
        expect(find.text(entry.value), findsWidgets);
        expect(tester.takeException(), isNull);
      });
    }

    testWidgets('renders intro, personal, ID, upload and selfie steps', (
      tester,
    ) async {
      for (final screen in <Widget>[
        const VerificationIntroScreen(),
        const VerificationPersonalDetailsScreen(),
        const VerificationIdTypeScreen(),
        const VerificationUploadIdScreen(
          type: VerificationCheckType.idDocument,
        ),
        const VerificationSelfieScreen(type: VerificationCheckType.idDocument),
      ]) {
        await _pump(tester, screen);
        expect(tester.takeException(), isNull);
      }
    });

    testWidgets('refreshes canonical status when the app resumes', (
      tester,
    ) async {
      final gateway = _FakeGateway();
      await _pump(tester, const VerificationIntroScreen(), gateway: gateway);
      await tester.pump();
      final initial = gateway.refreshCount;
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      expect(gateway.refreshCount, greaterThan(initial));
    });

    testWidgets('remains usable on a small screen with large text', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(320, 568);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await _pump(
        tester,
        const VerificationStatusScreen(status: VerificationStatus.rejected),
        status: VerificationStatus.rejected,
        textScaler: const TextScaler.linear(1.45),
      );
      expect(tester.takeException(), isNull);
      expect(find.text('Review and retry'), findsOneWidget);
    });
  });

  testWidgets('eligibility blocked screen renders typed remediation', (
    tester,
  ) async {
    await _pump(
      tester,
      const EligibilityBlockedScreen(
        decision: EligibilityDecision(
          reason: EligibilityReason.stakeLimitExceeded,
          message: 'Stake exceeds your safer-play limit',
          remediation: EligibilityRemediation.viewLimits,
        ),
      ),
    );
    expect(find.text('LIMIT REACHED'), findsOneWidget);
    expect(find.text('View limits'), findsOneWidget);
  });
}

Future<void> _pump(
  WidgetTester tester,
  Widget child, {
  VerificationStatus status = VerificationStatus.notRequired,
  _FakeGateway? gateway,
  TextScaler textScaler = TextScaler.noScaling,
}) async {
  final effectiveGateway = gateway ?? _FakeGateway();
  effectiveGateway.verification = VerificationSnapshot(status: status);
  final notifier = EligibilityNotifier(
    effectiveGateway,
    initialState: EligibilityState(
      phase: EligibilityLoadPhase.ready,
      verification: VerificationSnapshot(status: status),
      saferPlay: const SaferPlayProfile(),
    ),
  );
  await tester.pumpWidget(
    ProviderScope(
      overrides: [eligibilityProvider.overrideWith((ref) => notifier)],
      child: MaterialApp(
        theme: ThemeData.dark(),
        home: MediaQuery(
          data: MediaQueryData(textScaler: textScaler),
          child: child,
        ),
      ),
    ),
  );
  await tester.pump();
}
