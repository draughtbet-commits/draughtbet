import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/backend_contract.dart';
import '../models/withdrawal_flow.dart';
import 'api_client.dart';

class WithdrawalGateway {
  WithdrawalGateway(Dio dio, {BackendContractConfig? contract})
    : _dio = dio,
      contract = contract ?? BackendContractConfig.fromEnvironment();

  static const _pageLimit = 100;
  static const _maxRecoveryPages = 20;

  final Dio _dio;
  final BackendContractConfig contract;

  Future<WithdrawalQuote?> createQuote(int amountMinorUnits) async {
    // Backend V2 currently exposes no withdrawal quote, limit, fee, or net
    // payout read. Returning null is intentional: the UI must remain safely
    // blocked instead of calculating financial terms locally.
    return null;
  }

  Future<List<WithdrawalBankAccount>?> fetchBankAccounts() async {
    if (!contract.isV2) return null;
    final response = await _dio.get<dynamic>('/wallet/bank-accounts');
    final values = _requiredListWrapper(response.data, 'bankAccounts');
    return values
        .map((value) {
          final account = WithdrawalBankAccount.tryFromServer(value);
          if (account == null) {
            throw const WithdrawalContractException(
              'malformed_bank_account',
              'The server returned an invalid bank-account record.',
            );
          }
          return account;
        })
        .toList(growable: false);
  }

  /// Creates and provider-verifies an account using a gateway identifier that
  /// must come from an authoritative server/configuration source. The current
  /// app has no such discovery contract, so production UI does not call this
  /// method yet; it remains contract-correct for when that source is supplied.
  Future<WithdrawalBankAccount?> createBankAccount({
    required String gateway,
    required String bankCode,
    required String bankName,
    required String accountNumber,
  }) async {
    if (!contract.isV2) return null;
    final normalizedGateway = gateway.trim().toLowerCase();
    if (normalizedGateway != 'paystack' && normalizedGateway != 'flutterwave') {
      throw const WithdrawalContractException(
        'unsupported_gateway',
        'The payout provider is not supported by Backend V2.',
      );
    }
    final response = await _dio.post<dynamic>(
      '/wallet/bank-accounts',
      data: {
        'gateway': normalizedGateway,
        'bankCode': bankCode,
        'bankName': bankName,
        'accountNumber': accountNumber,
      },
    );
    final raw = _requiredMapWrapper(response.data, 'bankAccount');
    final account = WithdrawalBankAccount.tryFromServer(raw);
    if (account == null) {
      throw const WithdrawalContractException(
        'malformed_bank_account',
        'The server returned an invalid verified bank account.',
      );
    }
    return account;
  }

  Future<WithdrawalBankAccount?> setDefaultBankAccount(
    WithdrawalBankAccount account,
  ) async {
    if (!contract.isV2) return null;
    final response = await _dio.patch<dynamic>(
      '/wallet/bank-accounts/${Uri.encodeComponent(account.id)}/default',
    );
    final raw = _requiredMapWrapper(response.data, 'bankAccount');
    final confirmed = WithdrawalBankAccount.tryFromServer(raw);
    if (confirmed == null ||
        confirmed.id != account.id ||
        !confirmed.isDefault) {
      throw const WithdrawalContractException(
        'unconfirmed_default_destination',
        'The server did not confirm the payout destination.',
      );
    }
    return confirmed;
  }

  Future<WithdrawalData?> createWithdrawal({
    required WithdrawalQuote quote,
    required WithdrawalBankAccount bankAccount,
  }) async {
    if (!contract.isV2) return null;
    if (!quote.isCompleteForSubmission || !bankAccount.isDefault) {
      throw const WithdrawalContractException(
        'incomplete_withdrawal_terms',
        'Authoritative withdrawal terms or destination are incomplete.',
      );
    }
    final response = await _dio.post<dynamic>(
      '/wallet/withdrawal-request',
      data: {
        'amountMinorUnits': quote.amountMinorUnits,
        'idempotencyKey': quote.idempotencyKey,
      },
    );
    final raw = _requiredMapWrapper(response.data, 'withdrawalRequest');
    final withdrawal = WithdrawalData.tryFromServer(
      raw,
      quote: quote,
      bankAccount: bankAccount,
    );
    if (withdrawal == null) {
      throw const WithdrawalContractException(
        'malformed_withdrawal',
        'The server returned an invalid withdrawal request.',
      );
    }
    if (withdrawal.bankAccountId != bankAccount.id) {
      throw const WithdrawalContractException(
        'destination_mismatch',
        'The server did not confirm the reviewed payout destination.',
      );
    }
    return withdrawal;
  }

  /// Backend V2 has no single-withdrawal endpoint. Recovery therefore reads
  /// the documented paginated collection and selects the matching server
  /// reference. No money-moving request is ever retried here.
  Future<WithdrawalData?> fetchStatus(
    String reference, {
    WithdrawalData? previous,
  }) async {
    if (!contract.isV2) return null;
    for (var page = 1; page <= _maxRecoveryPages; page += 1) {
      final response = await _dio.get<dynamic>(
        '/wallet/withdrawals',
        queryParameters: {'page': page, 'limit': _pageLimit},
      );
      final body = _requiredBody(response.data);
      final values = _requiredListWrapper(body, 'withdrawals');
      final total = _requiredNonNegativeInt(body['total'], 'total');
      for (final value in values) {
        final withdrawal = WithdrawalData.tryFromServer(
          value,
          previous: previous,
          bankAccount: previous?.bankAccount,
        );
        if (withdrawal == null) {
          throw const WithdrawalContractException(
            'malformed_withdrawal',
            'The server returned an invalid withdrawal record.',
          );
        }
        if (withdrawal.reference == reference || withdrawal.id == reference) {
          return withdrawal;
        }
      }
      if (page * _pageLimit >= total || values.isEmpty) return null;
    }
    return null;
  }
}

Map<String, dynamic> _requiredBody(dynamic value) {
  if (value is! Map) {
    throw const WithdrawalContractException(
      'malformed_response',
      'The server response was not an object.',
    );
  }
  return Map<String, dynamic>.from(value);
}

Map<String, dynamic> _requiredMapWrapper(dynamic value, String key) {
  final body = _requiredBody(value);
  final wrapped = body[key];
  if (wrapped is! Map) {
    throw WithdrawalContractException(
      'missing_$key',
      'The server response did not include a valid $key object.',
    );
  }
  return Map<String, dynamic>.from(wrapped);
}

List<dynamic> _requiredListWrapper(dynamic value, String key) {
  final body = _requiredBody(value);
  final wrapped = body[key];
  if (wrapped is! List) {
    throw WithdrawalContractException(
      'missing_$key',
      'The server response did not include a valid $key list.',
    );
  }
  return List<dynamic>.from(wrapped);
}

int _requiredNonNegativeInt(dynamic value, String key) {
  final parsed = value is int ? value : int.tryParse(value?.toString() ?? '');
  if (parsed == null || parsed < 0) {
    throw WithdrawalContractException(
      'invalid_$key',
      'The server response included an invalid $key value.',
    );
  }
  return parsed;
}

final withdrawalGatewayProvider = Provider<WithdrawalGateway>(
  (ref) => WithdrawalGateway(
    ref.watch(apiClientProvider),
    contract: ref.watch(backendContractProvider),
  ),
);
