enum WalletLoadPhase { initial, loading, ready, empty, unavailable, failure }

enum WalletEntryKind { deposit, withdrawal, stake, payout, refund, other }

class WalletProjection {
  const WalletProjection({
    required this.availableMinorUnits,
    this.lockedMinorUnits,
    this.pendingMinorUnits,
    this.verifiedAt,
    this.isStale = false,
    this.lockedFunds = const [],
  });

  final int availableMinorUnits;
  final int? lockedMinorUnits;
  final int? pendingMinorUnits;
  final DateTime? verifiedAt;
  final bool isStale;
  final List<LockedFundItem> lockedFunds;

  factory WalletProjection.fromJson(Map<String, dynamic> json) {
    int? optionalMinor(String key) => int.tryParse(json[key]?.toString() ?? '');
    final available =
        optionalMinor('availableBalanceMinorUnits') ??
        optionalMinor('balanceMinorUnits') ??
        optionalMinor('balance');
    if (available == null) {
      throw const FormatException('Missing authoritative available balance');
    }
    return WalletProjection(
      availableMinorUnits: available,
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

  factory WalletEntry.fromJson(Map<String, dynamic> json) {
    final type = json['type']?.toString().toUpperCase() ?? 'OTHER';
    final kind = switch (type) {
      'DEPOSIT' => WalletEntryKind.deposit,
      'WITHDRAWAL' => WalletEntryKind.withdrawal,
      'STAKE' || 'STAKE_DEBIT' => WalletEntryKind.stake,
      'PAYOUT' || 'WINNINGS' => WalletEntryKind.payout,
      'REFUND' => WalletEntryKind.refund,
      _ => WalletEntryKind.other,
    };
    int? optionalMinor(String key) => int.tryParse(json[key]?.toString() ?? '');
    return WalletEntry(
      id: json['id']?.toString() ?? '',
      kind: kind,
      amountMinorUnits: optionalMinor('amountMinorUnits') ?? 0,
      status: json['status']?.toString() ?? 'UNKNOWN',
      createdAt:
          DateTime.tryParse(json['createdAt']?.toString() ?? '') ??
          DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
      reference: json['reference']?.toString(),
      relatedMatchId: json['relatedMatchId']?.toString(),
      feeMinorUnits: optionalMinor('feeMinorUnits'),
      balanceImpactMinorUnits: optionalMinor('balanceImpactMinorUnits'),
      description: json['description']?.toString(),
    );
  }
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
