/// Longest single chat message the server will accept. Mirrors
/// `MAX_CHAT_TEXT_LENGTH` in the backend payload guard so the client rejects an
/// over-long message before it spends a socket event on it.
const int kMaxChatTextLength = 500;

/// A single in-match chat message.
///
/// Chat is real-time only: the server fans `chat.message` out to the match room
/// and never persists it, so there is no history to load and nothing to replay
/// after a reconnect. The id is the server-issued `messageId`, used to key the
/// list and drop a duplicate delivery.
class MatchChatMessage {
  const MatchChatMessage({
    required this.id,
    required this.senderId,
    required this.text,
    required this.sentAtMs,
  });

  final String id;
  final String senderId;
  final String text;
  final int sentAtMs;

  bool isMine(String? currentUserId) =>
      currentUserId != null && currentUserId == senderId;

  static MatchChatMessage? tryFromServer(Map<String, dynamic> data) {
    final id = data['messageId']?.toString() ?? '';
    final senderId = data['senderId']?.toString() ?? '';
    final text = data['text']?.toString() ?? '';
    if (id.isEmpty || senderId.isEmpty || text.isEmpty) return null;
    return MatchChatMessage(
      id: id,
      senderId: senderId,
      text: text,
      sentAtMs: int.tryParse(data['sentAtMs']?.toString() ?? '') ??
          DateTime.now().millisecondsSinceEpoch,
    );
  }
}
