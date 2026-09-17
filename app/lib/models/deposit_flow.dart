import 'match_flow.dart';

enum DepositStatus { processing, pending, successful, failed }

class DepositPaymentMethod {
  const DepositPaymentMethod({
    required this.id,
    required this.label,
    this.description,
    this.maskedInstrument,
  });

  final String id;
  final String label;
  final String? description;
  final String? maskedInstrument;

  static DepositPaymentMethod? tryFromServer(dynamic value) {
    if (value is! Map) return null;
    final body = Map<String, dynamic>.from(value);
    final id = _text(body['id'] ?? body['key'] ?? body['code']);
    final label = _text(body['label'] ?? body['name']);
    if (id == null || label == null) return null;
    return DepositPaymentMethod(
      id: id,
      label: label,
      description: _text(body['description']),
      maskedInstrument: _maskInstrument(
        _text(body['maskedInstrument'] ?? body['maskedAccount']),
      ),
    );
  }
}

class DepositQuote {
  const DepositQuote({
    required this.id,
    required this.amountMinorUnits,
    required this.currency,
    required this.paymentMethods,
    this.feeMinorUnits,
    this.totalMinorUnits,
    this.idempotencyKey,
    this.expiresAt,
  });

  final String id;
  final int amountMinorUnits;
  final int? feeMinorUnits;
  final int? totalMinorUnits;
  final String currency;
  final List<DepositPaymentMethod> paymentMethods;
  final String? idempotencyKey;
  final DateTime? expiresAt;

  static DepositQuote? tryFromServer(dynamic value) {
    if (value is! Map) return null;
    final outer = Map<String, dynamic>.from(value);
    final raw = outer['quote'] is Map
        ? Map<String, dynamic>.from(outer['quote'] as Map)
        : outer;
    final id = _text(raw['id'] ?? raw['quoteId']);
    final amount = _minorUnits(raw['amountMinorUnits']);
    final currency = _text(raw['currency']);
    if (id == null || amount == null || amount <= 0 || currency == null) {
      return null;
    }
    final methodValues = raw['paymentMethods'];
    final methods = methodValues is List
        ? methodValues
              .map(DepositPaymentMethod.tryFromServer)
              .whereType<DepositPaymentMethod>()
              .toList(growable: false)
        : const <DepositPaymentMethod>[];
    return DepositQuote(
      id: id,
      amountMinorUnits: amount,
      feeMinorUnits: _minorUnits(raw['feeMinorUnits']),
      totalMinorUnits: _minorUnits(raw['totalMinorUnits']),
      currency: currency.toUpperCase(),
      paymentMethods: methods,
      idempotencyKey: _text(raw['idempotencyKey']),
      expiresAt: _date(raw['expiresAt']),
    );
  }
}

class DepositIntentData {
  const DepositIntentData({
    required this.reference,
    required this.amountMinorUnits,
    required this.currency,
    required this.status,
    this.feeMinorUnits,
    this.totalMinorUnits,
    this.paymentMethodLabel,
    this.maskedInstrument,
    this.authorizationUrl,
    this.failureReason,
    this.createdAt,
    this.updatedAt,
    this.availableBalanceMinorUnits,
    this.transactionId,
  });

  final String reference;
  final int amountMinorUnits;
  final int? feeMinorUnits;
  final int? totalMinorUnits;
  final String currency;
  final DepositStatus status;
  final String? paymentMethodLabel;
  final String? maskedInstrument;
  final Uri? authorizationUrl;
  final String? failureReason;
  final DateTime? createdAt;
  final DateTime? updatedAt;
  final int? availableBalanceMinorUnits;
  final String? transactionId;

  bool get isTerminal =>
      status == DepositStatus.successful || status == DepositStatus.failed;

  String get maskedReference => maskReference(reference);

  DepositIntentData copyWith({DepositStatus? status, Uri? authorizationUrl}) =>
      DepositIntentData(
        reference: reference,
        amountMinorUnits: amountMinorUnits,
        feeMinorUnits: feeMinorUnits,
        totalMinorUnits: totalMinorUnits,
        currency: currency,
        status: status ?? this.status,
        paymentMethodLabel: paymentMethodLabel,
        maskedInstrument: maskedInstrument,
        authorizationUrl: authorizationUrl ?? this.authorizationUrl,
        failureReason: failureReason,
        createdAt: createdAt,
        updatedAt: updatedAt,
        availableBalanceMinorUnits: availableBalanceMinorUnits,
        transactionId: transactionId,
      );

  static DepositIntentData? tryFromServer(
    dynamic value, {
    DepositQuote? quote,
    DepositPaymentMethod? method,
    DepositIntentData? previous,
    bool allowImplicitPending = false,
  }) {
    if (value is! Map) return null;
    final outer = Map<String, dynamic>.from(value);
    final raw = outer['deposit'] is Map
        ? Map<String, dynamic>.from(outer['deposit'] as Map)
        : outer['intent'] is Map
        ? Map<String, dynamic>.from(outer['intent'] as Map)
        : outer;
    final reference = _text(raw['reference'] ?? raw['depositReference']);
    final amount =
        _minorUnits(raw['amountMinorUnits']) ??
        quote?.amountMinorUnits ??
        previous?.amountMinorUnits;
    final currency =
        _text(raw['currency']) ?? quote?.currency ?? previous?.currency;
    final status = _status(raw['status'] ?? raw['depositStatus']);
    if (reference == null || amount == null || currency == null) return null;
    if (status == null && !allowImplicitPending) return null;
    return DepositIntentData(
      reference: reference,
      amountMinorUnits: amount,
      feeMinorUnits:
          _minorUnits(raw['feeMinorUnits']) ??
          quote?.feeMinorUnits ??
          previous?.feeMinorUnits,
      totalMinorUnits:
          _minorUnits(raw['totalMinorUnits']) ??
          quote?.totalMinorUnits ??
          previous?.totalMinorUnits,
      currency: currency.toUpperCase(),
      status: status ?? DepositStatus.pending,
      paymentMethodLabel:
          _text(raw['paymentMethodLabel']) ??
          method?.label ??
          previous?.paymentMethodLabel,
      maskedInstrument: _maskInstrument(
        _text(raw['maskedInstrument']) ??
            method?.maskedInstrument ??
            previous?.maskedInstrument,
      ),
      authorizationUrl: _safeCheckoutUri(
        _text(raw['authorizationUrl'] ?? raw['checkoutUrl']),
      ),
      failureReason: _text(raw['failureReason'] ?? raw['reason']),
      createdAt: _date(raw['createdAt']) ?? previous?.createdAt,
      updatedAt: _date(raw['updatedAt'] ?? raw['confirmedAt']),
      availableBalanceMinorUnits: _minorUnits(
        raw['availableBalanceMinorUnits'],
      ),
      transactionId: _text(raw['transactionId']),
    );
  }
}

String formatDepositMoney(int? minorUnits, String? currency) {
  if (minorUnits == null || currency == null) return 'Unavailable';
  if (currency.toUpperCase() == 'NGN') return Money(minorUnits).format();
  final absolute = minorUnits.abs();
  final units = (absolute ~/ 100).toString();
  final decimals = (absolute % 100).toString().padLeft(2, '0');
  return '${minorUnits < 0 ? '-' : ''}${currency.toUpperCase()} $units.$decimals';
}

String maskReference(String value) {
  final clean = value.trim();
  if (clean.length <= 4) return '•' * clean.length;
  final visible = clean.substring(clean.length - 4);
  return '••••$visible';
}

String? _maskInstrument(String? value) {
  if (value == null) return null;
  final clean = value.trim();
  if (clean.isEmpty) return null;
  if (clean.contains('•') || clean.contains('*')) return clean;
  final digits = clean.replaceAll(RegExp(r'\D'), '');
  if (digits.length < 4) return 'Protected payment method';
  return '•••• ${digits.substring(digits.length - 4)}';
}

DepositStatus? _status(dynamic value) {
  final status = _text(value)?.toLowerCase();
  return switch (status) {
    'processing' || 'created' || 'initiated' => DepositStatus.processing,
    'pending' || 'awaiting_confirmation' => DepositStatus.pending,
    'successful' ||
    'success' ||
    'completed' ||
    'confirmed' => DepositStatus.successful,
    'failed' || 'declined' || 'cancelled' => DepositStatus.failed,
    _ => null,
  };
}

Uri? _safeCheckoutUri(String? value) {
  if (value == null) return null;
  final uri = Uri.tryParse(value);
  if (uri == null || !uri.hasAuthority) return null;
  if (uri.scheme != 'https' && uri.scheme != 'http') return null;
  return uri;
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

DateTime? _date(dynamic value) => DateTime.tryParse(value?.toString() ?? '');
