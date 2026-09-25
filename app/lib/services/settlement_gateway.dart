import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/backend_contract.dart';
import '../models/match_flow.dart';
import '../providers/profile_provider.dart';
import 'api_client.dart';

/// Read-only access to authoritative settlement projections.
///
/// This gateway intentionally exposes no POST/PATCH method. Flutter may refresh
/// status and receipt data, but it cannot start or retry money movement.
class SettlementGateway {
  const SettlementGateway([
    this._dio,
    this.contract = const BackendContractConfig(BackendContractMode.legacy),
    this.currentUserId,
  ]);

  final Dio? _dio;
  final BackendContractConfig contract;

  /// Receipt rows are per-participant in the active V2 contract; the viewer's
  /// own row is selected by id so the receipt mirrors this player's result.
  final String? currentUserId;

  Future<MatchResultViewData?> fetchStatus(String matchId) async {
    // The active backend exposes no settlement-status read endpoint. Returning
    // null keeps the approved pending/unavailable state honest and avoids a
    // request to the roadmap-only `/settlements/:matchId` contract.
    return null;
  }

  Future<MatchReceiptData?> fetchReceipt(String matchId) async {
    if (!contract.isV2 || _dio == null) return null;
    final response = await _dio.get<dynamic>(
      '/matches/$matchId/receipt',
    );
    final body = response.data;
    if (body is! Map) return null;
    return MatchReceiptData.tryFromServer(body, currentUserId: currentUserId);
  }
}

final settlementGatewayProvider = Provider<SettlementGateway>((ref) {
  final profile = ref.watch(profileProvider).profile;
  return SettlementGateway(
    ref.watch(apiClientProvider),
    ref.watch(backendContractProvider),
    profile?.id,
  );
});
