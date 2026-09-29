import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/dispute.dart';

abstract interface class DisputeGateway {
  bool get playerContractAvailable;

  Future<DisputeCaseData?> submit({
    required DisputeMatchSummary match,
    required DisputeReason reason,
    required String details,
  });

  Future<DisputeCaseData?> fetchStatus(String disputeId);
}

/// PR11 currently exposes dispute operations only under the admin RBAC routes.
/// Keeping the player gateway explicitly unavailable prevents Flutter from
/// inventing `/disputes` writes or presenting a false successful submission.
class BackendDisputeGateway implements DisputeGateway {
  const BackendDisputeGateway();

  @override
  bool get playerContractAvailable => false;

  @override
  Future<DisputeCaseData?> fetchStatus(String disputeId) async => null;

  @override
  Future<DisputeCaseData?> submit({
    required DisputeMatchSummary match,
    required DisputeReason reason,
    required String details,
  }) async => null;
}

final disputeGatewayProvider = Provider<DisputeGateway>(
  (ref) => const BackendDisputeGateway(),
);
