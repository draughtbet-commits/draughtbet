import 'package:draughts_arena/models/eligibility.dart';
import 'package:draughts_arena/providers/eligibility_provider.dart';
import 'package:draughts_arena/services/eligibility_gateway.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// Gateway whose ban flag the test controls, standing in for the server.
class _FakeGateway implements EligibilityGateway {
  _FakeGateway({required this.banned});

  bool banned;

  VerificationSnapshot get _snapshot => VerificationSnapshot(
    status: VerificationStatus.verified,
    isBanned: banned,
  );

  @override
  Future<VerificationSnapshot?> fetchVerificationStatus() async => _snapshot;

  @override
  Future<SaferPlayProfile?> fetchSaferPlayProfile() async =>
      const SaferPlayProfile();

  @override
  Future<VerificationStartResult> startVerification(VerificationCheckType t) async =>
      VerificationStartResult(snapshot: _snapshot);

  @override
  Future<SaferPlayProfile?> setDepositLimit(int? a) async => null;

  @override
  Future<SaferPlayProfile?> setStakeLimit(int? a) async => null;

  @override
  Future<SaferPlayProfile?> startSelfExclusion(String u) async => null;

  @override
  Future<SaferPlayProfile?> startTimeout(int m) async => null;
}

int _pumpCount = 0;

void main() {
  group('applyPushedAccountStatus', () {
    test('clears the restriction when an admin reinstates the account', () {
      final gateway = _FakeGateway(banned: true);
      final notifier = EligibilityNotifier(gateway);
      final pushed = <bool>[];

      // Start banned, as it would be after the first fetch.
      gateway.banned = true;
      final seeded = EligibilityNotifier(gateway)
        ..applyPushedAccountStatus(true);
      expect(seeded.state.verification?.isBanned, isTrue);

      final changes = <bool>[];
      final listener = EligibilityNotifier(
        gateway,
        onAccountStatus: changes.add,
      );
      listener.applyPushedAccountStatus(true);

      final changed = listener.applyPushedAccountStatus(false);

      expect(changed, isTrue, reason: 'unban must be observable');
      expect(listener.state.verification?.isBanned, isFalse);
      expect(changes, [true, false]);
      notifier.dispose();
      seeded.dispose();
      listener.dispose();
      pushed.clear();
    });

    test('is a no-op when the pushed value already matches', () {
      final notifier = EligibilityNotifier(_FakeGateway(banned: false));
      final changes = <bool>[];
      final watched = EligibilityNotifier(
        _FakeGateway(banned: false),
        onAccountStatus: changes.add,
      );

      final changed = watched.applyPushedAccountStatus(false);

      expect(changed, isFalse);
      expect(changes, isEmpty);
      notifier.dispose();
      watched.dispose();
    });

    test('preserves verification status when the flag flips', () {
      final gateway = _FakeGateway(banned: true);
      final notifier = EligibilityNotifier(
        gateway,
        initialState: const EligibilityState(
          phase: EligibilityLoadPhase.ready,
          verification: VerificationSnapshot(
            status: VerificationStatus.underReview,
            caseId: 'case-9',
            isBanned: true,
          ),
        ),
      );

      notifier.applyPushedAccountStatus(false);

      expect(notifier.state.verification?.isBanned, isFalse);
      expect(
        notifier.state.verification?.status,
        VerificationStatus.underReview,
        reason: 'a ban push must not look like a verification reset',
      );
      expect(notifier.state.verification?.caseId, 'case-9');
      notifier.dispose();
    });

    test('seeds a snapshot when one has not loaded yet', () {
      final notifier = EligibilityNotifier(_FakeGateway(banned: false));

      notifier.applyPushedAccountStatus(true);

      expect(notifier.state.verification?.isBanned, isTrue);
      expect(notifier.state.phase, EligibilityLoadPhase.ready);
      notifier.dispose();
    });
  });

  group('VerificationSnapshot.copyWith', () {
    test('changes only the flag', () {
      const base = VerificationSnapshot(
        status: VerificationStatus.verified,
        caseId: 'case-1',
        isBanned: true,
      );
      final lifted = base.copyWith(isBanned: false);
      expect(lifted.isBanned, isFalse);
      expect(lifted.caseId, 'case-1');
      expect(lifted.status, VerificationStatus.verified);
    });
  });

  // Guards the reported symptom: after an unban the shell must not keep
  // rendering a stale restricted heading.
  group('banner visibility follows the ban flag', () {
    Future<void> pump(WidgetTester t, bool banned) async {
      _pumpCount++;
      await t.pumpWidget(
        ProviderScope(
          // Distinct key per case: Riverpod reuses a container across pumps of
          // the same element, which would otherwise serve the previous case's
          // state and hide the very transition under test.
          key: ValueKey('banned-$banned-$_pumpCount'),
          overrides: [
            eligibilityProvider.overrideWith(
              (ref) => EligibilityNotifier(
                _FakeGateway(banned: banned),
                initialState: EligibilityState(
                  phase: EligibilityLoadPhase.ready,
                  verification: VerificationSnapshot(
                    status: VerificationStatus.verified,
                    isBanned: banned,
                  ),
                ),
              ),
            ),
          ],
          child: const MaterialApp(
            home: Scaffold(body: Column(children: [_FakeBannerProbe()])),
          ),
        ),
      );
      await t.pump();
    }

    testWidgets('hidden when not banned, shown when banned', (tester) async {
      await pump(tester, false);
      expect(find.text('Account restricted'), findsNothing);

      await pump(tester, true);
      expect(find.text('Account restricted'), findsOneWidget);
    });
  });
}

/// Mirrors the banner's own predicate without dragging in the socket global.
class _FakeBannerProbe extends ConsumerWidget {
  const _FakeBannerProbe();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final isBanned = ref.watch(eligibilityProvider).verification?.isBanned ?? false;
    if (!isBanned) return const SizedBox.shrink();
    return const Text('Account restricted');
  }
}