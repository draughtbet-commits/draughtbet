import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:draughts_arena/config/backend_contract.dart';
import 'package:draughts_arena/models/deposit_flow.dart';
import 'package:draughts_arena/models/game_state.dart';
import 'package:draughts_arena/models/match_flow.dart';
import 'package:draughts_arena/models/withdrawal_flow.dart';
import 'package:draughts_arena/services/deposit_gateway.dart';
import 'package:draughts_arena/services/match_flow_gateway.dart';
import 'package:draughts_arena/services/settlement_gateway.dart';
import 'package:draughts_arena/services/socket_service.dart';
import 'package:draughts_arena/services/withdrawal_gateway.dart';
import 'package:draughts_arena/services/api_client.dart';
import 'package:draughts_arena/screens/results_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

const v2 = BackendContractConfig(BackendContractMode.v2);

class RecordingAdapter implements HttpClientAdapter {
  final requests = <RequestOptions>[];
  final _responses = <Object>[];

  void enqueue(Object response) => _responses.add(response);

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
    return ResponseBody.fromString(
      jsonEncode(_responses.removeAt(0)),
      200,
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
  final dio = Dio(BaseOptions(baseUrl: 'https://api.example.test'));
  dio.httpClientAdapter = adapter;
  return (dio, adapter);
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
            },
          },
        ],
        'meta': {'requestId': 'req_1'},
      });

      final matches = await MatchFlowGateway(
        dio,
        contract: v2,
      ).loadOpenMatches();

      expect(adapter.requests.single.path, '/api/v1/matches');
      expect(matches.single.id, 'mat_1');
      expect(matches.single.terms.stakeMinorUnits, 200000);
      expect(matches.single.host.name, 'KingMoves');
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
        expect(request.path, '/api/v1/matches');
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
      expect(adapter.requests[0].path, '/api/v1/matchmaking/search');
      expect(adapter.requests[1].method, 'DELETE');
      expect(adapter.requests[1].path, '/api/v1/matchmaking/search/mm_1');
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

      expect(adapter.requests.single.path, '/api/v1/me/matches');
      expect(find.text('VICTORY'), findsOneWidget);
      expect(find.text('₦3,600'), findsOneWidget);
      expect(find.text('Payout'), findsOneWidget);
      expect(find.text('Winnings'), findsNothing);
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

      expect(adapter.requests.single.path, '/api/v1/matches/mat_1/receipt');
      expect(receipt, isNotNull);
      expect(receipt!.result, isNull);
      expect(receipt.opponent, isNull);
      expect(receipt.terms!.platformFeeMinorUnits, 40000);
      expect(receipt.payoutMinorUnits, 360000);
    });
  });

  group('PR6 deposit V2 contract', () {
    test('creates checkout and polls only by server depositId', () async {
      final (dio, adapter) = client();
      adapter
        ..enqueue({
          'data': {
            'depositId': 'dep_1',
            'status': 'PENDING',
            'checkout': {
              'authorizationUrl': 'https://pay.example/authorize/private',
              'reference': 'provider-secret-reference',
            },
          },
        })
        ..enqueue({
          'data': {
            'depositId': 'dep_1',
            'status': 'CONFIRMED',
            'amountMinor': 500000,
          },
        });
      final gateway = DepositGateway(dio, contract: v2);
      const quote = DepositQuote(
        id: 'quote_1',
        amountMinorUnits: 500000,
        currency: 'NGN',
        paymentMethods: [],
        idempotencyKey: 'deposit-key-1',
      );
      const method = DepositPaymentMethod(id: 'PAYSTACK', label: 'Card');

      final intent = await gateway.createIntent(quote: quote, method: method);
      final confirmed = await gateway.fetchStatus(
        intent!.reference,
        previous: intent,
      );

      expect(intent.reference, 'dep_1');
      expect(intent.reference, isNot(contains('provider-secret')));
      expect(adapter.requests[0].path, '/api/v1/deposits');
      expect(adapter.requests[0].headers['Idempotency-Key'], 'deposit-key-1');
      expect(adapter.requests[1].path, '/api/v1/deposits/dep_1');
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
              'maskedAccount': '******1234',
              'verified': true,
            },
          ],
        })
        ..enqueue({
          'data': {
            'withdrawalId': 'wd_1',
            'status': 'UNDER_REVIEW',
            'amountMinor': 2000000,
          },
        })
        ..enqueue({
          'data': {
            'withdrawalId': 'wd_1',
            'status': 'CONFIRMED',
            'amountMinor': 2000000,
          },
        });
      final gateway = WithdrawalGateway(dio, contract: v2);
      final accounts = await gateway.fetchBankAccounts();
      final account = accounts!.single;
      const quote = WithdrawalQuote(
        id: 'quote_1',
        amountMinorUnits: 2000000,
        currency: 'NGN',
        eligibility: WithdrawalEligibility.eligible,
        idempotencyKey: 'withdrawal-key-1',
      );

      final withdrawal = await gateway.createWithdrawal(
        quote: quote,
        bankAccount: account,
      );
      final confirmed = await gateway.fetchStatus(
        withdrawal!.reference,
        previous: withdrawal,
      );

      expect(account.maskedAccountNumber, '******1234');
      expect(adapter.requests[1].path, '/api/v1/withdrawals');
      expect(
        adapter.requests[1].headers['Idempotency-Key'],
        'withdrawal-key-1',
      );
      expect(adapter.requests[2].path, '/api/v1/withdrawals/wd_1');
      expect(confirmed!.status, WithdrawalStatus.successful);
    });

    test(
      'does not fabricate a quote absent from the frozen contract',
      () async {
        final (dio, _) = client();
        expect(
          await WithdrawalGateway(dio, contract: v2).createQuote(2000000),
          isNull,
        );
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
}
