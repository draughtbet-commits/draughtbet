import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/withdrawal_flow.dart';
import 'api_client.dart';

class WithdrawalGateway {
  WithdrawalGateway(this._dio);

  final Dio _dio;

  Future<WithdrawalQuote?> createQuote(int amountMinorUnits) async {
    final response = await _dio.post<dynamic>(
      '/withdrawals/quote',
      data: {'amountMinorUnits': amountMinorUnits},
    );
    return WithdrawalQuote.tryFromServer(response.data);
  }

  Future<List<WithdrawalBankAccount>?> fetchBankAccounts() async {
    final response = await _dio.get<dynamic>('/bank-accounts');
    final data = response.data;
    final values = data is List
        ? data
        : data is Map
        ? data['bankAccounts'] ?? data['accounts'] ?? data['data']
        : null;
    if (values is! List) return null;
    return values
        .map(WithdrawalBankAccount.tryFromServer)
        .whereType<WithdrawalBankAccount>()
        .toList(growable: false);
  }

  Future<WithdrawalBankAccount?> verifyBankAccount({
    required String bankCode,
    required String bankName,
    required String accountNumber,
    String? idempotencyKey,
  }) async {
    final response = await _dio.post<dynamic>(
      '/bank-accounts/verify',
      data: {
        'bankCode': bankCode,
        'bankName': bankName,
        'accountNumber': accountNumber,
        'idempotencyKey': ?idempotencyKey,
      },
    );
    final data = response.data;
    final raw = data is Map && data['bankAccount'] is Map
        ? data['bankAccount']
        : data;
    if (raw is! Map) return null;
    final verified =
        raw['verified'] == true ||
        raw['status']?.toString().toUpperCase() == 'VERIFIED' ||
        raw['verifiedAt'] != null;
    return verified ? WithdrawalBankAccount.tryFromServer(raw) : null;
  }

  Future<WithdrawalData?> createWithdrawal({
    required WithdrawalQuote quote,
    required WithdrawalBankAccount bankAccount,
  }) async {
    final response = await _dio.post<dynamic>(
      '/withdrawals',
      data: {
        'quoteId': quote.id,
        'bankAccountId': bankAccount.id,
        if (quote.idempotencyKey != null)
          'idempotencyKey': quote.idempotencyKey,
      },
    );
    return WithdrawalData.tryFromServer(
      response.data,
      quote: quote,
      bankAccount: bankAccount,
    );
  }

  Future<WithdrawalData?> fetchStatus(
    String reference, {
    WithdrawalData? previous,
  }) async {
    final response = await _dio.get<dynamic>(
      '/withdrawals/${Uri.encodeComponent(reference)}',
    );
    return WithdrawalData.tryFromServer(response.data, previous: previous);
  }
}

final withdrawalGatewayProvider = Provider<WithdrawalGateway>(
  (ref) => WithdrawalGateway(ref.watch(apiClientProvider)),
);
