import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:draughts_arena/config/backend_contract.dart';
import 'package:draughts_arena/models/deposit_flow.dart';
import 'package:draughts_arena/models/dispute.dart';
import 'package:draughts_arena/models/game_state.dart';
import 'package:draughts_arena/models/match_flow.dart';
import 'package:draughts_arena/models/withdrawal_flow.dart';
import 'package:draughts_arena/services/deposit_gateway.dart';
import 'package:draughts_arena/services/dispute_gateway.dart';
import 'package:draughts_arena/services/match_flow_gateway.dart';
import 'package:draughts_arena/services/settlement_gateway.dart';
import 'package:draughts_arena/services/socket_service.dart';
import 'package:draughts_arena/services/withdrawal_gateway.dart';
import 'package:draughts_arena/providers/auth_provider.dart';
import 'package:draughts_arena/services/api_client.dart';
import 'package:draughts_arena/screens/results_screen.dart';
import 'package:draughts_arena/services/secure_storage.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

const v2 = BackendContractConfig(BackendContractMode.v2);

class RecordingAdapter implements HttpClientAdapter {
  final requests = <RequestOptions>[];
  final _responses = <(int, Object)>[];

  void enqueue(Object response, {int status = 200}) =>
      _responses.add((status, response));

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requests.add(options);
    if (_responses.isEmpty) {
      throw StateError(
        'No response queued for ${options.method} ${options.path}',
      );
    }
    final (status, response) = _responses.removeAt(0);
    return ResponseBody.fromString(
      jsonEncode(response),
      status,
      headers: {
        Headers.contentTypeHeader: ['application/json'],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

(Dio, RecordingAdapter) client() {
  final adapter = RecordingAdapter();
  // The v2 contract keeps the versioned prefix on the base URL (the app's
  // .env ships BACKEND_URL=http://<host>:3000/api/v1); gateway paths stay
  // relative, so the wire request is baseUrl + path.
  final dio = Dio(BaseOptions(baseUrl: 'https://api.example.test/api/v1'));
  dio.httpClientAdapter = adapter;
  return (dio, adapter);
}

String wireUrl(RequestOptions request) => '${request.baseUrl}${request.path}';

/// Supplies a fixed signed-in id. [SecureStorageService] reads a platform
/// channel that never answers under `flutter test`, so the real one hangs.
class FixedSecureStorage extends SecureStorageService {
  FixedSecureStorage(this.userIdValue, {this.disputeRefs = const []});

  final String userIdValue;
  final List<DisputeCaseRef> disputeRefs;

  @override
  Future<String?> get userId async => userIdValue;

  DisputeCaseRef? savedRef;
  bool dropRefs = false;

  @override
  Future<List<DisputeCaseRef>> loadDisputeRefs() async =>
      dropRefs ? const [] : disputeRefs;

  @override
  Future<void> storeDisputeRef(DisputeCaseRef ref) async {
    savedRef = ref;
  }

  @override
  Future<void> saveDisputeRefs(List<DisputeCaseRef> refs) async {
    dropRefs = true;
  }
}

class _StubDisputeGateway implements DisputeGateway {
  _StubDisputeGateway({this.exists = true});

  final bool exists;

  @override
  bool get playerContractAvailable => true;

  @override
  bool get statusContractAvailable => true;

  @override
  Future<DisputeCaseData?> submit({
    required DisputeMatchSummary match,
    required DisputeReason reason,
    required String details,
  }) async => null;

  @override
  Future<DisputeCaseData?> fetchStatus({
    required String matchId,
    required String disputeId,
  }) async => null;

  @override
  Future<bool?> caseExists({
    required String matchId,
    required String disputeId,
  }) async => exists;
}

void main() {
  group('PR4 match V2 contract', () {
    test('uses the versioned lobby envelope and documented fields', () async {
      final (dio, adapter) = client();
      adapter.enqueue({
        'data': [
          {
            'id': 'mat_1',
            'status': 'OPEN',
            'stakeMinor': 200000,
            'currency': 'NGN',
            'timeControlSeconds': 600,
            'creator': {
              'id': 'usr_2',
              'username': 'KingMoves',
              'level': 'MASTER',
              'rating': 1780,
              'winRate': 58,
            },
          },
        ],
        'meta': {'requestId': 'req_1'},
      });

      final matches = await MatchFlowGateway(
        dio,
        contract: v2,
      ).loadOpenMatches();

      expect(
        wireUrl(adapter.requests.single),
        'https://api.example.test/api/v1/matches',
      );
      expect(matches.single.id, 'mat_1');
      expect(matches.single.terms.stakeMinorUnits, 200000);
      expect(matches.single.host.name, 'KingMoves');
      expect(matches.single.host.rank, 'MASTER');
      expect(matches.single.host.rating, 1780);
      expect(matches.single.host.winRate, 58);
    });

    test(
      'creates a match with an idempotency header and minor units',
      () async {
        final (dio, adapter) = client();
        adapter.enqueue({
          'data': {'id': 'mat_2', 'status': 'OPEN'},
        });
        final gateway = MatchFlowGateway(dio, contract: v2);

        final id = await gateway.createOpenMatch(
          const MatchTerms(
            stakeMinorUnits: 200000,
            timeControl: '10 minutes',
            gameType: 'Classic',
          ),
        );

        final request = adapter.requests.single;
        expect(id, 'mat_2');
        expect(wireUrl(request), 'https://api.example.test/api/v1/matches');
        expect(request.headers['Idempotency-Key'], isNotEmpty);
        expect(request.data, {
          'stakeMinor': 200000,
          'timeControlSeconds': 600,
          'ruleset': 'INTERNATIONAL_10X10',
          'visibility': 'PUBLIC',
        });
      },
    );

    test('retains searchId for the documented DELETE cancellation', () async {
      final (dio, adapter) = client();
      adapter
        ..enqueue({
          'data': {'searchId': 'mm_1', 'status': 'SEARCHING'},
        })
        ..enqueue({
          'data': {'cancelled': true},
        });
      final gateway = MatchFlowGateway(dio, contract: v2);
      const terms = MatchTerms(stakeMinorUnits: 100000);

      await gateway.joinQueue(terms);
      await gateway.leaveQueue(terms);

      expect(gateway.lastSearchId, isNull);
      expect(
        wireUrl(adapter.requests[0]),
        'https://api.example.test/api/v1/matchmaking/search',
      );
      expect(adapter.requests[1].method, 'DELETE');
      expect(
        wireUrl(adapter.requests[1]),
        'https://api.example.test/api/v1/matchmaking/search/mm_1',
      );
      expect(adapter.requests[1].headers['Idempotency-Key'], isNotEmpty);
    });
  });

  group('PR5 settlement V2 contract', () {
    testWidgets('history renders the server outcome and payout directly', (
      tester,
    ) async {
      final (dio, adapter) = client();
      adapter.enqueue({
        'data': [
          {
            'matchId': 'mat_1',
            'outcome': 'WON',
            'terminalReason': 'NORMAL_WIN',
            'stakeMinor': 200000,
            'payoutMinor': 360000,
            'settlementStatus': 'SETTLED',
          },
        ],
      });

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            apiClientProvider.overrideWithValue(dio),
            backendContractProvider.overrideWithValue(v2),
          ],
          child: const MaterialApp(home: ResultsScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(
        wireUrl(adapter.requests.single),
        'https://api.example.test/api/v1/me/matches',
      );
      expect(find.text('VICTORY'), findsOneWidget);
      expect(find.text('₦3,600'), findsOneWidget);
      expect(find.text('Payout'), findsOneWidget);
      expect(find.text('Winnings'), findsNothing);
    });

    testWidgets('history names the opponent through the player directory', (
      tester,
    ) async {
      final (dio, adapter) = client();
      adapter.enqueue({
        'data': [
          {
            'matchId': 'mat_1',
            'playerLightId': 'usr_me',
            'playerDarkId': 'usr_opp',
            'outcome': 'WON',
            'stakeMinor': 200000,
            'payoutMinor': 360000,
          },
        ],
      });
      adapter.enqueue({
        'data': {'player': {'id': 'usr_opp', 'username': 'dark_handle'}},
      });

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            apiClientProvider.overrideWithValue(dio),
            backendContractProvider.overrideWithValue(v2),
            secureStorageProvider.overrideWithValue(
              FixedSecureStorage('usr_me'),
            ),
          ],
          child: const MaterialApp(home: ResultsScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(
        wireUrl(adapter.requests.last),
        'https://api.example.test/api/v1/players/usr_opp',
      );
      expect(find.text('vs dark_handle'), findsOneWidget);
      expect(find.text('Opponent unavailable'), findsNothing);
    });

    testWidgets('a reported match row becomes a view-status entry', (
      tester,
    ) async {
      final (dio, adapter) = client();
      adapter.enqueue({
        'data': [
          {
            'matchId': 'mat_1',
            'playerLightId': 'usr_me',
            'playerDarkId': 'usr_opp',
            'outcome': 'LOST',
            'stakeMinor': 200000,
          },
        ],
      });
      adapter.enqueue({
        'data': {'player': {'id': 'usr_opp', 'username': 'dark_handle'}},
      });

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            apiClientProvider.overrideWithValue(dio),
            backendContractProvider.overrideWithValue(v2),
            secureStorageProvider.overrideWithValue(
              FixedSecureStorage(
                'usr_me',
                disputeRefs: const [
                  DisputeCaseRef(matchId: 'mat_1', disputeId: 'drp_1'),
                ],
              ),
            ),
            disputeGatewayProvider.overrideWithValue(_StubDisputeGateway()),
          ],
          child: const MaterialApp(home: ResultsScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Reported · View status'), findsOneWidget);
      final semantics = tester.ensureSemantics();
      expect(
        find.bySemanticsLabel(
          RegExp('View dispute status for match against dark_handle'),
        ),
        findsOneWidget,
      );
      semantics.dispose();
    });

    testWidgets('a cleared server case no longer leaves a reported row', (
      tester,
    ) async {
      final storage = FixedSecureStorage(
        'usr_me',
        disputeRefs: const [
          DisputeCaseRef(matchId: 'mat_1', disputeId: 'drp_1'),
        ],
      );
      final (dio, adapter) = client();
      adapter.enqueue({
        'data': [
          {
            'matchId': 'mat_1',
            'playerLightId': 'usr_me',
            'playerDarkId': 'usr_opp',
            'outcome': 'LOST',
            'stakeMinor': 200000,
          },
        ],
      });
      adapter.enqueue({
        'data': {'player': {'id': 'usr_opp', 'username': 'dark_handle'}},
      });

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            apiClientProvider.overrideWithValue(dio),
            backendContractProvider.overrideWithValue(v2),
            secureStorageProvider.overrideWithValue(storage),
            disputeGatewayProvider.overrideWithValue(
              _StubDisputeGateway(exists: false),
            ),
          ],
          child: const MaterialApp(home: ResultsScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Reported · View status'), findsNothing);
      expect(storage.dropRefs, isTrue);
    });

    test('reads the immutable receipt without deriving the winner', () async {
      final (dio, adapter) = client();
      adapter.enqueue({
        'data': {
          'matchId': 'mat_1',
          'result': {'winnerId': 'usr_1', 'reason': 'NORMAL_WIN'},
          'money': {
            'stakeEachMinor': 200000,
            'grossPotMinor': 400000,
            'feeMinor': 40000,
            'winnerPayoutMinor': 360000,
          },
          'settledAt': '2026-09-04T14:35:00Z',
        },
      });

      final receipt = await SettlementGateway(dio, v2).fetchReceipt('mat_1');

      expect(
        wireUrl(adapter.requests.single),
        'https://api.example.test/api/v1/matches/mat_1/receipt',
      );
      expect(receipt, isNotNull);
      expect(receipt!.result, isNull);
      expect(receipt.opponent, isNull);
      expect(receipt.terms!.platformFeeMinorUnits, 40000);
      expect(receipt.payoutMinorUnits, 360000);
    });
  });

  group('PR6 deposit V2 contract', () {
    test('quotes, opens checkout and polls only by server reference', () async {
      final (dio, adapter) = client();
      adapter
        // The server owns the fee, total and gateway list.
        ..enqueue({
          'quote': {
            'id': 'quote_1',
            'amountMinorUnits': '500000',
            'feeMinorUnits': '0',
            'totalMinorUnits': '500000',
            'currency': 'NGN',
            'paymentMethods': [
              {'id': 'paystack', 'label': 'Paystack', 'feeMinorUnits': '0'},
            ],
            'idempotencyKey': 'deposit-quote-1700000000000-abc123',
          },
        })
        ..enqueue({
          'authorizationUrl': 'https://pay.example/authorize/private',
          'reference': 'paystack-server-reference',
        })
        ..enqueue({
          'deposit': {
            'id': 'dep_1',
            'status': 'COMPLETED',
            'reference': 'paystack-server-reference',
            'amountMinorUnits': '500000',
            'currency': 'NGN',
          },
        });
      final gateway = DepositGateway(dio, contract: v2);

      final quote = await gateway.createQuote(500000);
      final intent = await gateway.createIntent(
        quote: quote!,
        method: quote.paymentMethods.single,
      );
      final confirmed = await gateway.fetchStatus(
        intent!.reference,
        previous: intent,
      );

      expect(quote.totalMinorUnits, 500000);
      // A replayed checkout must reuse the quote's operation key so it resolves
      // to the same intent instead of opening a second checkout.
      expect(
        adapter.requests[0].headers['Idempotency-Key'],
        startsWith('deposit-quote-'),
      );
      // Checkout is opened on the route the server actually serves, carrying
      // the quote so the server re-validates the exact quoted amount.
      expect(
        wireUrl(adapter.requests[1]),
        'https://api.example.test/api/v1/wallet/deposit-intent',
      );
      expect(adapter.requests[1].data, {
        'amountMinorUnits': '500000',
        'gateway': 'paystack',
        'quoteId': 'quote_1',
      });
      expect(
        adapter.requests[1].headers['Idempotency-Key'],
        'deposit-quote-1700000000000-abc123',
      );
      expect(intent.reference, 'paystack-server-reference');
      expect(intent.reference, isNot(contains('provider-secret')));
      // Status is read back from the server; a checkout return is never proof
      // of payment on its own.
      expect(
        wireUrl(adapter.requests[2]),
        'https://api.example.test/api/v1/deposits/paystack-server-reference',
      );
      expect(confirmed!.status, DepositStatus.successful);
    });
  });

  group('PR7 withdrawal V2 contract', () {
    test('uses server bank accounts and withdrawal identifiers', () async {
      final (dio, adapter) = client();
      adapter
        ..enqueue({
          'data': [
            {
              'id': 'bank_1',
              'bankName': 'Example Bank',
              'accountName': 'W. E.',
              'maskedAccountNumber': '******1234',
              'verified': true,
            },
          ],
        })
        ..enqueue({
          'data': {
            'id': 'wd_1',
            'reference': 'wit_9f2c',
            'status': 'PENDING_REVIEW',
            'amountMinorUnits': '2000000',
            'currency': 'NGN',
            'bankAccountId': 'bank_1',
          },
        })
        ..enqueue({
          'data': {
            'id': 'wd_1',
            'reference': 'wit_9f2c',
            'status': 'COMPLETED',
            'amountMinorUnits': '2000000',
            'currency': 'NGN',
            'bankAccountId': 'bank_1',
          },
        });
      final gateway = WithdrawalGateway(dio, contract: v2);
      final accounts = await gateway.fetchBankAccounts();
      final account = accounts!.single;
      const intent = WithdrawalIntent(
        amountMinorUnits: 2000000,
        currency: 'NGN',
        eligibility: WithdrawalEligibility.eligible,
      );

      final withdrawal = await gateway.createWithdrawal(
        intent: intent,
        bankAccount: account,
        idempotencyKey: 'withdrawal-key-1',
      );
      // Status must be read by row id. The reference is display-only, and using
      // it here is exactly what made every poll 404 in PR7.
      final confirmed = await gateway.fetchStatus(
        withdrawal!.id,
        previous: withdrawal,
      );

      expect(account.maskedAccountNumber, '******1234');
      expect(
        wireUrl(adapter.requests[1]),
        'https://api.example.test/api/v1/withdrawals',
      );
      // The backend reads amountMinorUnits on every money route; sending the
      // one-off amountMinor would silently create an invalid-amount failure.
      expect(
        Map<String, dynamic>.from(adapter.requests[1].data as Map),
        containsPair('amountMinorUnits', 2000000),
      );
      expect(adapter.requests[1].data as Map, isNot(contains('amountMinor')));
      expect(
        adapter.requests[1].headers['Idempotency-Key'],
        'withdrawal-key-1',
      );
      expect(
        wireUrl(adapter.requests[2]),
        'https://api.example.test/api/v1/withdrawals/wd_1',
      );
      expect(confirmed!.status, WithdrawalStatus.successful);
      expect(confirmed.reference, 'wit_9f2c');
      // A refused payout is NOT a release: funds stay reserved.
      expect(WithdrawalStatus.payoutFailed.isTerminal, isFalse);
      expect(WithdrawalStatus.reversed.isTerminal, isTrue);
    });

    test(
      'reads the §4 eligibility gate instead of inventing a quote',
      () async {
        final (dio, adapter) = client();
        adapter.enqueue({
          'allowed': false,
          'error': {'code': 'KycRequiredError', 'message': 'Verify first'},
          'status': 403,
        });
        final report = await WithdrawalGateway(
          dio,
          contract: v2,
        ).fetchEligibility(2000000);
        expect(wireUrl(adapter.requests.single), contains('/me/eligibility'));
        expect(report!.outcome, WithdrawalEligibility.verificationRequired);
        expect(report.message, 'Verify first');
      },
    );
  });

  group('PR8 realtime V2 contract', () {
    test('selects V2 mode explicitly', () {
      expect(SocketService(contract: v2).isV2, isTrue);
    });

    test('rejects unresolved server-defined board encoding', () {
      expect(
        () => GameState.fromJson({
          'matchId': 'mat_1',
          'status': 'IN_PLAY',
          'stateVersion': 28,
          'board': {
            'encoding': 'server-defined-v1',
            'pieces': [
              {'square': 31, 'side': 'WHITE', 'kind': 'MAN'},
            ],
          },
          'sideToMove': 'WHITE',
          'participants': [
            {'userId': 'usr_1', 'side': 'WHITE'},
            {'userId': 'usr_2', 'side': 'BLACK'},
          ],
        }),
        throwsA(anything),
      );
    });
  });

  group('PR11 dispute V2 contract', () {
    final match = DisputeMatchSummary(matchId: 'mat_9', opponentName: 'Otto');

    test(
      'submits on the documented player route with an idempotency key',
      () async {
        final (dio, adapter) = client();
        // The backend answers 201 with a flat body and no timestamps.
        adapter.enqueue({
          'disputeId': 'd3f1a2b4-5678-4cde-9012-3456789abcde',
          'status': 'OPEN',
          'matchId': 'mat_9',
          'category': 'SUSPECTED_CHEATING',
        });

        final submitted = await BackendDisputeGateway(dio).submit(
          match: match,
          reason: DisputeReason.suspectedCheating,
          details: 'They used an engine.',
        );

        final request = adapter.requests.single;
        expect(request.method, 'POST');
        expect(
          wireUrl(request),
          'https://api.example.test/api/v1/matches/mat_9/disputes',
        );
        final idempotencyKey = request.headers['Idempotency-Key']?.toString();
        expect(idempotencyKey, matches(RegExp(r'^[A-Za-z0-9._:-]{8,128}$')));
        expect(request.data, {
          'category': 'SUSPECTED_CHEATING',
          'message': 'They used an engine.',
        });
        expect(submitted?.id, 'd3f1a2b4-5678-4cde-9012-3456789abcde');
        expect(submitted?.status, DisputeStatus.open);
        expect(submitted?.matchId, 'mat_9');
      },
    );

    test(
      'sends the reason label as the message when details are blank',
      () async {
        final (dio, adapter) = client();
        adapter.enqueue({
          'disputeId': 'd3f1a2b4-5678-4cde-9012-3456789abcde',
          'status': 'OPEN',
          'matchId': 'mat_9',
          'category': 'SUSPECTED_CHEATING',
        });

        await BackendDisputeGateway(dio).submit(
          match: match,
          reason: DisputeReason.suspectedCheating,
          details: '   ',
        );

        expect(adapter.requests.single.data, {
          'category': 'SUSPECTED_CHEATING',
          'message': 'Suspected cheating',
        });
      },
    );

    test(
      'surfaces the backend rejection code as a player-facing message',
      () async {
        final (dio, adapter) = client();
        adapter.enqueue({
          'error': {
            'code': 'DISPUTE_WINDOW_EXPIRED',
            'message': 'Reporting window closed',
          },
          'status': 409,
        }, status: 409);

        await expectLater(
          BackendDisputeGateway(dio).submit(
            match: match,
            reason: DisputeReason.incorrectResult,
            details: 'Score was wrong.',
          ),
          throwsA(
            isA<DisputeContractError>().having(
              (error) => error.message,
              'message',
              'The reporting window for this match has closed.',
            ),
          ),
        );
      },
    );

    test(
      'reads the participant status back on the documented route',
      () async {
        final (dio, adapter) = client();
        adapter.enqueue({
          'dispute': {
            'id': 'd3f1a2b4-5678-4cde-9012-3456789abcde',
            'matchId': 'mat_9',
            'status': 'UNDER_REVIEW',
            'reason': 'They used an engine.',
            'category': 'SUSPECTED_CHEATING',
            'resolution': null,
            'createdAt': '2026-09-28T20:03:00.000Z',
            'updatedAt': '2026-09-28T22:17:00.000Z',
          },
        });

        final seen = await BackendDisputeGateway(dio).fetchStatus(
          matchId: 'mat_9',
          disputeId: 'd3f1a2b4-5678-4cde-9012-3456789abcde',
        );

        final request = adapter.requests.single;
        expect(request.method, 'GET');
        expect(
          wireUrl(request),
          'https://api.example.test/api/v1/matches/mat_9'
          '/disputes/d3f1a2b4-5678-4cde-9012-3456789abcde',
        );
        expect(seen?.id, 'd3f1a2b4-5678-4cde-9012-3456789abcde');
        expect(seen?.matchId, 'mat_9');
        expect(seen?.status, DisputeStatus.underReview);
        expect(seen?.reason, 'They used an engine.');
        expect(seen?.createdAt, DateTime.utc(2026, 9, 28, 20, 3));
        expect(seen?.updatedAt, DateTime.utc(2026, 9, 28, 22, 17));
      },
    );
  });
}
