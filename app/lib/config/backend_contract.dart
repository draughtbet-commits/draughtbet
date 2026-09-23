import 'dart:math';

import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

enum BackendContractMode { legacy, v2 }

class BackendContractConfig {
  const BackendContractConfig(this.mode);

  final BackendContractMode mode;

  bool get isV2 => mode == BackendContractMode.v2;

  String path({required String legacy, required String v2}) =>
      isV2 ? '/api/v1$v2' : legacy;

  static BackendContractConfig fromEnvironment() {
    final configured = dotenv.isInitialized
        ? dotenv.env['BACKEND_CONTRACT']?.trim().toLowerCase()
        : null;
    return BackendContractConfig(
      configured == 'v2' ? BackendContractMode.v2 : BackendContractMode.legacy,
    );
  }
}

final backendContractProvider = Provider<BackendContractConfig>(
  (ref) => BackendContractConfig.fromEnvironment(),
);

class ClientRequestId {
  ClientRequestId._();

  static final Random _random = Random.secure();

  static String create(String operation) {
    final micros = DateTime.now().toUtc().microsecondsSinceEpoch;
    final nonce = _random.nextInt(0x7fffffff).toRadixString(16);
    return '$operation-$micros-$nonce';
  }
}

Map<String, dynamic>? unwrapData(dynamic value) {
  if (value is! Map) return null;
  final outer = Map<String, dynamic>.from(value);
  final data = outer['data'];
  return data is Map ? Map<String, dynamic>.from(data) : outer;
}

List<dynamic>? unwrapDataList(dynamic value) {
  if (value is List) return value;
  if (value is! Map) return null;
  final data = value['data'];
  return data is List ? data : null;
}

String? apiErrorMessage(dynamic value) {
  if (value is! Map) return null;
  final body = Map<String, dynamic>.from(value);
  final error = body['error'];
  if (error is String && error.trim().isNotEmpty) return error.trim();
  if (error is Map) {
    final message = error['message']?.toString().trim();
    if (message != null && message.isNotEmpty) return message;
  }
  return null;
}
