import '../models/match_flow.dart';

/// Read-only access to authoritative settlement projections.
///
/// This gateway intentionally exposes no POST/PATCH method. Flutter may refresh
/// status and receipt data, but it cannot start or retry money movement.
class SettlementGateway {
  const SettlementGateway();

  Future<MatchResultViewData?> fetchStatus(String matchId) async {
    // The active backend exposes no settlement-status read endpoint. Returning
    // null keeps the approved pending/unavailable state honest and avoids a
    // request to the roadmap-only `/settlements/:matchId` contract.
    return null;
  }

  Future<MatchReceiptData?> fetchReceipt(String matchId) async {
    // Match receipts are not yet exposed by the active backend.
    return null;
  }
}
