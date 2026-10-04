enum VerificationStatus {
  notRequired,
  required,
  started,
  pending,
  underReview,
  verified,
  rejected,
  expired,
  unavailable,
}

enum VerificationCheckType {
  idDocument('ID_DOCUMENT', 'Government-issued ID'),
  selfie('SELFIE', 'Selfie check'),
  proofOfAddress('PROOF_OF_ADDRESS', 'Proof of address'),
  bvn('BVN', 'BVN'),
  nin('NIN', 'NIN');

  const VerificationCheckType(this.wireValue, this.label);
  final String wireValue;
  final String label;
}

class VerificationCheck {
  const VerificationCheck({
    required this.id,
    required this.type,
    required this.status,
    this.verifiedAt,
  });

  final String id;
  final String type;
  final String status;
  final DateTime? verifiedAt;

  factory VerificationCheck.fromJson(Map<String, dynamic> json) =>
      VerificationCheck(
        id: json['id']?.toString() ?? '',
        type: json['type']?.toString() ?? 'UNKNOWN',
        status: json['status']?.toString() ?? 'PENDING',
        verifiedAt: DateTime.tryParse(json['verifiedAt']?.toString() ?? ''),
      );
}

class VerificationSnapshot {
  const VerificationSnapshot({
    required this.status,
    this.caseId,
    this.updatedAt,
    this.checks = const [],
    this.isBanned = false,
  });

  final VerificationStatus status;
  final String? caseId;
  final DateTime? updatedAt;
  final List<VerificationCheck> checks;

  /// Server-owned account restriction. A ban blocks money and play but never
  /// blocks sign-in, so the client surfaces it as a dismissible banner rather
  /// than a dead end.
  final bool isBanned;

  VerificationSnapshot copyWith({bool? isBanned}) => VerificationSnapshot(
    status: status,
    caseId: caseId,
    updatedAt: updatedAt,
    checks: checks,
    isBanned: isBanned ?? this.isBanned,
  );

  bool get isInFlight => switch (status) {
    VerificationStatus.started ||
    VerificationStatus.pending ||
    VerificationStatus.underReview => true,
    _ => false,
  };

  static VerificationSnapshot? tryFromServer(dynamic value) {
    if (value is! Map) return null;
    final raw = Map<String, dynamic>.from(value);
    final caseValue = raw['case'];
    final caseData = caseValue is Map
        ? Map<String, dynamic>.from(caseValue)
        : null;
    final rawStatus =
        caseData?['status']?.toString() ?? raw['kycStatus']?.toString();
    final status = verificationStatusFromWire(rawStatus);
    if (status == VerificationStatus.unavailable) return null;
    final rawChecks = caseData?['checks'];
    return VerificationSnapshot(
      status: status,
      caseId: caseData?['id']?.toString(),
      updatedAt: DateTime.tryParse(caseData?['updatedAt']?.toString() ?? ''),
      checks: rawChecks is List
          ? rawChecks
                .whereType<Map>()
                .map(
                  (item) => VerificationCheck.fromJson(
                    Map<String, dynamic>.from(item),
                  ),
                )
                .toList(growable: false)
          : const [],
      isBanned: raw['isBanned'] == true,
    );
  }
}

VerificationStatus verificationStatusFromWire(dynamic value) {
  return switch (value?.toString().trim().toUpperCase()) {
    'NOT_REQUIRED' || 'NONE' => VerificationStatus.notRequired,
    'REQUIRED' => VerificationStatus.required,
    'STARTED' => VerificationStatus.started,
    'PENDING' => VerificationStatus.pending,
    'UNDER_REVIEW' => VerificationStatus.underReview,
    'VERIFIED' => VerificationStatus.verified,
    'REJECTED' => VerificationStatus.rejected,
    'EXPIRED' => VerificationStatus.expired,
    _ => VerificationStatus.unavailable,
  };
}

class SaferPlayProfile {
  const SaferPlayProfile({
    this.depositLimitMinorUnits,
    this.pendingDepositLimitMinorUnits,
    this.pendingDepositLimitRaisedAt,
    this.effectiveDepositLimitMinorUnits,
    this.stakeLimitMinorUnits,
    this.pendingStakeLimitMinorUnits,
    this.pendingStakeLimitRaisedAt,
    this.effectiveStakeLimitMinorUnits,
    this.timeoutUntil,
    this.selfExcludedUntil,
  });

  final int? depositLimitMinorUnits;
  final int? pendingDepositLimitMinorUnits;
  final DateTime? pendingDepositLimitRaisedAt;
  final int? effectiveDepositLimitMinorUnits;
  final int? stakeLimitMinorUnits;
  final int? pendingStakeLimitMinorUnits;
  final DateTime? pendingStakeLimitRaisedAt;
  final int? effectiveStakeLimitMinorUnits;
  final DateTime? timeoutUntil;
  final DateTime? selfExcludedUntil;

  bool isTimeoutActive(DateTime now) => timeoutUntil?.isAfter(now) ?? false;
  bool isSelfExcluded(DateTime now) => selfExcludedUntil?.isAfter(now) ?? false;

  static SaferPlayProfile? tryFromServer(
    dynamic value, {
    bool allowMissingProfile = true,
  }) {
    if (value is! Map) return null;
    final outer = Map<String, dynamic>.from(value);
    if (!outer.containsKey('profile')) return null;
    final valueProfile = outer['profile'];
    if (valueProfile == null) {
      return allowMissingProfile ? const SaferPlayProfile() : null;
    }
    if (valueProfile is! Map) return null;
    final raw = Map<String, dynamic>.from(valueProfile);
    const moneyFields = <String>{
      'depositLimitMinorUnits',
      'pendingDepositLimitMinorUnits',
      'effectiveDepositLimitMinorUnits',
      'stakeLimitMinorUnits',
      'pendingStakeLimitMinorUnits',
      'effectiveStakeLimitMinorUnits',
    };
    for (final field in moneyFields) {
      final candidate = raw[field];
      if (candidate != null && _minor(candidate) == null) return null;
    }
    const dateFields = <String>{
      'pendingDepositLimitRaisedAt',
      'pendingStakeLimitRaisedAt',
      'timeoutUntil',
      'selfExcludedUntil',
    };
    for (final field in dateFields) {
      final candidate = raw[field];
      if (candidate != null && _date(candidate) == null) return null;
    }
    return SaferPlayProfile(
      depositLimitMinorUnits: _minor(raw['depositLimitMinorUnits']),
      pendingDepositLimitMinorUnits: _minor(
        raw['pendingDepositLimitMinorUnits'],
      ),
      pendingDepositLimitRaisedAt: _date(raw['pendingDepositLimitRaisedAt']),
      effectiveDepositLimitMinorUnits: _minor(
        raw['effectiveDepositLimitMinorUnits'],
      ),
      stakeLimitMinorUnits: _minor(raw['stakeLimitMinorUnits']),
      pendingStakeLimitMinorUnits: _minor(raw['pendingStakeLimitMinorUnits']),
      pendingStakeLimitRaisedAt: _date(raw['pendingStakeLimitRaisedAt']),
      effectiveStakeLimitMinorUnits: _minor(
        raw['effectiveStakeLimitMinorUnits'],
      ),
      timeoutUntil: _date(raw['timeoutUntil']),
      selfExcludedUntil: _date(raw['selfExcludedUntil']),
    );
  }
}

enum EligibilityReason {
  eligibilityRequired,
  countryNotAllowed,
  ageNotVerified,
  kycRequired,
  accountRestricted,
  selfExcluded,
  timeoutActive,
  depositLimitExceeded,
  stakeLimitExceeded,
  unavailable,
}

enum EligibilityRemediation {
  retry,
  verifyIdentity,
  viewLimits,
  saferPlay,
  contactSupport,
  wait,
  none,
}

class EligibilityDecision {
  const EligibilityDecision({
    required this.reason,
    required this.message,
    required this.remediation,
    this.until,
  });

  final EligibilityReason reason;
  final String message;
  final EligibilityRemediation remediation;
  final DateTime? until;

  static EligibilityDecision? fromServerError({
    required int? statusCode,
    required dynamic body,
  }) {
    if (statusCode != 403 && statusCode != 422) return null;
    final message = _errorMessage(body);
    if (message == null) return null;
    final lower = message.toLowerCase();
    if (lower.contains('kyc') || lower.contains('verification is required')) {
      return EligibilityDecision(
        reason: EligibilityReason.kycRequired,
        message: message,
        remediation: EligibilityRemediation.verifyIdentity,
      );
    }
    if (lower.contains('age has not been verified')) {
      return EligibilityDecision(
        reason: EligibilityReason.ageNotVerified,
        message: message,
        remediation: EligibilityRemediation.verifyIdentity,
      );
    }
    if (lower.contains('not available in your country')) {
      return EligibilityDecision(
        reason: EligibilityReason.countryNotAllowed,
        message: message,
        remediation: EligibilityRemediation.contactSupport,
      );
    }
    if (lower.contains('account') && lower.contains('restricted')) {
      return EligibilityDecision(
        reason: EligibilityReason.accountRestricted,
        message: message,
        remediation: EligibilityRemediation.contactSupport,
      );
    }
    if (lower.contains('self-exclusion')) {
      return EligibilityDecision(
        reason: EligibilityReason.selfExcluded,
        message: message,
        remediation: EligibilityRemediation.wait,
        until: _isoDateIn(message),
      );
    }
    if (lower.contains('break is active') || lower.contains('timeout')) {
      return EligibilityDecision(
        reason: EligibilityReason.timeoutActive,
        message: message,
        remediation: EligibilityRemediation.wait,
        until: _isoDateIn(message),
      );
    }
    if (lower.contains('deposit') && lower.contains('limit')) {
      return EligibilityDecision(
        reason: EligibilityReason.depositLimitExceeded,
        message: message,
        remediation: EligibilityRemediation.viewLimits,
      );
    }
    if (lower.contains('stake') && lower.contains('limit')) {
      return EligibilityDecision(
        reason: EligibilityReason.stakeLimitExceeded,
        message: message,
        remediation: EligibilityRemediation.viewLimits,
      );
    }
    if (lower.contains('eligibility')) {
      return EligibilityDecision(
        reason: EligibilityReason.eligibilityRequired,
        message: message,
        remediation: EligibilityRemediation.contactSupport,
      );
    }
    return null;
  }
}

String? _errorMessage(dynamic body) {
  if (body is! Map) return null;
  final raw = body['error'];
  if (raw is String && raw.trim().isNotEmpty) return raw.trim();
  if (raw is Map) {
    final message = raw['message']?.toString().trim();
    if (message != null && message.isNotEmpty) return message;
  }
  return null;
}

DateTime? _isoDateIn(String value) {
  final match = RegExp(r'\d{4}-\d{2}-\d{2}T[^\s]+').firstMatch(value);
  return DateTime.tryParse(match?.group(0) ?? '');
}

int? _minor(dynamic value) {
  if (value == null) return null;
  if (value is! String || !RegExp(r'^\d+$').hasMatch(value)) return null;
  return int.tryParse(value);
}

DateTime? _date(dynamic value) => DateTime.tryParse(value?.toString() ?? '');
