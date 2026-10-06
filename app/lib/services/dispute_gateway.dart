import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/backend_contract.dart';
import '../models/dispute.dart';
import 'api_client.dart';

abstract interface class DisputeGateway {
  /// The player submit route is served by the backend.
  bool get playerContractAvailable;

  /// A player-facing dispute status read, served by the backend's
  /// GET /api/v1/matches/:matchId/disputes/:disputeId route.
  bool get statusContractAvailable;

  Future<DisputeCaseData?> submit({
    required DisputeMatchSummary match,
    required DisputeReason reason,
    required String details,
  });

  Future<DisputeCaseData?> fetchStatus({
    required String matchId,
    required String disputeId,
  });

  /// Reconciles a locally remembered submission ref against the server.
  /// `true` the case still exists, `false` it was cleared/not found, `null`
  /// when the server could not be reached (keep the ref rather than prune on
  /// a transient network blip).
  Future<bool?> caseExists({
    required String matchId,
    required String disputeId,
  });
}

/// Raised when the server rejects a dispute submit. The message is already
/// safe to show the player, so the provider surfaces it verbatim.
class DisputeContractError implements Exception {
  const DisputeContractError(this.message, {this.statusCode});

  final String message;
  final int? statusCode;

  @override
  String toString() => message;
}

class BackendDisputeGateway implements DisputeGateway {
  BackendDisputeGateway(this._dio);

  final Dio _dio;

  @override
  bool get playerContractAvailable => true;

  // The player status read is served by the backend on the same match-scoped
  // surface as the submit route.
  @override
  bool get statusContractAvailable => true;

  @override
  Future<DisputeCaseData?> submit({
    required DisputeMatchSummary match,
    required DisputeReason reason,
    required String details,
  }) async {
    // The server rejects an empty message, while the details field is
    // deliberately optional in the UI, so the reason label stands in when the
    // player adds no detail of their own.
    final message = details.trim().isEmpty ? reason.label : details.trim();
    try {
      final response = await _dio.post<dynamic>(
        '/matches/${Uri.encodeComponent(match.matchId)}/disputes',
        data: {'category': reason.wireValue, 'message': message},
        options: Options(
          headers: {'Idempotency-Key': ClientRequestId.create('dispute')},
        ),
      );
      return DisputeCaseData.tryFromSubmit(
        response.data,
        matchId: match.matchId,
        reasonLabel: reason.label,
      );
    } on DioException catch (error) {
      throw DisputeContractError(
        _submitFailureMessage(error),
        statusCode: error.response?.statusCode,
      );
    }
  }

  @override
  Future<DisputeCaseData?> fetchStatus({
    required String matchId,
    required String disputeId,
  }) async {
    try {
      final response = await _dio.get<dynamic>(
        '/matches/${Uri.encodeComponent(matchId)}'
        '/disputes/${Uri.encodeComponent(disputeId)}',
      );
      return DisputeCaseData.tryFromServer(response.data);
    } on DioException {
      // A transport or 4xx/5xx read leaves the status screen on its
      // fail-closed state; the provider decides how to phrase that.
      return null;
    }
  }

  @override
  Future<bool?> caseExists({
    required String matchId,
    required String disputeId,
  }) async {
    try {
      final response = await _dio.get<dynamic>(
        '/matches/${Uri.encodeComponent(matchId)}'
        '/disputes/${Uri.encodeComponent(disputeId)}',
      );
      return response.statusCode == 200;
    } on DioException catch (error) {
      if (error.response?.statusCode == 404) return false;
      return null;
    }
  }

  String _submitFailureMessage(DioException error) {
    // A transport failure has no response body to read a code from.
    final body = error.response?.data;
    if (body == null) {
      return 'Cannot reach the server. Check your connection and try again.';
    }
    final code = body is Map && body['error'] is Map
        ? body['error']['code']?.toString()
        : null;
    return switch (code) {
      'DISPUTE_NOT_ELIGIBLE' => 'You cannot report this match.',
      'DISPUTE_WINDOW_EXPIRED' =>
        'The reporting window for this match has closed.',
      'DUPLICATE_DISPUTE' => 'This match has already been reported.',
      'DUPLICATE_OPERATION' =>
        'This report is already being submitted. Give it a moment.',
      _ => apiErrorMessage(body) ?? 'The report could not be submitted.',
    };
  }
}

final disputeGatewayProvider = Provider<DisputeGateway>(
  (ref) => BackendDisputeGateway(ref.watch(apiClientProvider)),
);
