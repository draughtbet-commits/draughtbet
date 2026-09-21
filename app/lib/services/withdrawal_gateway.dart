import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/withdrawal_flow.dart';
import 'api_client.dart';

class WithdrawalGateway {
  WithdrawalGateway(Dio _);

  Future<WithdrawalQuote?> createQuote(int amountMinorUnits) async {
    // The active backend has no withdrawal quote/read contract. The legacy
    // amount-only request cannot safely power the approved bank-destination
    // flow, so Flutter must show unavailable rather than invent fees/limits.
    return null;
  }

  Future<List<WithdrawalBankAccount>?> fetchBankAccounts() async {
    return null;
  }

  Future<WithdrawalBankAccount?> verifyBankAccount({
    required String bankCode,
    required String bankName,
    required String accountNumber,
    String? idempotencyKey,
  }) async {
    return null;
  }

  Future<WithdrawalData?> createWithdrawal({
    required WithdrawalQuote quote,
    required WithdrawalBankAccount bankAccount,
  }) async {
    // Do not fall back to POST /wallet/withdrawal-request: it accepts no bank
    // account and exposes no status read, so doing so would reserve funds from
    // a UI that cannot verify the destination or recover an ambiguous result.
    return null;
  }

  Future<WithdrawalData?> fetchStatus(
    String reference, {
    WithdrawalData? previous,
  }) async {
    return null;
  }
}

final withdrawalGatewayProvider = Provider<WithdrawalGateway>(
  (ref) => WithdrawalGateway(ref.watch(apiClientProvider)),
);
