enum WalletLoadPhase { initial, loading, ready, empty, unavailable, failure }

enum WalletEntryKind { deposit, withdrawal, stake, payout, refund, other }

class WalletProjection {
  const WalletProjection({
    required this.availableMinorUnits,
    required this.currency,
    this.lockedMinorUnits,
    this.pendingMinorUnits,
    this.verifiedAt,
    this.isStale = false,
    this.lockedFunds = const [],
  });

  final int availableMinorUnits;
  final String currency;
  final int? lockedMinorUnits;
  final int? pendingMinorUnits;
  final DateTime? verifiedAt;
  final bool isStale;
  final List<LockedFundItem> lockedFunds;

  factory WalletProjection.fromJson(Map<String, dynamic> json) {
    final balance = json['balance'];
    if (balance is! Map) {
      throw const FormatException('Missing authoritative balance object');
    }
    final nested = Map<String, dynamic>.from(balance);
    final available = _parseMinorUnits(nested['balanceMinorUnits']);
    if (available == null) {
      throw const FormatException('Missing authoritative available balance');
    }
    final currency = nested['currency']?.toString().trim() ?? '';
    if (currency.isEmpty) {
      throw const FormatException('Missing authoritative balance currency');
    }
    int? optionalMinor(String key) => _parseMinorUnits(json[key]);
    return WalletProjection(
      availableMinorUnits: available,
      currency: currency,
      lockedMinorUnits: optionalMinor('lockedBalanceMinorUnits'),
      pendingMinorUnits: optionalMinor('pendingBalanceMinorUnits'),
      verifiedAt: DateTime.tryParse(json['verifiedAt']?.toString() ?? ''),
      isStale: json['stale'] == true,
      lockedFunds: (json['lockedFunds'] is List)
          ? (json['lockedFunds'] as List)
                .whereType<Map>()
                .map(
                  (item) =>
                      LockedFundItem.fromJson(Map<String, dynamic>.from(item)),
                )
                .toList(growable: false)
          : const [],
    );
  }
}

class LockedFundItem {
  const LockedFundItem({
    required this.matchId,
    required this.amountMinorUnits,
    required this.status,
    this.opponentName,
  });

  final String matchId;
  final int amountMinorUnits;
  final String status;
  final String? opponentName;

  factory LockedFundItem.fromJson(Map<String, dynamic> json) => LockedFundItem(
    matchId: json['matchId']?.toString() ?? '',
    amountMinorUnits:
        int.tryParse(json['amountMinorUnits']?.toString() ?? '') ?? 0,
    status: json['status']?.toString() ?? 'PENDING',
    opponentName: json['opponentName']?.toString(),
  );
}

class WalletEntry {
  const WalletEntry({
    required this.id,
    required this.kind,
    required this.amountMinorUnits,
    required this.status,
    required this.createdAt,
    this.reference,
    this.relatedMatchId,
    this.feeMinorUnits,
    this.balanceImpactMinorUnits,
    this.description,
  });

  final String id;
  final WalletEntryKind kind;
  final int amountMinorUnits;
  final String status;
  final DateTime createdAt;
  final String? reference;
  final String? relatedMatchId;
  final int? feeMinorUnits;
  final int? balanceImpactMinorUnits;
  final String? description;

  bool get isCredit =>
      kind == WalletEntryKind.deposit ||
      kind == WalletEntryKind.payout ||
      kind == WalletEntryKind.refund;

  String get authoritativeReference {
    final supplied = reference?.trim();
    return supplied == null || supplied.isEmpty ? id : supplied;
  }

  factory WalletEntry.fromJson(Map<String, dynamic> json) {
    final id = json['id']?.toString().trim() ?? '';
    if (id.isEmpty) throw const FormatException('Missing transaction id');
    final type = json['type']?.toString().toUpperCase() ?? '';
    if (type.isEmpty) throw const FormatException('Missing transaction type');
    final kind = switch (type) {
      'DEPOSIT' => WalletEntryKind.deposit,
      'WITHDRAWAL' => WalletEntryKind.withdrawal,
      'STAKE' => WalletEntryKind.stake,
      'PAYOUT' => WalletEntryKind.payout,
      'REFUND' => WalletEntryKind.refund,
      _ => WalletEntryKind.other,
    };
    int? optionalMinor(String key) => int.tryParse(json[key]?.toString() ?? '');
    final amountMinorUnits = optionalMinor('amountMinorUnits');
    if (amountMinorUnits == null) {
      throw const FormatException('Missing transaction amount');
    }
    final status = json['status']?.toString().trim() ?? '';
    if (status.isEmpty) {
      throw const FormatException('Missing transaction status');
    }
    final createdAt = DateTime.tryParse(json['createdAt']?.toString() ?? '');
    if (createdAt == null) {
      throw const FormatException('Missing transaction timestamp');
    }
    return WalletEntry(
      id: id,
      kind: kind,
      amountMinorUnits: amountMinorUnits,
      status: status,
      createdAt: createdAt,
      reference: json['reference']?.toString(),
      relatedMatchId: json['relatedMatchId']?.toString(),
      feeMinorUnits: optionalMinor('feeMinorUnits'),
      balanceImpactMinorUnits: optionalMinor('balanceImpactMinorUnits'),
      description: json['description']?.toString(),
    );
  }
}

int? _parseMinorUnits(Object? value) {
  if (value is int) return value;
  if (value is num && value.isFinite && value == value.truncateToDouble()) {
    return value.toInt();
  }
  if (value is String && RegExp(r'^-?\d+$').hasMatch(value.trim())) {
    return int.tryParse(value.trim());
  }
  return null;
}

class WalletFilter {
  const WalletFilter({this.kind, this.status});

  final WalletEntryKind? kind;
  final String? status;

  bool accepts(WalletEntry entry) {
    if (kind != null && entry.kind != kind) return false;
    if (status != null && entry.status.toUpperCase() != status) return false;
    return true;
  }
}
