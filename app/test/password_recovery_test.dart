import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:draughts_arena/providers/password_recovery_provider.dart';
import 'package:draughts_arena/screens/password_recovery_screen.dart';
import 'package:draughts_arena/services/password_recovery_gateway.dart';
import 'package:draughts_arena/theme/app_theme.dart';

class RecoveryFixtureGateway implements PasswordRecoveryGateway {
  int requests = 0;
  int verifications = 0;
  int resets = 0;
  bool confirmed = true;
  bool emptyGrant = false;
  RecoveryException? failure;
  Completer<RecoveryChallenge>? pending;
  Duration resendAfter = Duration.zero;
  @override
  Future<RecoveryChallenge> requestCode(String contact) async {
    requests++;
    if (failure != null) throw failure!;
    return pending?.future ??
        RecoveryChallenge(
          id: 'test-challenge',
          maskedContact: 'w•••••@example.com',
          resendAfter: resendAfter,
        );
  }

  @override
  Future<String> verifyCode(String challengeId, String code) async {
    verifications++;
    if (failure != null) throw failure!;
    return emptyGrant ? '' : 'test-grant';
  }

  @override
  Future<bool> resetPassword(String resetGrant, String password) async {
    resets++;
    if (failure != null) throw failure!;
    return confirmed;
  }
}

Future<PasswordRecoveryNotifier> recoveryFixture(
  RecoveryStep step, [
  RecoveryFixtureGateway? gateway,
]) async {
  final notifier = PasswordRecoveryNotifier(
    gateway ?? RecoveryFixtureGateway(),
  );
  if (step != RecoveryStep.contact) {
    await notifier.requestCode('wisdom@example.com');
  }
  if (step == RecoveryStep.password || step == RecoveryStep.success) {
    await notifier.verify('123456');
  }
  if (step == RecoveryStep.success) {
    await notifier.updatePassword('NewPassword123');
  }
  return notifier;
}

Future<GoRouter> pumpRecovery(
  WidgetTester tester,
  PasswordRecoveryNotifier notifier, {
  double scale = 1,
  Key? captureKey,
}) async {
  final router = GoRouter(
    initialLocation: PasswordRecoveryScreen.route,
    routes: [
      GoRoute(
        path: PasswordRecoveryScreen.route,
        builder: (_, _) => const PasswordRecoveryScreen(),
      ),
      GoRoute(
        path: '/login',
        builder: (_, _) => const Scaffold(body: Text('Sign in destination')),
      ),
    ],
  );
  addTearDown(router.dispose);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [passwordRecoveryProvider.overrideWith((ref) => notifier)],
      child: MaterialApp.router(
        theme: AppTheme.dark,
        routerConfig: router,
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(
            context,
          ).copyWith(textScaler: TextScaler.linear(scale)),
          child: RepaintBoundary(key: captureKey, child: child!),
        ),
      ),
    ),
  );
  await tester.pump();
  return router;
}

void main() {
  test(
    'production missing contract never advances or claims a code was sent',
    () async {
      final notifier = PasswordRecoveryNotifier(
        const UnavailablePasswordRecoveryGateway(),
      );
      addTearDown(notifier.dispose);
      await notifier.requestCode('wisdom@example.com');
      expect(notifier.state.step, RecoveryStep.contact);
      expect(notifier.state.error, contains('unavailable'));
      await notifier.verify('123456');
      await notifier.updatePassword('NewPassword123');
      expect(notifier.state.step, RecoveryStep.contact);
    },
  );
  test(
    'contact and password validation follow existing password requirements',
    () {
      expect(validateRecoveryContact('invalid'), isNotNull);
      expect(validateRecoveryContact('a@example.com'), isNull);
      expect(validateRecoveryContact('+2348012345678'), isNull);
      for (final value in ['short', 'password123', 'PASSWORD123', 'Password']) {
        expect(validateRecoveryPassword(value), isNotNull);
      }
      expect(validateRecoveryPassword('Password123'), isNull);
    },
  );
  test(
    'duplicates and stale completion after restarting are ignored',
    () async {
      final gateway = RecoveryFixtureGateway()
        ..pending = Completer<RecoveryChallenge>();
      final notifier = PasswordRecoveryNotifier(gateway);
      addTearDown(notifier.dispose);
      final first = notifier.requestCode('a@example.com');
      await notifier.requestCode('a@example.com');
      expect(gateway.requests, 1);
      notifier.startOver();
      gateway.pending!.complete(
        const RecoveryChallenge(
          id: 'old',
          maskedContact: 'a••@example.com',
          resendAfter: Duration.zero,
        ),
      );
      await first;
      expect(notifier.state.step, RecoveryStep.contact);
    },
  );
  test('disposal during a request ignores its response', () async {
    final gateway = RecoveryFixtureGateway()
      ..pending = Completer<RecoveryChallenge>();
    final notifier = PasswordRecoveryNotifier(gateway);
    final request = notifier.requestCode('a@example.com');
    notifier.dispose();
    gateway.pending!.complete(
      const RecoveryChallenge(
        id: 'old',
        maskedContact: 'a••@example.com',
        resendAfter: Duration.zero,
      ),
    );
    await expectLater(request, completes);
  });
  test(
    'server cooldown blocks resend; malformed grant never unlocks reset',
    () async {
      final gateway = RecoveryFixtureGateway()
        ..resendAfter = const Duration(seconds: 45)
        ..emptyGrant = true;
      final notifier = await recoveryFixture(RecoveryStep.code, gateway);
      addTearDown(notifier.dispose);
      await notifier.resend();
      expect(gateway.requests, 1);
      await notifier.verify('123456');
      expect(notifier.state.step, RecoveryStep.code);
      await notifier.updatePassword('NewPassword123');
      expect(gateway.resets, 0);
    },
  );
  test(
    'expired code blocks verification until a new challenge is received',
    () async {
      final gateway = RecoveryFixtureGateway();
      final notifier = await recoveryFixture(RecoveryStep.code, gateway);
      addTearDown(notifier.dispose);
      gateway.failure = const RecoveryException(RecoveryFailure.expired);
      await notifier.verify('123456');
      expect(notifier.state.expired, isTrue);
      await notifier.verify('123456');
      expect(gateway.verifications, 1);
      gateway.failure = null;
      await notifier.resend();
      expect(notifier.state.expired, isFalse);
      expect(gateway.requests, 2);
    },
  );
  test(
    'only confirmed reset displays success; errors never include raw payload',
    () async {
      final gateway = RecoveryFixtureGateway()..confirmed = false;
      final notifier = await recoveryFixture(RecoveryStep.password, gateway);
      addTearDown(notifier.dispose);
      await notifier.updatePassword('NewPassword123');
      expect(notifier.state.step, RecoveryStep.password);
      expect(notifier.state.error, contains('could not confirm'));
      gateway.confirmed = true;
      await notifier.updatePassword('NewPassword123');
      expect(notifier.state.step, RecoveryStep.success);
      expect(notifier.state.maskedContact, isEmpty);
    },
  );
  testWidgets(
    'complete recovery navigation validates code and matching passwords',
    (tester) async {
      final notifier = await recoveryFixture(RecoveryStep.contact);
      await pumpRecovery(tester, notifier);
      await tester.enterText(
        find.byKey(const Key('recovery-contact')),
        'wisdom@example.com',
      );
      await tester.tap(find.text('Send code'));
      await tester.pumpAndSettle();
      expect(find.text('Verification code'), findsOneWidget);
      await tester.enterText(find.byKey(const Key('recovery-code')), '123456');
      await tester.tap(find.text('Verify code'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('New password')),
        'NewPassword123',
      );
      await tester.enterText(
        find.byKey(const ValueKey('Confirm new password')),
        'Different123',
      );
      await tester.ensureVisible(find.text('Update password'));
      await tester.tap(find.text('Update password'));
      await tester.pump();
      expect(find.text('Passwords do not match.'), findsOneWidget);
      await tester.enterText(
        find.byKey(const ValueKey('Confirm new password')),
        'NewPassword123',
      );
      await tester.ensureVisible(find.text('Update password'));
      await tester.tap(find.text('Update password'));
      await tester.pumpAndSettle();
      expect(find.text('Password reset\nsuccessful!'), findsOneWidget);
      await tester.ensureVisible(find.text('Continue to sign in'));
      await tester.tap(find.text('Continue to sign in'));
      await tester.pumpAndSettle();
      expect(find.text('Sign in destination'), findsOneWidget);
    },
  );
  testWidgets('all states fit compact screens, keyboard and large text', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(320, 568);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    for (final step in RecoveryStep.values) {
      await tester.pumpWidget(const SizedBox.shrink());
      await pumpRecovery(tester, await recoveryFixture(step), scale: 1.5);
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull, reason: step.name);
    }
  });
}
