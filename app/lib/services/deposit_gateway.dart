import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/backend_contract.dart';
import '../models/deposit_flow.dart';
import 'api_client.dart';

class DepositGateway {
  DepositGateway(this._dio, {BackendContractConfig? contract})
    : contract = contract ?? BackendContractConfig.fromEnvironment();

  final Dio _dio;
  final BackendContractConfig contract;

  Future<DepositQuote?> createQuote(int amountMinorUnits) async {
    // The active backend does not expose a deposit quote/payment-method read.
    // Do not call the roadmap-only `/deposits/quote` endpoint or invent a
    // gateway list in Flutter. The notifier renders its unavailable state.
    return null;
  }

  Future<DepositIntentData?> createIntent({
    required DepositQuote quote,
    required DepositPaymentMethod method,
  }) async {
    final response = await _dio.post<dynamic>(
      contract.isV2 ? '/api/v1/deposits' : '/wallet/deposit-intent',
      data: contract.isV2
          ? {
              'amountMinor': quote.amountMinorUnits,
              'currency': quote.currency,
              'provider': method.id,
            }
          : {
              'amountMinorUnits': quote.amountMinorUnits,
              'gateway': method.id.toLowerCase(),
              'quoteId': quote.id,
              if (quote.idempotencyKey != null)
                'idempotencyKey': quote.idempotencyKey,
            },
      options: contract.isV2
          ? Options(
              headers: {
                'Idempotency-Key':
                    quote.idempotencyKey ?? 'deposit-${quote.id}',
              },
            )
          : null,
    );
    return DepositIntentData.tryFromServer(
      response.data,
      quote: quote,
      method: method,
      allowImplicitPending: true,
    );
  }

  Future<DepositIntentData?> fetchStatus(
    String reference, {
    DepositIntentData? previous,
  }) async {
    if (!contract.isV2) return null;
    final response = await _dio.get<dynamic>('/api/v1/deposits/$reference');
    return DepositIntentData.tryFromServer(response.data, previous: previous);
  }
}

final depositGatewayProvider = Provider<DepositGateway>(
  (ref) => DepositGateway(
    ref.watch(apiClientProvider),
    contract: ref.watch(backendContractProvider),
  ),
);
