import 'package:dio/dio.dart';

import '../models/match_flow.dart';

/// Read-only access to authoritative settlement projections.
///
/// This gateway intentionally exposes no POST/PATCH method. Flutter may refresh
/// status and receipt data, but it cannot start or retry money movement.
class SettlementGateway {
  const SettlementGateway(this._dio);

  final Dio _dio;

  Future<MatchResultViewData?> fetchStatus(String matchId) async {
    final response = await _dio.get('/settlements/$matchId');
    final body = response.data;
    if (body is! Map) return null;
    return MatchResultViewData.tryFromServer(body);
  }

  Future<MatchReceiptData?> fetchReceipt(String matchId) async {
    final response = await _dio.get('/matches/$matchId/receipt');
    final body = response.data;
    if (body is! Map) return null;
    return MatchReceiptData.tryFromServer(body);
  }
}
