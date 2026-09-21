import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/deposit_flow.dart';
import 'api_client.dart';

class DepositGateway {
  DepositGateway(this._dio);

  final Dio _dio;

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
      '/wallet/deposit-intent',
      data: {
        'amountMinorUnits': quote.amountMinorUnits,
        'gateway': method.id.toLowerCase(),
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
    // Deposit completion is currently delivered only through the webhook and
    // wallet projection. There is no authenticated deposit-status read route,
    // so a provider return must remain pending rather than imply success.
    return null;
  }
}

final depositGatewayProvider = Provider<DepositGateway>(
  (ref) => DepositGateway(ref.watch(apiClientProvider)),
);
