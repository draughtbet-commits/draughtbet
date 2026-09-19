enum GameRejectionCode {
  illegalMove,
  mandatoryCaptureRequired,
  maxCaptureRequired,
  notYourTurn,
  stateVersionConflict,
  matchNotActive,
  unknown,
}

class MoveRejection {
  const MoveRejection({
    required this.code,
    required this.rawCode,
    this.clientMoveId,
    this.stateVersion,
  });

  final GameRejectionCode code;
  final String rawCode;
  final String? clientMoveId;
  final int? stateVersion;

  bool get requiresResync =>
      code == GameRejectionCode.stateVersionConflict ||
      code == GameRejectionCode.unknown;

  String get title => switch (code) {
    GameRejectionCode.mandatoryCaptureRequired => 'CAPTURE REQUIRED',
    GameRejectionCode.maxCaptureRequired => 'MAXIMUM CAPTURE REQUIRED',
    GameRejectionCode.notYourTurn => 'OPPONENT’S TURN',
    GameRejectionCode.stateVersionConflict => 'STATE RESYNC',
    GameRejectionCode.matchNotActive => 'MATCH NOT ACTIVE',
    GameRejectionCode.illegalMove => 'ILLEGAL MOVE',
    GameRejectionCode.unknown => 'MOVE NOT ACCEPTED',
  };

  String get message => switch (code) {
    GameRejectionCode.mandatoryCaptureRequired =>
      'A capture is available. Select a highlighted capturing move.',
    GameRejectionCode.maxCaptureRequired =>
      'Choose the highlighted path that captures the most pieces.',
    GameRejectionCode.notYourTurn =>
      'Wait for the server to confirm that it is your turn.',
    GameRejectionCode.stateVersionConflict =>
      'Your board was out of date. Loading the canonical match state.',
    GameRejectionCode.matchNotActive =>
      'This match is no longer accepting moves.',
    GameRejectionCode.illegalMove =>
      'That move is not legal in the current server state.',
    GameRejectionCode.unknown =>
      'The server rejected this move. Refreshing the match state.',
  };

  factory MoveRejection.fromServer(Map<String, dynamic> json) {
    final raw = (json['code'] ?? json['reason'] ?? 'UNKNOWN')
        .toString()
        .trim()
        .toUpperCase();
    final code = switch (raw) {
      'ILLEGAL_MOVE' => GameRejectionCode.illegalMove,
      'MANDATORY_CAPTURE_REQUIRED' ||
      'CAPTURE_REQUIRED' => GameRejectionCode.mandatoryCaptureRequired,
      'MAX_CAPTURE_REQUIRED' => GameRejectionCode.maxCaptureRequired,
      'NOT_YOUR_TURN' => GameRejectionCode.notYourTurn,
      'STATE_VERSION_CONFLICT' ||
      'VERSION_MISMATCH' => GameRejectionCode.stateVersionConflict,
      'MATCH_NOT_ACTIVE' || 'MATCH_ENDED' => GameRejectionCode.matchNotActive,
      _ => GameRejectionCode.unknown,
    };
    return MoveRejection(
      code: code,
      rawCode: raw,
      clientMoveId: json['clientMoveId']?.toString(),
      stateVersion: int.tryParse(json['stateVersion']?.toString() ?? ''),
    );
  }
}

class DrawOffer {
  const DrawOffer({required this.offerId, this.opponentName});

  final String offerId;
  final String? opponentName;

  factory DrawOffer.fromServer(Map<String, dynamic> json) => DrawOffer(
    offerId: json['offerId']?.toString() ?? '',
    opponentName: json['opponentName']?.toString(),
  );
}
