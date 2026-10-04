import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/eligibility.dart';
import 'api_client.dart';

/// What starting a verification attempt produced.
///
/// Most providers answer inline, so [snapshot] already carries the verdict and
/// [widgetUrl] is null. An asynchronous provider instead leaves the case
/// pending and returns [widgetUrl]: the hosted page where the player captures
/// their ID and selfie, which they must open before the verdict can exist.
class VerificationStartResult {
  const VerificationStartResult({
    required this.snapshot,
    this.providerReference,
    this.widgetId,
    this.widgetUrl,
  });

  final VerificationSnapshot? snapshot;

  /// The attempt's handle at the provider. Must be handed back to the provider
  /// when capture starts: it is how the eventual webhook is matched to this
  /// case, so a client that launched the widget under a different reference
  /// would leave the verdict unmatchable.
  final String? providerReference;

  /// Launches the provider's native SDK. Preferred over [widgetUrl] where the
  /// SDK is available.
  final String? widgetId;

  /// The hosted capture page, for clients without the SDK.
  final String? widgetUrl;
}

class EligibilityGateway {
  const EligibilityGateway(this._dio);

  final Dio _dio;

  Future<VerificationSnapshot?> fetchVerificationStatus() async {
    final response = await _dio.get<dynamic>('/verification/status');
    return VerificationSnapshot.tryFromServer(response.data);
  }

  Future<VerificationStartResult> startVerification(
    VerificationCheckType type,
  ) async {
    final response = await _dio.post<dynamic>(
      '/verification/start',
      data: {'type': type.wireValue},
    );
    final data = response.data;
    String? field(String name) => data is Map ? data[name] as String? : null;
    return VerificationStartResult(
      snapshot: await fetchVerificationStatus(),
      providerReference: field('providerReference'),
      widgetId: field('widgetId'),
      widgetUrl: field('widgetUrl'),
    );
  }

  Future<SaferPlayProfile?> fetchSaferPlayProfile() async {
    final response = await _dio.get<dynamic>('/safer-play/profile');
    return SaferPlayProfile.tryFromServer(response.data);
  }

  Future<SaferPlayProfile?> setDepositLimit(int? amountMinorUnits) async {
    final response = await _dio.put<dynamic>(
      '/safer-play/deposit-limit',
      data: {'amountMinorUnits': amountMinorUnits?.toString()},
    );
    return SaferPlayProfile.tryFromServer(
      response.data,
      allowMissingProfile: false,
    );
  }

  Future<SaferPlayProfile?> setStakeLimit(int? amountMinorUnits) async {
    final response = await _dio.put<dynamic>(
      '/safer-play/stake-limit',
      data: {'amountMinorUnits': amountMinorUnits?.toString()},
    );
    return SaferPlayProfile.tryFromServer(
      response.data,
      allowMissingProfile: false,
    );
  }

  Future<SaferPlayProfile?> startTimeout(int minutes) async {
    final response = await _dio.post<dynamic>(
      '/safer-play/timeout',
      data: {'minutes': minutes},
    );
    return SaferPlayProfile.tryFromServer(
      response.data,
      allowMissingProfile: false,
    );
  }

  Future<SaferPlayProfile?> startSelfExclusion(String until) async {
    final response = await _dio.post<dynamic>(
      '/safer-play/self-exclusion',
      data: {'until': until},
    );
    return SaferPlayProfile.tryFromServer(
      response.data,
      allowMissingProfile: false,
    );
  }
}

final eligibilityGatewayProvider = Provider<EligibilityGateway>(
  (ref) => EligibilityGateway(ref.watch(apiClientProvider)),
);
