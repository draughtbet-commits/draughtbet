class Callout {
  final String id;
  final String challengerId;
  final String challengerName;
  final int stakeMinorUnits;
  final String tier;
  final String status;
  final DateTime expiresAt;

  Callout({
    required this.id,
    required this.challengerId,
    required this.challengerName,
    required this.stakeMinorUnits,
    required this.tier,
    required this.status,
    required this.expiresAt,
  });

  factory Callout.fromJson(Map<String, dynamic> json) {
    return Callout(
      id: json['id'],
      challengerId: json['challengerId'],
      challengerName: json['challenger']?['displayName'] ?? json['challengerName'] ?? 'Unknown',
      stakeMinorUnits: int.tryParse(json['stakeMinorUnits'].toString()) ?? 0,
      tier: json['tier'],
      status: json['status'],
      expiresAt: DateTime.parse(json['expiresAt']).toLocal(),
    );
  }
}
