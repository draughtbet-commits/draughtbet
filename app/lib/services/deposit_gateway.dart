import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/deposit_flow.dart';
import 'api_client.dart';

class DepositGateway {
  DepositGateway(this._dio);

  final Dio _dio;

  Future<DepositQuote?> createQuote(int amountMinorUnits) async {
    final response = await _dio.post<dynamic>(
      '/deposits/quote',
      data: {'amountMinorUnits': amountMinorUnits},
    );
    return DepositQuote.tryFromServer(response.data);
  }

  Future<DepositIntentData?> createIntent({
    required DepositQuote quote,
    required DepositPaymentMethod method,
  }) async {
    final response = await _dio.post<dynamic>(
      '/wallet/deposit-intent',
      data: {
        'amountMinorUnits': quote.amountMinorUnits,
        'gateway': method.id,
        'quoteId': quote.id,
        if (quote.idempotencyKey != null)
          'idempotencyKey': quote.idempotencyKey,
      },
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
    final response = await _dio.get<dynamic>(
      '/deposits/${Uri.encodeComponent(reference)}',
    );
    return DepositIntentData.tryFromServer(response.data, previous: previous);
  }
}

final depositGatewayProvider = Provider<DepositGateway>(
  (ref) => DepositGateway(ref.watch(apiClientProvider)),
);
