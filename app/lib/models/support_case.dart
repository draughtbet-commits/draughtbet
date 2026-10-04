import 'package:flutter/foundation.dart';

/// Server-owned support case types (mirrors SUPPORT_CASE_TYPES in
/// backend/src/modules/support/service.js).
enum SupportCaseType {
  general('GENERAL', 'General'),
  payment('PAYMENT', 'Payment'),
  withdrawal('WITHDRAWAL', 'Withdrawal'),
  kyc('KYC', 'Identity verification'),
  match('MATCH', 'Match'),
  account('ACCOUNT', 'Account'),
  saferPlay('SAFER_PLAY', 'Safer play');

  const SupportCaseType(this.wireValue, this.label);

  final String wireValue;
  final String label;

  static SupportCaseType fromWire(dynamic value) =>
      SupportCaseType.values.firstWhere(
        (t) => t.wireValue == value?.toString().trim().toUpperCase(),
        orElse: () => SupportCaseType.general,
      );
}

enum SupportCaseStatus {
  // Wire values must stay in lockstep with SUPPORT_CASE_STATUSES in
  // backend/src/modules/support/service.js. Anything that drifts here silently
  // renders as `unknown` and makes an open case look closed.
  open('OPEN', 'Open'),
  inProgress('IN_PROGRESS', 'In progress'),
  waitingOnPlayer('WAITING_USER', 'Waiting on you'),
  resolved('RESOLVED', 'Resolved'),
  closed('CLOSED', 'Closed'),
  unknown('UNKNOWN', 'Unknown');

  const SupportCaseStatus(this.wireValue, this.label);

  final String wireValue;
  final String label;

  static SupportCaseStatus fromWire(dynamic value) {
    final match = SupportCaseStatus.values.where(
      (s) => s.wireValue == value?.toString().trim().toUpperCase(),
    );
    return match.isEmpty ? SupportCaseStatus.unknown : match.first;
  }

  bool get isOpen =>
      this == SupportCaseStatus.open ||
      this == SupportCaseStatus.inProgress ||
      this == SupportCaseStatus.waitingOnPlayer;
}

@immutable
class SupportCase {
  const SupportCase({
    required this.id,
    required this.type,
    required this.status,
    required this.subject,
    this.description,
    this.createdAt,
    this.updatedAt,
  });

  final String id;
  final SupportCaseType type;
  final SupportCaseStatus status;
  final String subject;
  final String? description;
  final DateTime? createdAt;
  final DateTime? updatedAt;

  /// `ABC••••XYZ` — never show a full case id on a shared screen.
  String get maskedReference {
    if (id.length < 6) return 'Unavailable';
    return '${id.substring(0, 3)}••••${id.substring(id.length - 3)}';
  }

  static SupportCase? tryFromServer(dynamic value) {
    if (value is! Map) return null;
    final raw = Map<String, dynamic>.from(value);
    final id = raw['id']?.toString();
    if (id == null || id.isEmpty) return null;
    return SupportCase(
      id: id,
      type: SupportCaseType.fromWire(raw['type']),
      status: SupportCaseStatus.fromWire(raw['status']),
      subject: raw['subject']?.toString() ?? '',
      description: raw['description']?.toString(),
      createdAt: DateTime.tryParse(raw['createdAt']?.toString() ?? ''),
      updatedAt: DateTime.tryParse(raw['updatedAt']?.toString() ?? ''),
    );
  }

  static List<SupportCase> listFromServer(dynamic value) {
    if (value is! List) return const [];
    return value
        .map(SupportCase.tryFromServer)
        .whereType<SupportCase>()
        .toList(growable: false);
  }
}