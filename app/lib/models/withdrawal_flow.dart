import 'deposit_flow.dart' show maskReference;
import 'match_flow.dart';

enum WithdrawalEligibility { eligible, verificationRequired, limitReached }

// PENDING_REVIEW / APPROVED / PROCESSING are all "money is held, in flight".
// payoutFailed is the provider-refused case: funds STAY reserved until an
// admin retries or releases them, so it is deliberately NOT terminal and
// polling continues. Only completed and reversed return money or confirm it
// left the platform, so only those are terminal.
enum WithdrawalStatus {
  pendingReview,
  processing,

  /// The provider refused the payout. The reservation is still held, so this is
  /// not terminal: an admin retries or releases it.
  payoutFailed,
  successful,

  /// The reservation was released and the amount returned to the wallet.
  reversed;

  /// Only these two mean "stop polling, the money has settled".
  bool get isTerminal =>
      this == WithdrawalStatus.successful || this == WithdrawalStatus.reversed;
}

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

/// Contract §4 GET /me/eligibility?action=WITHDRAW&amount=…
///
/// The backend contract has no withdrawal quote endpoint. The pre-flight gate
/// is this read: it explains (never decides) why a withdrawal would be blocked.
/// Response is either `{allowed: true, requirements: [...]}` or
/// `{allowed: false, error: {code, message}, status}` where `code` is the
/// canonical gate error name, e.g. `KycRequiredError`.
class WithdrawalEligibilityReport {
  const WithdrawalEligibilityReport({
    required this.allowed,
    this.errorCode,
    this.message,
    this.requirements = const <String>[],
  });

  final bool allowed;
  final String? errorCode;
  final String? message;
  final List<String> requirements;

  /// The contract's gate is 403 for "on file / verified / not restricted"
  /// checks and 422 for an amount ceiling. Which screen a block belongs on
  /// follows from the canonical code, not the HTTP status.
  WithdrawalEligibility get outcome {
    if (allowed) return WithdrawalEligibility.eligible;
    switch (errorCode) {
      case 'KycRequiredError' ||
          'EligibilityRequiredError' ||
          'AgeNotVerifiedError':
        return WithdrawalEligibility.verificationRequired;
      case 'StakeLimitExceededError' || 'DepositLimitExceededError':
        return WithdrawalEligibility.limitReached;
      default:
        return WithdrawalEligibility.eligible;
    }
  }

  static WithdrawalEligibilityReport? tryFromServer(dynamic value) {
    if (value is! Map) return null;
    final raw = Map<String, dynamic>.from(value);
    final allowed = raw['allowed'];
    if (allowed is! bool) return null;
    if (allowed) {
      final requirements = raw['requirements'];
      return WithdrawalEligibilityReport(
        allowed: true,
        requirements: requirements is List
            ? requirements.map((e) => e.toString()).toList(growable: false)
            : const <String>[],
      );
    }
    final error = raw['error'];
    final code = error is Map ? _text(error['code']) : null;
    final message = error is Map ? _text(error['message']) : null;
    return WithdrawalEligibilityReport(
      allowed: false,
      errorCode: code,
      message: message,
    );
  }
}

/// The player's own requested amount, gated by the contract eligibility read.
/// There is deliberately no server-quoted fee, net amount or limit here: the
/// contract never returns one for withdrawals, so any such figure shown to a
/// player before submitting would have been invented by the app.
class WithdrawalIntent {
  const WithdrawalIntent({
    required this.amountMinorUnits,
    required this.currency,
    this.eligibility = WithdrawalEligibility.eligible,
    this.message,
    this.idempotencyKey,
  });

  final int amountMinorUnits;
  final String currency;
  final WithdrawalEligibility eligibility;
  final String? message;
  final String? idempotencyKey;
}

class WithdrawalData {
  const WithdrawalData({
    required this.id,
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

  /// Contract §6 GET /withdrawals/{withdrawalId} resolves on the row id. The
  /// `wit-` reference is display-only and 404s against that route, so the two
  /// must never be conflated again.
  final String id;

  /// Human-facing payout reference echoed to the provider. Never used to
  /// address the status route.
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
    id: id,
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
    WithdrawalIntent? intent,
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
    // The row id addresses GET /withdrawals/{withdrawalId}; the wit- reference
    // is display-only. Reading only `withdrawalId` (a key the server never
    // sends) is what sent the reference down the id lookup and 404ed.
    final id = _text(raw['id'] ?? raw['withdrawalId']) ?? previous?.id;
    final reference =
        _text(raw['reference'] ?? raw['withdrawalReference']) ??
        previous?.reference;
    final status = _withdrawalStatus(raw['status']);
    final amount =
        _minorUnits(raw['amountMinorUnits'] ?? raw['amountMinor']) ??
        intent?.amountMinorUnits ??
        previous?.amountMinorUnits;
    final currency =
        _text(raw['currency']) ?? intent?.currency ?? previous?.currency;
    if (reference == null ||
        id == null ||
        status == null ||
        amount == null ||
        currency == null) {
      return null;
    }
    return WithdrawalData(
      id: id,
      reference: reference,
      amountMinorUnits: amount,
      currency: currency.toUpperCase(),
      status: status,
      feeMinorUnits:
          _minorUnits(raw['feeMinorUnits']) ?? previous?.feeMinorUnits,
      netAmountMinorUnits:
          _minorUnits(raw['netAmountMinorUnits'] ?? raw['receiveMinorUnits']) ??
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
    // FAILED means the provider refused the payout and the funds are still
    // reserved. RELEASED/rejected means they came back. Collapsing the two
    // told players their money had been returned while it was still held.
    'failed' => WithdrawalStatus.payoutFailed,
    'released' || 'reversed' || 'rejected' => WithdrawalStatus.reversed,
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
