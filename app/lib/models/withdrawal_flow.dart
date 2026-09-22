import 'deposit_flow.dart' show maskReference;
import 'match_flow.dart';

enum WithdrawalEligibility { eligible, verificationRequired, limitReached }

enum WithdrawalStatus { pendingReview, processing, successful, reversed }

class WithdrawalBankAccount {
  const WithdrawalBankAccount({
    required this.id,
    required this.bankCode,
    required this.bankName,
    required this.accountName,
    required this.maskedAccountNumber,
    this.isDefault = false,
  });

  final String id;
  final String bankCode;
  final String bankName;
  final String accountName;
  final String maskedAccountNumber;
  final bool isDefault;

  String get displayLabel => '$bankName  $maskedAccountNumber';

  static WithdrawalBankAccount? tryFromServer(dynamic value) {
    if (value is! Map) return null;
    final outer = Map<String, dynamic>.from(value);
    final raw = outer['data'] is Map
        ? Map<String, dynamic>.from(outer['data'] as Map)
        : outer;
    final id = _text(raw['id'] ?? raw['bankAccountId']);
    final bankCode = _text(raw['bankCode']) ?? '';
    final bankName = _text(raw['bankName'] ?? raw['bank']);
    final accountName = _text(raw['accountName']);
    final accountNumber = _text(
      raw['maskedAccount'] ??
          raw['maskedAccountNumber'] ??
          raw['accountNumber'],
      // V2 intentionally returns only a masked account value.
      // Keep legacy aliases for mixed deployments.
    );
    if (id == null ||
        bankName == null ||
        accountName == null ||
        accountNumber == null) {
      return null;
    }
    return WithdrawalBankAccount(
      id: id,
      bankCode: bankCode,
      bankName: bankName,
      accountName: accountName,
      maskedAccountNumber: maskBankAccount(accountNumber),
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
    required this.reference,
    required this.amountMinorUnits,
    required this.currency,
    required this.status,
    this.feeMinorUnits,
    this.netAmountMinorUnits,
    this.availableBalanceMinorUnits,
    this.bankAccount,
    this.failureReason,
    this.transactionId,
    this.createdAt,
    this.updatedAt,
  });

  final String reference;
  final int amountMinorUnits;
  final String currency;
  final WithdrawalStatus status;
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
    reference: reference,
    amountMinorUnits: amountMinorUnits,
    currency: currency,
    status: status ?? this.status,
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
    final outer = Map<String, dynamic>.from(value);
    final envelope = outer['data'] is Map
        ? Map<String, dynamic>.from(outer['data'] as Map)
        : outer;
    final raw = envelope['withdrawal'] is Map
        ? Map<String, dynamic>.from(envelope['withdrawal'] as Map)
        : envelope;
    final reference = _text(
      raw['withdrawalId'] ?? raw['reference'] ?? raw['withdrawalReference'],
    );
    final status = _withdrawalStatus(raw['status']);
    final amount =
        _minorUnits(raw['amountMinorUnits'] ?? raw['amountMinor']) ??
        quote?.amountMinorUnits ??
        previous?.amountMinorUnits;
    final currency =
        _text(raw['currency']) ?? quote?.currency ?? previous?.currency;
    if (reference == null ||
        status == null ||
        amount == null ||
        currency == null) {
      return null;
    }
    return WithdrawalData(
      reference: reference,
      amountMinorUnits: amount,
      currency: currency.toUpperCase(),
      status: status,
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

WithdrawalStatus? _withdrawalStatus(dynamic value) {
  final status = _text(value)?.toLowerCase();
  return switch (status) {
    'under_review' ||
    'pending_review' ||
    'pending' ||
    'reserved' => WithdrawalStatus.pendingReview,
    'approved' ||
    'processing' ||
    'provider_processing' => WithdrawalStatus.processing,
    'completed' ||
    'confirmed' ||
    'successful' ||
    'success' => WithdrawalStatus.successful,
    'failed' ||
    'released' ||
    'reversed' ||
    'rejected' => WithdrawalStatus.reversed,
    _ => null,
  };
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
