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

  /// Contract §4 GET /me/eligibility — the pre-flight gate for a withdrawal.
  /// This is the only server-authoritative "can I withdraw?" read in the
  /// contract; there is no withdrawal quote endpoint.
  Future<WithdrawalEligibilityReport?> fetchEligibility(
    int amountMinorUnits,
  ) async {
    if (!contract.isV2) return null;
    final response = await _dio.get<dynamic>(
      '/me/eligibility',
      queryParameters: {'action': 'WITHDRAW', 'amount': '$amountMinorUnits'},
      // A blocked gate is a legitimate answer, not a transport failure, so the
      // body must be read instead of thrown. 403/422 carry the same shape as a
      // 200.
      options: Options(
        validateStatus: (status) => status != null && status < 500,
      ),
    );
    return WithdrawalEligibilityReport.tryFromServer(response.data);
  }

  Future<List<WithdrawalBankAccount>?> fetchBankAccounts() async {
    if (!contract.isV2) return null;
    final response = await _dio.get<dynamic>('/me/bank-accounts');
    final values = unwrapDataList(response.data);
    if (values == null) return null;
    return values
        .map(WithdrawalBankAccount.tryFromServer)
        .whereType<WithdrawalBankAccount>()
        .toList(growable: false);
  }

  Future<WithdrawalBankAccount?> verifyBankAccount({
    required String bankCode,
    required String accountNumber,
    String? idempotencyKey,
  }) async {
    if (!contract.isV2) return null;
    final response = await _dio.post<dynamic>(
      '/me/bank-accounts',
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
    // Keep the server's resolved bank name. The backend derives it from the
    // code when the client omits it, and overwriting it with a client-supplied
    // label let the review screen show a destination the server never stored.
    return WithdrawalBankAccount.tryFromServer(data);
  }

  Future<WithdrawalData?> createWithdrawal({
    required WithdrawalIntent intent,
    required WithdrawalBankAccount bankAccount,
    required String idempotencyKey,
  }) async {
    if (!contract.isV2) return null;
    final response = await _dio.post<dynamic>(
      '/withdrawals',
      data: {
        'amountMinorUnits': intent.amountMinorUnits,
        'bankAccountId': bankAccount.id,
      },
      options: Options(headers: {'Idempotency-Key': idempotencyKey}),
    );
    return WithdrawalData.tryFromServer(
      response.data,
      intent: intent,
      bankAccount: bankAccount,
    );
  }

  /// Contract §6 GET /withdrawals/{withdrawalId} resolves on the row id.
  Future<WithdrawalData?> fetchStatus(
    String withdrawalId, {
    WithdrawalData? previous,
  }) async {
    if (!contract.isV2) return null;
    final response = await _dio.get<dynamic>('/withdrawals/$withdrawalId');
    return WithdrawalData.tryFromServer(response.data, previous: previous);
  }
}

final withdrawalGatewayProvider = Provider<WithdrawalGateway>(
  (ref) => WithdrawalGateway(
    ref.watch(apiClientProvider),
    contract: ref.watch(backendContractProvider),
  ),
);
