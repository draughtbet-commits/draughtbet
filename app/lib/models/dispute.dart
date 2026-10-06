enum DisputeStatus { open, underReview, resolved, dismissed, unavailable }

enum DisputeReason {
  suspectedCheating(
    'SUSPECTED_CHEATING',
    'Suspected cheating',
    'Use of external tools or unfair assistance.',
  ),
  inappropriateBehaviour(
    'INAPPROPRIATE_BEHAVIOUR',
    'Inappropriate behaviour',
    'Abusive language or harassment.',
  ),
  unexpectedDisconnects(
    'UNEXPECTED_DISCONNECTS',
    'Unexpected disconnects',
    'Player left multiple times.',
  ),
  incorrectResult(
    'INCORRECT_RESULT',
    'Incorrect result',
    'Match result seems wrong.',
  ),
  other('OTHER', 'Other', 'Please provide additional details.');

  const DisputeReason(this.wireValue, this.label, this.description);

  final String wireValue;
  final String label;
  final String description;
}

class DisputeMatchSummary {
  const DisputeMatchSummary({
    required this.matchId,
    required this.opponentName,
    this.opponentAvatarId = 'avatar_01',
    this.playedAt,
  });

  final String matchId;
  final String opponentName;
  final String opponentAvatarId;
  final DateTime? playedAt;
}

class DisputeTimelineItem {
  const DisputeTimelineItem({
    required this.label,
    required this.at,
    this.detail,
    this.complete = true,
  });

  final String label;
  final DateTime at;
  final String? detail;
  final bool complete;
}

class DisputeCaseData {
  const DisputeCaseData({
    required this.id,
    required this.matchId,
    required this.status,
    required this.reason,
    required this.createdAt,
    required this.updatedAt,
    this.resolution,
    this.timeline = const [],
  });

  final String id;
  final String matchId;
  final DisputeStatus status;
  final String reason;
  final DateTime createdAt;
  final DateTime updatedAt;
  final String? resolution;
  final List<DisputeTimelineItem> timeline;

  String get maskedReference {
    if (id.length <= 6) return id;
    return '#${id.substring(0, 3).toUpperCase()}•••${id.substring(id.length - 3).toUpperCase()}';
  }

  static DisputeCaseData? tryFromServer(dynamic value) {
    if (value is! Map) return null;
    final outer = Map<String, dynamic>.from(value);
    final candidate = outer['dispute'] ?? outer['disputeCase'] ?? outer['data'];
    if (candidate is! Map) return null;
    final raw = Map<String, dynamic>.from(candidate);
    final id = raw['id']?.toString().trim() ?? '';
    final matchId = raw['matchId']?.toString().trim() ?? '';
    final reason = raw['reason']?.toString().trim() ?? '';
    final status = disputeStatusFromWire(raw['status']);
    final createdAt = DateTime.tryParse(raw['createdAt']?.toString() ?? '');
    final updatedAt = DateTime.tryParse(raw['updatedAt']?.toString() ?? '');
    if (id.isEmpty ||
        matchId.isEmpty ||
        reason.isEmpty ||
        status == DisputeStatus.unavailable ||
        createdAt == null ||
        updatedAt == null) {
      return null;
    }

    final rawTimeline = raw['timeline'];
    final timeline = rawTimeline is List
        ? rawTimeline
              .whereType<Map>()
              .map((entry) {
                final item = Map<String, dynamic>.from(entry);
                final label = item['label']?.toString().trim() ?? '';
                final at = DateTime.tryParse(item['at']?.toString() ?? '');
                if (label.isEmpty || at == null) return null;
                return DisputeTimelineItem(
                  label: label,
                  at: at,
                  detail: item['detail']?.toString(),
                  complete: item['complete'] != false,
                );
              })
              .whereType<DisputeTimelineItem>()
              .toList(growable: false)
        : const <DisputeTimelineItem>[];

    return DisputeCaseData(
      id: id,
      matchId: matchId,
      status: status,
      reason: reason,
      createdAt: createdAt,
      updatedAt: updatedAt,
      resolution: raw['resolution']?.toString(),
      timeline: timeline,
    );
  }

  /// Builds a case from the player submit response. That response only
  /// carries `disputeId`, `status`, `matchId` and `category`, so timestamps
  /// are the creation instant and the timeline stays empty until a player
  /// status read exists. The reason is rendered from the local label because
  /// the server keeps the free-text message in `reason` and the code in
  /// `category`, which would read as a raw enum if shown directly.
  static DisputeCaseData? tryFromSubmit(
    dynamic value, {
    required String matchId,
    required String reasonLabel,
  }) {
    if (value is! Map) return null;
    final outer = Map<String, dynamic>.from(value);
    final candidate = outer['dispute'] ?? outer['disputeCase'] ?? outer['data'];
    final raw = candidate is Map ? Map<String, dynamic>.from(candidate) : outer;
    final id = (raw['disputeId'] ?? raw['id'])?.toString().trim() ?? '';
    final serverMatchId = raw['matchId']?.toString().trim() ?? '';
    final status = disputeStatusFromWire(raw['status']);
    if (id.isEmpty || status == DisputeStatus.unavailable) return null;
    final now = DateTime.now();
    return DisputeCaseData(
      id: id,
      matchId: serverMatchId.isEmpty ? matchId : serverMatchId,
      status: status,
      reason: reasonLabel,
      createdAt: now,
      updatedAt: now,
    );
  }
}

DisputeStatus disputeStatusFromWire(dynamic value) =>
    switch (value?.toString().trim().toUpperCase()) {
      'OPEN' => DisputeStatus.open,
      'UNDER_REVIEW' => DisputeStatus.underReview,
      'RESOLVED' => DisputeStatus.resolved,
      'DISMISSED' => DisputeStatus.dismissed,
      _ => DisputeStatus.unavailable,
    };
