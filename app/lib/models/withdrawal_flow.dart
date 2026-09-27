import 'deposit_flow.dart' show maskReference;
import 'match_flow.dart';

enum WithdrawalEligibility { eligible, verificationRequired, limitReached }

/// Flutter presentation states mapped one-to-one from the Backend V2
/// withdrawal lifecycle. Unknown server values deliberately remain
/// non-terminal so recovery can continue safely.
enum WithdrawalStatus {
  pendingReview,
  approved,
  processing,
  successful,
  failed,
  reversed,
  unknown,
}

class WithdrawalContractException implements Exception {
  const WithdrawalContractException(this.code, this.message);

  final String code;
  final String message;

  @override
  String toString() => 'WithdrawalContractException($code)';
}

class WithdrawalBankAccount {
  const WithdrawalBankAccount({
    required this.id,
    required this.gateway,
    required this.bankCode,
    required this.bankName,
    required this.accountName,
    required this.maskedAccountNumber,
    required this.verifiedAt,
    this.isDefault = false,
  });

  final String id;
  final String gateway;
  final String bankCode;
  final String bankName;
  final String accountName;
  final String maskedAccountNumber;
  final DateTime verifiedAt;
  final bool isDefault;

  String get displayLabel => '$bankName  $maskedAccountNumber';

  WithdrawalBankAccount copyWith({bool? isDefault}) => WithdrawalBankAccount(
    id: id,
    gateway: gateway,
    bankCode: bankCode,
    bankName: bankName,
    accountName: accountName,
    maskedAccountNumber: maskedAccountNumber,
    verifiedAt: verifiedAt,
    isDefault: isDefault ?? this.isDefault,
  );

  static WithdrawalBankAccount? tryFromServer(dynamic value) {
    if (value is! Map) return null;
    final raw = Map<String, dynamic>.from(value);
    final id = _text(raw['id']);
    final gateway = _text(raw['gateway']);
    final bankCode = _text(raw['bankCode']);
    final bankName = _text(raw['bankName']);
    final accountName = _text(raw['accountName']);
    final accountNumber = _text(raw['accountNumber']);
    final verifiedAt = DateTime.tryParse(raw['verifiedAt']?.toString() ?? '');
    if (id == null ||
        gateway == null ||
        bankCode == null ||
        bankName == null ||
        accountName == null ||
        accountNumber == null ||
        verifiedAt == null) {
      return null;
    }
    return WithdrawalBankAccount(
      id: id,
      gateway: gateway.toUpperCase(),
      bankCode: bankCode,
      bankName: bankName,
      accountName: accountName,
      maskedAccountNumber: maskBankAccount(accountNumber),
      verifiedAt: verifiedAt,
      isDefault: raw['isDefault'] == true,
    );
  }
}

class WithdrawalQuote {
  const WithdrawalQuote({
    required this.id,
    required this.amountMinorUnits,
    required this.currency,
    required this.eligibility,
    this.availableBalanceMinorUnits,
    this.feeMinorUnits,
    this.netAmountMinorUnits,
    this.limitMinorUnits,
    this.idempotencyKey,
    this.message,
    this.expiresAt,
  });

  final String id;
  final int amountMinorUnits;
  final String currency;
  final WithdrawalEligibility eligibility;
  final int? availableBalanceMinorUnits;
  final int? feeMinorUnits;
  final int? netAmountMinorUnits;
  final int? limitMinorUnits;
  final String? idempotencyKey;
  final String? message;
  final DateTime? expiresAt;

  bool get isCompleteForSubmission =>
      eligibility == WithdrawalEligibility.eligible &&
      availableBalanceMinorUnits != null &&
      feeMinorUnits != null &&
      netAmountMinorUnits != null &&
      idempotencyKey != null;

  static WithdrawalQuote? tryFromServer(dynamic value) {
    if (value is! Map) return null;
    final outer = Map<String, dynamic>.from(value);
    final envelope = outer['data'] is Map
        ? Map<String, dynamic>.from(outer['data'] as Map)
        : outer;
    final raw = envelope['quote'] is Map
        ? Map<String, dynamic>.from(envelope['quote'] as Map)
        : envelope;
    final id = _text(raw['id'] ?? raw['quoteId']);
    final amount = _minorUnits(raw['amountMinorUnits'] ?? raw['amountMinor']);
    final currency = _text(raw['currency']);
    if (id == null || amount == null || amount <= 0 || currency == null) {
      return null;
    }
    return WithdrawalQuote(
      id: id,
      amountMinorUnits: amount,
      currency: currency.toUpperCase(),
      eligibility: _eligibility(raw),
      availableBalanceMinorUnits: _minorUnits(
        raw['availableBalanceMinorUnits'],
      ),
      feeMinorUnits: _minorUnits(raw['feeMinorUnits']),
      netAmountMinorUnits: _minorUnits(
        raw['netAmountMinorUnits'] ?? raw['receiveMinorUnits'],
      ),
      limitMinorUnits: _minorUnits(raw['limitMinorUnits']),
      idempotencyKey: _text(raw['idempotencyKey']),
      message: _text(raw['message'] ?? raw['reason']),
      expiresAt: DateTime.tryParse(raw['expiresAt']?.toString() ?? ''),
    );
  }
}

class WithdrawalData {
  const WithdrawalData({
    required this.id,
    required this.reference,
    required this.amountMinorUnits,
    required this.currency,
    required this.status,
    required this.serverStatus,
    this.gateway,
    this.bankAccountId,
    this.feeMinorUnits,
    this.netAmountMinorUnits,
    this.availableBalanceMinorUnits,
    this.bankAccount,
    this.failureReason,
    this.transactionId,
    this.createdAt,
    this.updatedAt,
  });

  final String id;
  final String reference;
  final int amountMinorUnits;
  final String currency;
  final WithdrawalStatus status;
  final String serverStatus;
  final String? gateway;
  final String? bankAccountId;
  final int? feeMinorUnits;
  final int? netAmountMinorUnits;
  final int? availableBalanceMinorUnits;
  final WithdrawalBankAccount? bankAccount;
  final String? failureReason;
  final String? transactionId;
  final DateTime? createdAt;
  final DateTime? updatedAt;

  bool get isTerminal =>
      status == WithdrawalStatus.successful ||
      status == WithdrawalStatus.reversed;

  String get maskedReference => maskReference(reference);

  WithdrawalData copyWith({WithdrawalStatus? status}) => WithdrawalData(
    id: id,
    reference: reference,
    amountMinorUnits: amountMinorUnits,
    currency: currency,
    status: status ?? this.status,
    serverStatus: serverStatus,
    gateway: gateway,
    bankAccountId: bankAccountId,
    feeMinorUnits: feeMinorUnits,
    netAmountMinorUnits: netAmountMinorUnits,
    availableBalanceMinorUnits: availableBalanceMinorUnits,
    bankAccount: bankAccount,
    failureReason: failureReason,
    transactionId: transactionId,
    createdAt: createdAt,
    updatedAt: updatedAt,
  );

  static WithdrawalData? tryFromServer(
    dynamic value, {
    WithdrawalQuote? quote,
    WithdrawalBankAccount? bankAccount,
    WithdrawalData? previous,
  }) {
    if (value is! Map) return null;
    final raw = Map<String, dynamic>.from(value);
    final id = _text(raw['id']);
    final reference = _text(raw['reference']);
    final serverStatus = _text(raw['status']);
    final status = _withdrawalStatus(serverStatus);
    final amount =
        _minorUnits(raw['amountMinorUnits']) ??
        quote?.amountMinorUnits ??
        previous?.amountMinorUnits;
    final currency =
        _text(raw['currency']) ?? quote?.currency ?? previous?.currency;
    if (id == null ||
        reference == null ||
        serverStatus == null ||
        amount == null ||
        amount <= 0 ||
        currency == null) {
      return null;
    }
    return WithdrawalData(
      id: id,
      reference: reference,
      amountMinorUnits: amount,
      currency: currency.toUpperCase(),
      status: status,
      serverStatus: serverStatus.toUpperCase(),
      gateway: _text(raw['gateway'])?.toUpperCase() ?? previous?.gateway,
      bankAccountId: _text(raw['bankAccountId']) ?? previous?.bankAccountId,
      feeMinorUnits:
          _minorUnits(raw['feeMinorUnits']) ??
          quote?.feeMinorUnits ??
          previous?.feeMinorUnits,
      netAmountMinorUnits:
          _minorUnits(raw['netAmountMinorUnits'] ?? raw['receiveMinorUnits']) ??
          quote?.netAmountMinorUnits ??
          previous?.netAmountMinorUnits,
      availableBalanceMinorUnits:
          _minorUnits(raw['availableBalanceMinorUnits']) ??
          previous?.availableBalanceMinorUnits,
      bankAccount:
          WithdrawalBankAccount.tryFromServer(raw['bankAccount']) ??
          bankAccount ??
          previous?.bankAccount,
      failureReason: _text(raw['failureReason'] ?? raw['reason']),
      transactionId: _text(raw['transactionId']),
      createdAt:
          DateTime.tryParse(raw['createdAt']?.toString() ?? '') ??
          previous?.createdAt,
      updatedAt: DateTime.tryParse(
        (raw['updatedAt'] ?? raw['processedAt'])?.toString() ?? '',
      ),
    );
  }
}

String formatWithdrawalMoney(int? minorUnits, String? currency) {
  if (minorUnits == null || currency == null) return 'Unavailable';
  if (currency.toUpperCase() == 'NGN') return Money(minorUnits).format();
  final absolute = minorUnits.abs();
  final whole = (absolute ~/ 100).toString();
  final decimal = (absolute % 100).toString().padLeft(2, '0');
  return '${minorUnits < 0 ? '-' : ''}${currency.toUpperCase()} $whole.$decimal';
}

String maskBankAccount(String value) {
  final clean = value.trim();
  if (clean.contains('•') || clean.contains('*')) return clean;
  final digits = clean.replaceAll(RegExp(r'\D'), '');
  if (digits.length < 4) return 'Protected account';
  return '••••${digits.substring(digits.length - 4)}';
}

WithdrawalEligibility _eligibility(Map<String, dynamic> raw) {
  final value = _text(
    raw['eligibility'] ?? raw['eligibilityStatus'],
  )?.toLowerCase();
  if (raw['kycRequired'] == true ||
      value == 'verification_required' ||
      value == 'kyc_required') {
    return WithdrawalEligibility.verificationRequired;
  }
  if (raw['limitExceeded'] == true ||
      value == 'limit_reached' ||
      value == 'limit_exceeded') {
    return WithdrawalEligibility.limitReached;
  }
  return WithdrawalEligibility.eligible;
}

WithdrawalStatus _withdrawalStatus(dynamic value) {
  final status = _text(value)?.toLowerCase();
  return switch (status) {
    'pending_review' || 'pending' => WithdrawalStatus.pendingReview,
    'approved' => WithdrawalStatus.approved,
    'processing' => WithdrawalStatus.processing,
    'completed' => WithdrawalStatus.successful,
    'failed' => WithdrawalStatus.failed,
    'released' => WithdrawalStatus.reversed,
    _ => WithdrawalStatus.unknown,
  };
}

/// Converts a user-entered major-unit amount to canonical minor units without
/// floating-point arithmetic.
int? parseWithdrawalMinorUnits(String input) {
  final value = input.replaceAll(',', '').trim();
  if (!RegExp(r'^\d+(\.\d{1,2})?$').hasMatch(value)) return null;
  final parts = value.split('.');
  final whole = int.tryParse(parts.first);
  if (whole == null) return null;
  final fraction = parts.length == 1
      ? 0
      : int.tryParse(parts.last.padRight(2, '0'));
  if (fraction == null) return null;
  final amount = whole * 100 + fraction;
  return amount > 0 ? amount : null;
}

String? _text(dynamic value) {
  final text = value?.toString().trim();
  return text == null || text.isEmpty ? null : text;
}

int? _minorUnits(dynamic value) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  return int.tryParse(value?.toString() ?? '');
}
