import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/eligibility.dart';
import 'api_client.dart';

class EligibilityGateway {
  const EligibilityGateway(this._dio);

  final Dio _dio;

  Future<VerificationSnapshot?> fetchVerificationStatus() async {
    final response = await _dio.get<dynamic>('/verification/status');
    return VerificationSnapshot.tryFromServer(response.data);
  }

  Future<VerificationSnapshot?> startVerification(
    VerificationCheckType type,
  ) async {
    await _dio.post<dynamic>(
      '/verification/start',
      data: {'type': type.wireValue},
    );
    return fetchVerificationStatus();
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
