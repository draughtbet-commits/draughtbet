import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/backend_contract.dart';
import '../models/match_flow.dart';
import 'api_client.dart';

/// Read-only access to authoritative settlement projections.
///
/// This gateway intentionally exposes no POST/PATCH method. Flutter may refresh
/// status and receipt data, but it cannot start or retry money movement.
class SettlementGateway {
  const SettlementGateway([
    this._dio,
    this.contract = const BackendContractConfig(BackendContractMode.legacy),
  ]);

  final Dio? _dio;
  final BackendContractConfig contract;

  Future<MatchResultViewData?> fetchStatus(String matchId) async {
    // The active backend exposes no settlement-status read endpoint. Returning
    // null keeps the approved pending/unavailable state honest and avoids a
    // request to the roadmap-only `/settlements/:matchId` contract.
    return null;
  }

  Future<MatchReceiptData?> fetchReceipt(String matchId) async {
    if (!contract.isV2 || _dio == null) return null;
    final response = await _dio.get<dynamic>(
      '/api/v1/matches/$matchId/receipt',
    );
    final body = response.data;
    if (body is! Map) return null;
    return MatchReceiptData.tryFromServer(body);
  }
}

final settlementGatewayProvider = Provider<SettlementGateway>((ref) {
  return SettlementGateway(
    ref.watch(apiClientProvider),
    ref.watch(backendContractProvider),
  );
});
