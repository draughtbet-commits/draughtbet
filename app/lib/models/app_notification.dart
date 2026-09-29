enum NotificationCategory { matches, disputes, system }

class AppNotification {
  const AppNotification({
    required this.id,
    required this.type,
    required this.title,
    required this.message,
    required this.isRead,
    required this.createdAt,
    this.link,
    this.matchId,
  });

  final String id;
  final String type;
  final String title;
  final String message;
  final String? link;
  final String? matchId;
  final bool isRead;
  final DateTime createdAt;

  NotificationCategory get category {
    final normalized = type.toUpperCase();
    if (normalized.contains('DISPUTE') ||
        normalized.contains('REPORT') ||
        normalized.contains('SUPPORT')) {
      return NotificationCategory.disputes;
    }
    if (normalized.contains('MATCH') ||
        normalized.contains('CALLOUT') ||
        normalized.contains('OPPONENT') ||
        normalized.contains('TIER')) {
      return NotificationCategory.matches;
    }
    return NotificationCategory.system;
  }

  bool get hasSafeLink {
    final value = link?.trim();
    return value != null &&
        value.startsWith('/') &&
        !value.startsWith('//') &&
        !value.contains('://');
  }

  AppNotification copyWith({bool? isRead}) => AppNotification(
    id: id,
    type: type,
    title: title,
    message: message,
    link: link,
    matchId: matchId,
    isRead: isRead ?? this.isRead,
    createdAt: createdAt,
  );

  static AppNotification? tryFromJson(Object? raw) {
    if (raw is! Map) return null;
    final json = Map<String, dynamic>.from(raw);
    final id = json['id']?.toString().trim() ?? '';
    final type = json['type']?.toString().trim() ?? '';
    final title = json['title']?.toString().trim() ?? '';
    final message = json['message']?.toString().trim() ?? '';
    final createdAt = DateTime.tryParse(json['createdAt']?.toString() ?? '');
    if (id.isEmpty ||
        type.isEmpty ||
        title.isEmpty ||
        message.isEmpty ||
        createdAt == null ||
        json['isRead'] is! bool) {
      return null;
    }
    final link = json['link']?.toString().trim();
    final matchId = json['matchId']?.toString().trim();
    return AppNotification(
      id: id,
      type: type,
      title: title,
      message: message,
      link: link == null || link.isEmpty ? null : link,
      matchId: matchId == null || matchId.isEmpty ? null : matchId,
      isRead: json['isRead'] as bool,
      createdAt: createdAt.toUtc(),
    );
  }
}
