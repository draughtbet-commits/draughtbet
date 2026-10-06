import 'dart:async';

import 'package:dio/dio.dart';
import 'package:draughts_arena/models/dispute.dart';
import 'package:draughts_arena/providers/dispute_provider.dart';
import 'package:draughts_arena/screens/dispute_screens.dart';
import 'package:draughts_arena/services/dispute_gateway.dart';
import 'package:draughts_arena/services/secure_storage.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

const _match = DisputeMatchSummary(
  matchId: 'match-214567',
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

class _FakeGateway implements DisputeGateway {
  _FakeGateway({
    this.available = true,
    this.statusAvailable = true,
    this.result,
  });

  bool available;
  bool statusAvailable;
  DisputeCaseData? result;
  int submitCount = 0;
  int fetchCount = 0;
  Completer<DisputeCaseData?>? pendingSubmit;

  @override
  bool get playerContractAvailable => available;

  @override
  bool get statusContractAvailable => statusAvailable;

  @override
  Future<DisputeCaseData?> fetchStatus({
    required String matchId,
    required String disputeId,
  }) async {
    fetchCount++;
    return result;
  }

  @override
  Future<bool?> caseExists({
    required String matchId,
    required String disputeId,
  }) async => result != null;

  @override
  Future<DisputeCaseData?> submit({
    required DisputeMatchSummary match,
    required DisputeReason reason,
    required String details,
  }) {
    submitCount++;
    return pendingSubmit?.future ?? Future.value(result);
  }
}

class _MemoryDisputeStorage extends SecureStorageService {
  _MemoryDisputeStorage([List<DisputeCaseRef> refs = const []])
    : refs = [...refs];

  List<DisputeCaseRef> refs;

  @override
  Future<List<DisputeCaseRef>> loadDisputeRefs() async => List.unmodifiable(
    refs,
  );

  @override
  Future<void> storeDisputeRef(DisputeCaseRef ref) async {
    refs = [
      for (final entry in refs)
        if (entry.matchId != ref.matchId && entry.disputeId != ref.disputeId)
          entry,
      ref,
    ];
  }

  @override
  Future<void> saveDisputeRefs(List<DisputeCaseRef> refs) async {
    this.refs = [...refs];
  }
}

void main() {
  group('authoritative dispute parsing', () {
    for (final entry in <String, DisputeStatus>{
      'OPEN': DisputeStatus.open,
      'UNDER_REVIEW': DisputeStatus.underReview,
      'RESOLVED': DisputeStatus.resolved,
      'DISMISSED': DisputeStatus.dismissed,
    }.entries) {
      test('maps ${entry.key}', () {
        expect(disputeStatusFromWire(entry.key), entry.value);
      });
    }

    test('accepts complete server data and masks the case reference', () {
      final parsed = DisputeCaseData.tryFromServer({
        'dispute': {
          'id': 'DRP89231',
          'matchId': 'match-214567',
          'status': 'UNDER_REVIEW',
          'reason': 'Suspected cheating',
          'createdAt': '2026-09-28T20:03:00.000Z',
          'updatedAt': '2026-09-28T22:17:00.000Z',
        },
      });
      expect(parsed?.status, DisputeStatus.underReview);
      expect(parsed?.maskedReference, '#DRP•••231');
    });

    test('rejects incomplete or invented server status', () {
      expect(
        DisputeCaseData.tryFromServer({
          'dispute': {
            'id': 'DRP1',
            'matchId': 'match-1',
            'status': 'MAGIC',
            'reason': 'Other',
          },
        }),
        isNull,
      );
    });

    test('maps the player submit response the backend returns', () {
      // POST /api/v1/matches/:matchId/disputes answers with a flat body and
      // no timestamps or timeline, so this pins the real contract.
      final parsed = DisputeCaseData.tryFromSubmit(
        {
          'disputeId': 'd3f1a2b4-5678-4cde-9012-3456789abcde',
          'status': 'OPEN',
          'matchId': 'mat_9',
          'category': 'SUSPECTED_CHEATING',
        },
        matchId: 'mat_9',
        reasonLabel: 'Suspected cheating',
      );

      expect(parsed?.id, 'd3f1a2b4-5678-4cde-9012-3456789abcde');
      expect(parsed?.maskedReference, '#D3F•••CDE');
      expect(parsed?.matchId, 'mat_9');
      expect(parsed?.status, DisputeStatus.open);
      expect(parsed?.reason, 'Suspected cheating');
      expect(parsed?.timeline, isEmpty);
      expect(parsed?.resolution, isNull);
    });

    test(
      'submit response with an unknown status is never treated as success',
      () {
        expect(
          DisputeCaseData.tryFromSubmit(
            {'disputeId': 'x', 'status': 'MYSTERY', 'matchId': 'mat_9'},
            matchId: 'mat_9',
            reasonLabel: 'Other',
          ),
          isNull,
        );
      },
    );
  });

  test('production gateway exposes submit and status reads', () {
    final gateway = BackendDisputeGateway(Dio());
    expect(gateway.playerContractAvailable, isTrue);
    expect(gateway.statusContractAvailable, isTrue);
  });

  test('missing contract never claims that a dispute was submitted', () async {
    final gateway = _FakeGateway(available: false);
    final notifier = DisputeNotifier(gateway)
      ..start(_match)
      ..selectReason(DisputeReason.incorrectResult);
    expect(await notifier.submit(), isFalse);
    expect(gateway.submitCount, 0);
    expect(notifier.state.dispute, isNull);
    expect(notifier.state.phase, DisputeLoadPhase.unavailable);
  });

  test('duplicate submission is prevented', () async {
    final gateway = _FakeGateway()
      ..pendingSubmit = Completer<DisputeCaseData?>();
    final notifier = DisputeNotifier(gateway)
      ..start(_match)
      ..selectReason(DisputeReason.suspectedCheating);
    final first = notifier.submit();
    expect(notifier.state.phase, DisputeLoadPhase.submitting);
    expect(await notifier.submit(), isFalse);
    expect(gateway.submitCount, 1);
    gateway.pendingSubmit!.complete(_case);
    expect(await first, isTrue);
    expect(notifier.state.dispute, same(_case));
  });

  test('status refresh trusts only the matching server case', () async {
    final gateway = _FakeGateway(result: _case);
    final notifier = DisputeNotifier(
      gateway,
      initial: DisputeState(
        phase: DisputeLoadPhase.ready,
        match: _match,
        dispute: _case,
      ),
    );
    expect(await notifier.refreshStatus(_case.id), isTrue);
    expect(gateway.fetchCount, 1);
    expect(notifier.state.dispute?.status, DisputeStatus.underReview);
  });

  test(
    'status refresh fails closed while the status contract is unavailable',
    () async {
      final gateway = _FakeGateway(result: _case, statusAvailable: false);
      final notifier = DisputeNotifier(
        gateway,
        initial: DisputeState(
          phase: DisputeLoadPhase.ready,
          match: _match,
          dispute: _case,
        ),
      );
      expect(await notifier.refreshStatus(_case.id), isFalse);
      expect(gateway.fetchCount, 0);
      expect(notifier.state.phase, DisputeLoadPhase.unavailable);
    },
  );

  test('a confirmed submission is remembered in secure storage', () async {
    final gateway = _FakeGateway(result: _case);
    final storage = _MemoryDisputeStorage();
    final notifier = DisputeNotifier(gateway, storage: storage)
      ..start(_match)
      ..selectReason(DisputeReason.suspectedCheating);
    expect(await notifier.submit(), isTrue);
    await pumpEventQueue();
    final stored = storage.refs.single;
    expect(stored.matchId, 'match-214567');
    expect(stored.disputeId, 'DRP89231');
  });

  test('status refresh recovers the match from the stored ref', () async {
    final gateway = _FakeGateway(result: _case);
    final storage = _MemoryDisputeStorage([
      const DisputeCaseRef(matchId: 'match-214567', disputeId: 'DRP89231'),
    ]);
    final notifier = DisputeNotifier(gateway, storage: storage);
    expect(await notifier.refreshStatus('DRP89231'), isTrue);
    expect(gateway.fetchCount, 1);
    expect(notifier.state.dispute?.matchId, 'match-214567');
    expect(notifier.state.dispute?.status, DisputeStatus.underReview);
  });

  testWidgets('report and reason screens navigate through the approved flow', (
    tester,
  ) async {
    final gateway = _FakeGateway(result: _case);
    final notifier = DisputeNotifier(gateway);
    final router = _router();
    addTearDown(router.dispose);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [disputeProvider.overrideWith((ref) => notifier)],
        child: MaterialApp.router(routerConfig: router),
      ),
    );
    await tester.pump();
    await tester.ensureVisible(find.text('Continue').first);
    await tester.tap(find.text('Continue').first);
    await tester.pumpAndSettle();
    expect(find.text('WHY ARE YOU REPORTING?'), findsOneWidget);
    await tester.tap(find.text('Incorrect result'));
    await tester.ensureVisible(find.text('Continue'));
    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();
    expect(find.text('ADD EVIDENCE'), findsOneWidget);
    expect(notifier.state.reason, DisputeReason.incorrectResult);
  });

  testWidgets('submitted state appears only with a server-confirmed case', (
    tester,
  ) async {
    final gateway = _FakeGateway(result: _case);
    final notifier = DisputeNotifier(
      gateway,
      initial: DisputeState(
        phase: DisputeLoadPhase.ready,
        match: _match,
        reason: DisputeReason.suspectedCheating,
        dispute: _case,
      ),
    );
    await _pump(tester, const DisputeSubmittedScreen(), notifier: notifier);
    expect(find.text('DISPUTE SUBMITTED'), findsOneWidget);
    expect(find.textContaining('DRP•••231'), findsOneWidget);
  });

  testWidgets('all PR11 screens fit a compact Android viewport', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(320, 568);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final states = <(Widget, DisputeState)>[
      (
        const ReportMatchScreen(match: _match),
        const DisputeState(phase: DisputeLoadPhase.drafting, match: _match),
      ),
      (
        const DisputeReasonScreen(),
        const DisputeState(phase: DisputeLoadPhase.drafting, match: _match),
      ),
      (
        const AddEvidenceScreen(),
        const DisputeState(
          phase: DisputeLoadPhase.drafting,
          match: _match,
          reason: DisputeReason.other,
        ),
      ),
      (
        const DisputeSubmittedScreen(),
        DisputeState(
          phase: DisputeLoadPhase.ready,
          match: _match,
          dispute: _case,
        ),
      ),
      (
        const DisputeStatusScreen(autoRefresh: false),
        DisputeState(
          phase: DisputeLoadPhase.ready,
          match: _match,
          dispute: _case,
        ),
      ),
    ];

    for (final (screen, state) in states) {
      await _pump(
        tester,
        screen,
        notifier: DisputeNotifier(_FakeGateway(result: _case), initial: state),
        textScaler: const TextScaler.linear(1.25),
      );
      expect(tester.takeException(), isNull, reason: '$screen');
    }
  });
}

GoRouter _router() => GoRouter(
  initialLocation: '/profile/report-match',
  routes: [
    GoRoute(
      path: '/profile/report-match',
      builder: (context, state) => const ReportMatchScreen(match: _match),
    ),
    GoRoute(
      path: '/profile/dispute-reason',
      builder: (context, state) => const DisputeReasonScreen(),
    ),
    GoRoute(
      path: '/profile/add-evidence',
      builder: (context, state) => const AddEvidenceScreen(),
    ),
    GoRoute(
      path: '/profile/dispute-submitted',
      builder: (context, state) => const DisputeSubmittedScreen(),
    ),
    GoRoute(
      path: '/profile/dispute-status',
      builder: (context, state) =>
          const DisputeStatusScreen(autoRefresh: false),
    ),
  ],
);

Future<void> _pump(
  WidgetTester tester,
  Widget screen, {
  required DisputeNotifier notifier,
  TextScaler textScaler = TextScaler.noScaling,
}) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [disputeProvider.overrideWith((ref) => notifier)],
      child: MaterialApp(
        theme: ThemeData.dark(),
        home: MediaQuery(
          data: MediaQueryData(textScaler: textScaler),
          child: screen,
        ),
      ),
    ),
  );
  await tester.pump();
}
