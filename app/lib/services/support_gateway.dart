import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/support_case.dart';
import 'api_client.dart';

class SupportGateway {
  const SupportGateway(this._dio);

  final Dio _dio;

  Future<List<SupportCase>> fetchMyCases() async {
    final response = await _dio.get<dynamic>('/support/cases');
    return SupportCase.listFromServer(response.data);
  }

  /// Opens a case. Throws [DioException] on 400 (validation) / 429 (too many
  /// open cases) so the caller can surface the server's own message.
  Future<SupportCase?> openCase({
    required SupportCaseType type,
    required String subject,
    String? description,
  }) async {
    final response = await _dio.post<dynamic>(
      '/support/cases',
      data: {
        'type': type.wireValue,
        'subject': subject,
        if (description != null && description.trim().isNotEmpty)
          'description': description.trim(),
      },
    );
    return SupportCase.tryFromServer(response.data);
  }
}

final supportGatewayProvider = Provider<SupportGateway>(
  (ref) => SupportGateway(ref.watch(apiClientProvider)),
);