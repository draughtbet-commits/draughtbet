import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/backend_contract.dart';
import '../models/withdrawal_flow.dart';
import 'api_client.dart';

class WithdrawalGateway {
  WithdrawalGateway(Dio dio, {BackendContractConfig? contract})
    : _dio = dio,
      contract = contract ?? BackendContractConfig.fromEnvironment();

  final Dio _dio;
  final BackendContractConfig contract;

  Future<WithdrawalQuote?> createQuote(int amountMinorUnits) async {
    // V2 deliberately defines no quote/eligibility read. Fees, limits and net
    // amount are server-owned, so the approved review UI remains unavailable
    // until that read contract exists.
    return null;
  }

  Future<List<WithdrawalBankAccount>?> fetchBankAccounts() async {
    if (!contract.isV2) return null;
    final response = await _dio.get<dynamic>('/api/v1/me/bank-accounts');
    final values = unwrapDataList(response.data);
    if (values == null) return null;
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
    if (!contract.isV2) return null;
    final response = await _dio.post<dynamic>(
      '/api/v1/me/bank-accounts',
      data: {'bankCode': bankCode, 'accountNumber': accountNumber},
      options: Options(
        headers: {
          'Idempotency-Key':
              idempotencyKey ?? ClientRequestId.create('bank-account'),
        },
      ),
    );
    final data = unwrapData(response.data);
    if (data == null || data['verified'] != true) return null;
    return WithdrawalBankAccount.tryFromServer({
      ...data,
      'bankCode': bankCode,
      'bankName': bankName,
      'accountNumber': accountNumber,
    });
  }

  Future<WithdrawalData?> createWithdrawal({
    required WithdrawalQuote quote,
    required WithdrawalBankAccount bankAccount,
  }) async {
    if (!contract.isV2) return null;
    final response = await _dio.post<dynamic>(
      '/api/v1/withdrawals',
      data: {
        'amountMinor': quote.amountMinorUnits,
        'bankAccountId': bankAccount.id,
      },
      options: Options(
        headers: {
          'Idempotency-Key': quote.idempotencyKey ?? 'withdrawal-${quote.id}',
        },
      ),
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
    if (!contract.isV2) return null;
    final response = await _dio.get<dynamic>('/api/v1/withdrawals/$reference');
    return WithdrawalData.tryFromServer(response.data, previous: previous);
  }
}

final withdrawalGatewayProvider = Provider<WithdrawalGateway>(
  (ref) => WithdrawalGateway(
    ref.watch(apiClientProvider),
    contract: ref.watch(backendContractProvider),
  ),
);
