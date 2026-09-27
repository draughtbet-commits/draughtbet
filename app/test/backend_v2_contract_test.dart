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
    (Dio, RecordingAdapter) v1Client() {
      final adapter = RecordingAdapter();
      final dio = Dio(BaseOptions(baseUrl: 'https://api.example.test/api/v1'));
      dio.httpClientAdapter = adapter;
      return (dio, adapter);
    }

    Map<String, dynamic> bankAccount({bool isDefault = true}) => {
      'id': 'bank_1',
      'gateway': 'PAYSTACK',
      'bankCode': '011',
      'bankName': 'Example Bank',
      'accountNumber': '0123451234',
      'accountName': 'W. E.',
      'isDefault': isDefault,
      'verifiedAt': '2026-09-18T12:00:00Z',
      'createdAt': '2026-09-18T12:00:00Z',
    };

    test('uses mounted wallet routes, payloads, and wrappers', () async {
      final (dio, adapter) = v1Client();
      adapter
        ..enqueue({
          'bankAccounts': [bankAccount()],
        })
        ..enqueue({
          'withdrawalRequest': {
            'id': 'wd_1',
            'reference': 'wit_1',
            'status': 'PENDING_REVIEW',
            'amountMinorUnits': '2000000',
            'currency': 'NGN',
            'gateway': 'PAYSTACK',
            'bankAccountId': 'bank_1',
          },
        })
        ..enqueue({
          'withdrawals': [
            {
              'id': 'wd_1',
              'reference': 'wit_1',
              'status': 'COMPLETED',
              'amountMinorUnits': '2000000',
              'currency': 'NGN',
              'gateway': 'PAYSTACK',
              'bankAccountId': 'bank_1',
            },
          ],
          'total': 1,
        });
      final gateway = WithdrawalGateway(dio, contract: v2);
      final accounts = await gateway.fetchBankAccounts();
      final account = accounts!.single;
      const quote = WithdrawalQuote(
        id: 'quote_1',
        amountMinorUnits: 2000000,
        currency: 'NGN',
        eligibility: WithdrawalEligibility.eligible,
        availableBalanceMinorUnits: 3000000,
        feeMinorUnits: 0,
        netAmountMinorUnits: 2000000,
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

      expect(account.maskedAccountNumber, '••••1234');
      expect(adapter.requests[0].path, '/wallet/bank-accounts');
      expect(adapter.requests[0].uri.path, '/api/v1/wallet/bank-accounts');
      expect(adapter.requests[1].path, '/wallet/withdrawal-request');
      expect(adapter.requests[1].uri.path, '/api/v1/wallet/withdrawal-request');
      expect(adapter.requests[1].data, {
        'amountMinorUnits': 2000000,
        'idempotencyKey': 'withdrawal-key-1',
      });
      expect(adapter.requests[2].path, '/wallet/withdrawals');
      expect(adapter.requests[2].uri.path, '/api/v1/wallet/withdrawals');
      expect(adapter.requests[2].queryParameters, {'page': 1, 'limit': 100});
      expect(confirmed!.status, WithdrawalStatus.successful);
    });

    test('creates a bank account with the exact controller payload', () async {
      final (dio, adapter) = v1Client();
      adapter.enqueue({'bankAccount': bankAccount()});

      final account = await WithdrawalGateway(dio, contract: v2)
          .createBankAccount(
            gateway: 'PAYSTACK',
            bankCode: '011',
            bankName: 'Example Bank',
            accountNumber: '0123451234',
          );

      expect(account?.id, 'bank_1');
      expect(adapter.requests.single.uri.path, '/api/v1/wallet/bank-accounts');
      expect(adapter.requests.single.data, {
        'gateway': 'paystack',
        'bankCode': '011',
        'bankName': 'Example Bank',
        'accountNumber': '0123451234',
      });
    });

    test('sets and confirms the authoritative default destination', () async {
      final (dio, adapter) = v1Client();
      adapter.enqueue({'bankAccount': bankAccount()});
      final account = WithdrawalBankAccount.tryFromServer(bankAccount())!;

      final confirmed = await WithdrawalGateway(
        dio,
        contract: v2,
      ).setDefaultBankAccount(account);

      expect(confirmed?.isDefault, isTrue);
      expect(
        adapter.requests.single.uri.path,
        '/api/v1/wallet/bank-accounts/bank_1/default',
      );
      expect(adapter.requests.single.method, 'PATCH');
    });

    test(
      'requires withdrawalRequest and bankAccount object wrappers',
      () async {
        final account = WithdrawalBankAccount.tryFromServer(bankAccount())!;
        const quote = WithdrawalQuote(
          id: 'quote_1',
          amountMinorUnits: 2000000,
          currency: 'NGN',
          eligibility: WithdrawalEligibility.eligible,
          availableBalanceMinorUnits: 3000000,
          feeMinorUnits: 0,
          netAmountMinorUnits: 2000000,
          idempotencyKey: 'withdrawal-key-1',
        );
        for (final response in <Object>[
          <String, dynamic>{},
          <String, dynamic>{'withdrawalRequest': null},
          <String, dynamic>{'withdrawalRequest': 'invalid'},
          <String, dynamic>{
            'withdrawalRequest': <String, dynamic>{'id': 'incomplete'},
          },
        ]) {
          final (dio, adapter) = v1Client();
          adapter.enqueue(response);
          await expectLater(
            WithdrawalGateway(
              dio,
              contract: v2,
            ).createWithdrawal(quote: quote, bankAccount: account),
            throwsA(isA<WithdrawalContractException>()),
          );
        }

        for (final response in <Object>[
          <String, dynamic>{},
          <String, dynamic>{'bankAccount': null},
          <String, dynamic>{'bankAccount': 'invalid'},
        ]) {
          final (dio, adapter) = v1Client();
          adapter.enqueue(response);
          await expectLater(
            WithdrawalGateway(dio, contract: v2).createBankAccount(
              gateway: 'paystack',
              bankCode: '011',
              bankName: 'Example Bank',
              accountNumber: '0123451234',
            ),
            throwsA(isA<WithdrawalContractException>()),
          );
        }
      },
    );

    test('status recovery requires the withdrawals list wrapper', () async {
      for (final response in <Object>[
        <String, dynamic>{'total': 0},
        <String, dynamic>{'withdrawals': null, 'total': 0},
        <String, dynamic>{'withdrawals': 'invalid', 'total': 0},
      ]) {
        final (dio, adapter) = v1Client();
        adapter.enqueue(response);
        await expectLater(
          WithdrawalGateway(dio, contract: v2).fetchStatus('wit_1'),
          throwsA(isA<WithdrawalContractException>()),
        );
      }
    });

    test(
      'rejects a withdrawal destination different from the reviewed default',
      () async {
        final (dio, adapter) = v1Client();
        adapter.enqueue({
          'withdrawalRequest': {
            'id': 'wd_1',
            'reference': 'wit_1',
            'status': 'PENDING_REVIEW',
            'amountMinorUnits': '2000000',
            'currency': 'NGN',
            'gateway': 'PAYSTACK',
            'bankAccountId': 'bank_2',
          },
        });
        final account = WithdrawalBankAccount.tryFromServer(bankAccount())!;
        const quote = WithdrawalQuote(
          id: 'quote_1',
          amountMinorUnits: 2000000,
          currency: 'NGN',
          eligibility: WithdrawalEligibility.eligible,
          availableBalanceMinorUnits: 3000000,
          feeMinorUnits: 0,
          netAmountMinorUnits: 2000000,
          idempotencyKey: 'withdrawal-key-1',
        );

        await expectLater(
          WithdrawalGateway(
            dio,
            contract: v2,
          ).createWithdrawal(quote: quote, bankAccount: account),
          throwsA(
            isA<WithdrawalContractException>().having(
              (error) => error.code,
              'code',
              'destination_mismatch',
            ),
          ),
        );
      },
    );

    test('rejects missing, null, and malformed response wrappers', () async {
      for (final response in <Object>[
        <String, dynamic>{},
        <String, dynamic>{'bankAccounts': null},
        <String, dynamic>{'bankAccounts': 'invalid'},
        <String, dynamic>{
          'bankAccounts': [
            <String, dynamic>{'id': 'incomplete'},
          ],
        },
      ]) {
        final (dio, adapter) = v1Client();
        adapter.enqueue(response);
        expect(
          () => WithdrawalGateway(dio, contract: v2).fetchBankAccounts(),
          throwsA(isA<WithdrawalContractException>()),
        );
      }
    });

    test('accepts empty wrappers and unknown additive fields', () async {
      final (emptyDio, emptyAdapter) = v1Client();
      emptyAdapter.enqueue({'bankAccounts': <Object>[], 'future': true});
      expect(
        await WithdrawalGateway(emptyDio, contract: v2).fetchBankAccounts(),
        isEmpty,
      );

      final (dio, adapter) = v1Client();
      adapter.enqueue({
        'bankAccounts': [bankAccount()..['futureField'] = 'ignored'],
        'future': true,
      });
      expect(
        (await WithdrawalGateway(
          dio,
          contract: v2,
        ).fetchBankAccounts())?.single.id,
        'bank_1',
      );
    });

    test(
      'does not fabricate a quote absent from the frozen contract',
      () async {
        final (dio, _) = v1Client();
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
