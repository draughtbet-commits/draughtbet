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

  // The deposit routes below are served unconditionally by the backend, so they
  // are called in both contract modes. `contract` still selects the V2-only
  // behaviour elsewhere; gating these reads on it would leave deposits
  // unusable in the default mode while the server is plainly ready.

  /// Asks the server what a deposit costs. The fee, total, currency and the set
  /// of available gateways are all decided server-side and must never be
  /// inferred on the client.
  Future<DepositQuote?> createQuote(int amountMinorUnits) async {
    final response = await _dio.post<dynamic>(
      '/wallet/deposit-quote',
      data: {'amountMinorUnits': amountMinorUnits.toString()},
      options: Options(
        headers: {'Idempotency-Key': ClientRequestId.create('deposit-quote')},
      ),
    );
    return DepositQuote.tryFromServer(response.data);
  }

  /// Opens hosted checkout against a quote. The gateway id is sent lowercase
  /// because that is the only form the server accepts, and the quote id travels
  /// with it so the server re-validates and consumes that exact quote — the
  /// amount can never drift from the fee the player was shown.
  Future<DepositIntentData?> createIntent({
    required DepositQuote quote,
    required DepositPaymentMethod method,
  }) async {
    final response = await _dio.post<dynamic>(
      '/wallet/deposit-intent',
      data: {
        'amountMinorUnits': quote.amountMinorUnits.toString(),
        'gateway': method.id.toLowerCase(),
        'quoteId': quote.id,
      },
      options: Options(
        headers: {
          'Idempotency-Key': quote.idempotencyKey ?? 'deposit-${quote.id}',
        },
      ),
    );
    return DepositIntentData.tryFromServer(
      response.data,
      quote: quote,
      method: method,
      allowImplicitPending: true,
    );
  }

  /// Reads deposit status back from the server. A hosted-checkout return is
  /// never proof of payment on its own, so completion is only ever believed
  /// when the server says so. The server resolves the provider reference as
  /// well as the internal id, which is the only identifier the client holds.
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
  (ref) => DepositGateway(
    ref.watch(apiClientProvider),
    contract: ref.watch(backendContractProvider),
  ),
);
