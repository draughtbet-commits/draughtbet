import 'package:intl/intl.dart';

enum LoadPhase { initial, loading, ready, empty, error, offline }

enum MatchActionPhase { idle, submitting, succeeded, failed, unknown }

enum SearchPhase {
  idle,
  searching,
  found,
  timeout,
  cancelling,
  cancelled,
  degraded,
}

enum SettlementPhase { pending, confirmed, delayed, failed }

enum ResultKind {
  victory,
  defeat,
  draw,
  timeout,
  resignation,
  disconnectForfeit,
  cancelled,
}

enum MatchLifecyclePhase {
  unavailable,
  incomingChallenge,
  challengeSent,
  challengeExpired,
  privateRoom,
  insufficientBalance,
  eligibilityBlocked,
  lockingStake,
  waitingOpponentStake,
  readyCheck,
  waitingOpponentReady,
  readyTimeout,
  opponentDisconnected,
}

enum AuthoritativeProgress { pending, confirmed, failed, unknown }

class MatchQuote {
  const MatchQuote({
    required this.reference,
    required this.expiresAt,
    required this.stakeMinorUnits,
    required this.opponentStakeMinorUnits,
    required this.platformFeeMinorUnits,
    required this.totalPrizeMinorUnits,
  });

  final String reference;
  final DateTime expiresAt;
  final int stakeMinorUnits;
  final int opponentStakeMinorUnits;
  final int platformFeeMinorUnits;
  final int totalPrizeMinorUnits;
}

class MatchLifecycleSnapshot {
  const MatchLifecycleSnapshot({
    required this.phase,
    required this.terms,
    this.matchId,
    this.roomCode,
    this.opponent,
    this.quote,
    this.availableBalanceMinorUnits,
    this.limitMinorUnits,
    this.reason,
    this.playerStake = AuthoritativeProgress.pending,
    this.opponentStake = AuthoritativeProgress.pending,
    this.playerReady = AuthoritativeProgress.pending,
    this.opponentReady = AuthoritativeProgress.pending,
    this.release = AuthoritativeProgress.unknown,
    this.deadline,
  });

  final MatchLifecyclePhase phase;
  final MatchTerms terms;
  final String? matchId;
  final String? roomCode;
  final MatchPlayer? opponent;
  final MatchQuote? quote;
  final int? availableBalanceMinorUnits;
  final int? limitMinorUnits;
  final String? reason;
  final AuthoritativeProgress playerStake;
  final AuthoritativeProgress opponentStake;
  final AuthoritativeProgress playerReady;
  final AuthoritativeProgress opponentReady;
  final AuthoritativeProgress release;
  final DateTime? deadline;
}

class Money {
  const Money(this.minorUnits);

  final int minorUnits;

  String format({bool showKobo = false}) {
    final negative = minorUnits < 0;
    final absolute = minorUnits.abs();
    final naira = absolute ~/ 100;
    final kobo = absolute % 100;
    final whole = NumberFormat.decimalPattern('en_NG').format(naira);
    final fraction = showKobo || kobo != 0
        ? '.${kobo.toString().padLeft(2, '0')}'
        : '';
    return '${negative ? '-' : ''}₦$whole$fraction';
  }
}

class MatchPlayer {
  const MatchPlayer({
    required this.id,
    required this.name,
    this.avatarId = 'avatar_01',
    this.rank,
    this.rating,
    this.winRate,
    this.level,
  });

  final String id;
  final String name;
  final String avatarId;
  final String? rank;
  final int? rating;
  final int? winRate;
  final int? level;
}

class MatchTerms {
  const MatchTerms({
    required this.stakeMinorUnits,
    this.opponentStakeMinorUnits,
    this.platformFeeMinorUnits,
    this.totalPrizeMinorUnits,
    this.timeControl = '10 minutes',
    this.gameType = 'Classic',
    this.board = '10×10 (International)',
    this.visibility = 'Anyone',
    this.privateRoom = false,
    this.serverQuoted = false,
  });

  final int stakeMinorUnits;
  final int? opponentStakeMinorUnits;
  final int? platformFeeMinorUnits;
  final int? totalPrizeMinorUnits;
  final String timeControl;
  final String gameType;
  final String board;
  final String visibility;
  final bool privateRoom;
  final bool serverQuoted;

  MatchTerms copyWith({
    int? stakeMinorUnits,
    int? opponentStakeMinorUnits,
    int? platformFeeMinorUnits,
    int? totalPrizeMinorUnits,
    String? timeControl,
    String? gameType,
    String? board,
    String? visibility,
    bool? privateRoom,
    bool? serverQuoted,
  }) {
    return MatchTerms(
      stakeMinorUnits: stakeMinorUnits ?? this.stakeMinorUnits,
      opponentStakeMinorUnits:
          opponentStakeMinorUnits ?? this.opponentStakeMinorUnits,
      platformFeeMinorUnits:
          platformFeeMinorUnits ?? this.platformFeeMinorUnits,
      totalPrizeMinorUnits: totalPrizeMinorUnits ?? this.totalPrizeMinorUnits,
      timeControl: timeControl ?? this.timeControl,
      gameType: gameType ?? this.gameType,
      board: board ?? this.board,
      visibility: visibility ?? this.visibility,
      privateRoom: privateRoom ?? this.privateRoom,
      serverQuoted: serverQuoted ?? this.serverQuoted,
    );
  }
}

class OpenMatch {
  const OpenMatch({
    required this.id,
    required this.host,
    required this.terms,
    this.expiresAt,
  });

  final String id;
  final MatchPlayer host;
  final MatchTerms terms;
  final DateTime? expiresAt;

  bool get isStale => expiresAt != null && expiresAt!.isBefore(DateTime.now());
}

enum MatchEntryKind { quick, openMatch, created }

class MatchFlowIntent {
  const MatchFlowIntent({
    required this.kind,
    required this.terms,
    this.openMatchId,
    this.opponent,
  });

  final MatchEntryKind kind;
  final MatchTerms terms;
  final String? openMatchId;
  final MatchPlayer? opponent;
}

class MatchResultViewData {
  const MatchResultViewData({
    required this.kind,
    required this.opponent,
    this.terms,
    this.matchId,
    this.reason = 'Match completed',
    this.settlement = SettlementPhase.pending,
    this.payoutMinorUnits,
    this.refundMinorUnits,
    this.settlementReference,
    this.receiptReference,
    this.endedAt,
    this.serverVerified = false,
  });

  final ResultKind kind;
  final MatchPlayer opponent;
  final MatchTerms? terms;
  final String? matchId;
  final String reason;
  final SettlementPhase settlement;
  final int? payoutMinorUnits;
  final int? refundMinorUnits;
  final String? settlementReference;
  final String? receiptReference;
  final DateTime? endedAt;

  /// True only when this projection came from an authoritative server event
  /// or read response. Tests may opt in explicitly for deterministic fixtures.
  final bool serverVerified;

  MatchResultViewData copyWith({
    SettlementPhase? settlement,
    int? payoutMinorUnits,
    int? refundMinorUnits,
    String? settlementReference,
    String? receiptReference,
    DateTime? endedAt,
    bool? serverVerified,
  }) {
    return MatchResultViewData(
      kind: kind,
      opponent: opponent,
      terms: terms,
      matchId: matchId,
      reason: reason,
      settlement: settlement ?? this.settlement,
      payoutMinorUnits: payoutMinorUnits ?? this.payoutMinorUnits,
      refundMinorUnits: refundMinorUnits ?? this.refundMinorUnits,
      settlementReference: settlementReference ?? this.settlementReference,
      receiptReference: receiptReference ?? this.receiptReference,
      endedAt: endedAt ?? this.endedAt,
      serverVerified: serverVerified ?? this.serverVerified,
    );
  }

  /// Parses only explicit server-owned result and money fields. A payload that
  /// omits the authoritative result kind is rejected. Opponent presentation
  /// may be supplied from the already-authoritative match participants.
  static MatchResultViewData? tryFromServer(
    Map<dynamic, dynamic> raw, {
    MatchPlayer? fallbackOpponent,
  }) {
    final body = Map<String, dynamic>.from(raw);
    final resultBody = body['result'] is Map
        ? Map<String, dynamic>.from(body['result'] as Map)
        : body;
    final kind = _parseResultKind(
      resultBody['kind'] ??
          resultBody['resultKind'] ??
          resultBody['outcome'] ??
          (body['result'] is String ? body['result'] : null),
    );
    final opponentBody = resultBody['opponent'];
    if (kind == null) return null;
    MatchPlayer? opponent = fallbackOpponent;
    if (opponentBody is Map) {
      final opponentJson = Map<String, dynamic>.from(opponentBody);
      final opponentId = opponentJson['id']?.toString().trim() ?? '';
      final opponentName =
          (opponentJson['username'] ?? opponentJson['name'])
              ?.toString()
              .trim() ??
          '';
      if (opponentId.isNotEmpty && opponentName.isNotEmpty) {
        opponent = MatchPlayer(
          id: opponentId,
          name: opponentName,
          avatarId: opponentJson['avatarId']?.toString() ?? 'avatar_01',
          rank: opponentJson['rank']?.toString(),
          rating: int.tryParse(opponentJson['rating']?.toString() ?? ''),
        );
      }
    }
    if (opponent == null) return null;

    final termsBody = resultBody['terms'];
    final termsJson = termsBody is Map
        ? Map<String, dynamic>.from(termsBody)
        : const <String, dynamic>{};
    final stake = _minorUnits(
      termsJson['stakeMinorUnits'] ?? resultBody['stakeMinor'],
    );
    final terms = stake == null
        ? null
        : MatchTerms(
            stakeMinorUnits: stake,
            opponentStakeMinorUnits: _minorUnits(
              termsJson['opponentStakeMinorUnits'],
            ),
            platformFeeMinorUnits: _minorUnits(
              termsJson['platformFeeMinorUnits'],
            ),
            totalPrizeMinorUnits: _minorUnits(
              termsJson['totalPotMinorUnits'] ??
                  termsJson['totalPrizeMinorUnits'],
            ),
            timeControl:
                termsJson['timeControl']?.toString() ?? 'Server unavailable',
            gameType: termsJson['gameType']?.toString() ?? 'Server unavailable',
            board: termsJson['board']?.toString() ?? 'Server unavailable',
            serverQuoted: true,
          );
    final settlementBody = resultBody['settlement'];
    final settlementJson = settlementBody is Map
        ? Map<String, dynamic>.from(settlementBody)
        : const <String, dynamic>{};

    return MatchResultViewData(
      kind: kind,
      opponent: opponent,
      terms: terms,
      matchId: (resultBody['matchId'] ?? body['matchId'])?.toString(),
      reason:
          (resultBody['reason'] ??
                  resultBody['terminalReason'] ??
                  body['terminalReason'])
              ?.toString() ??
          'Result confirmed by server',
      settlement: _parseSettlementPhase(
        settlementJson['status'] ??
            resultBody['settlementStatus'] ??
            body['settlementStatus'],
      ),
      payoutMinorUnits: _minorUnits(
        settlementJson['payoutMinorUnits'] ??
            resultBody['payoutMinorUnits'] ??
            resultBody['payoutMinor'] ??
            body['payoutMinor'],
      ),
      refundMinorUnits: _minorUnits(
        settlementJson['refundMinorUnits'] ?? resultBody['refundMinorUnits'],
      ),
      settlementReference:
          (settlementJson['reference'] ?? resultBody['settlementReference'])
              ?.toString(),
      receiptReference:
          (resultBody['receiptReference'] ?? settlementJson['receiptReference'])
              ?.toString(),
      endedAt: DateTime.tryParse(resultBody['endedAt']?.toString() ?? ''),
      serverVerified: true,
    );
  }

  /// Adapts the active backend's post-settlement `match_ended` event.
  ///
  /// The backend emits this only after its settlement transaction completes.
  /// The client maps the authoritative winner to the current player's view,
  /// but never calculates a winner or payout. The event does not expose an
  /// opponent profile or receipt/ledger identifiers, so those remain absent.
  static MatchResultViewData? tryFromActiveMatchEnded(
    Map<dynamic, dynamic> raw, {
    required String matchId,
    required String currentUserId,
    required String opponentId,
  }) {
    final body = Map<String, dynamic>.from(raw);
    final winnerId = body['winnerId']?.toString().trim();
    final reason = body['reason']?.toString().trim();
    final payout = _minorUnits(body['payout']);
    if (matchId.trim().isEmpty ||
        currentUserId.trim().isEmpty ||
        opponentId.trim().isEmpty ||
        reason == null ||
        reason.isEmpty ||
        payout == null) {
      return null;
    }

    final normalizedReason = reason.toLowerCase();
    final isDraw = winnerId == null || winnerId.isEmpty;
    final playerWon = !isDraw && winnerId == currentUserId;
    final kind = isDraw
        ? ResultKind.draw
        : normalizedReason == 'resign' && playerWon
        ? ResultKind.resignation
        : normalizedReason == 'timeout_forfeit' && !playerWon
        ? ResultKind.timeout
        : normalizedReason == 'forfeit_disconnect' && playerWon
        ? ResultKind.disconnectForfeit
        : playerWon
        ? ResultKind.victory
        : ResultKind.defeat;

    return MatchResultViewData(
      kind: kind,
      opponent: MatchPlayer(id: opponentId, name: 'Opponent'),
      matchId: matchId,
      reason: reason,
      settlement: SettlementPhase.confirmed,
      payoutMinorUnits: playerWon ? payout : null,
      refundMinorUnits: isDraw ? payout : null,
      serverVerified: true,
    );
  }

  /// Deliberately excludes money, wallet balances, ledger references and
  /// receipt identifiers from user-shareable content.
  String privacySafeShareText() {
    final title = switch (kind) {
      ResultKind.victory => 'Victory',
      ResultKind.defeat => 'Match complete',
      ResultKind.draw => 'Draw',
      ResultKind.timeout => 'Match ended by timeout',
      ResultKind.resignation => 'Match ended by resignation',
      ResultKind.disconnectForfeit => 'Match ended by forfeit',
      ResultKind.cancelled => 'Match cancelled',
    };
    return '$title against ${opponent.name} on Draught Bet.';
  }
}

class MatchReceiptData {
  const MatchReceiptData({
    required this.matchId,
    required this.settledAt,
    this.reference,
    this.result,
    this.opponent,
    this.terms,
    this.payoutMinorUnits,
    this.refundMinorUnits,
    this.settlementReference,
  });

  final String matchId;
  final String? reference;
  final ResultKind? result;
  final MatchPlayer? opponent;
  final DateTime settledAt;
  final MatchTerms? terms;
  final int? payoutMinorUnits;
  final int? refundMinorUnits;
  final String? settlementReference;

  static MatchReceiptData? tryFromServer(Map<dynamic, dynamic> raw) {
    final outer = Map<String, dynamic>.from(raw);
    final envelope = outer['data'] is Map
        ? Map<String, dynamic>.from(outer['data'] as Map)
        : outer;
    final body = envelope['receipt'] is Map
        ? Map<String, dynamic>.from(envelope['receipt'] as Map)
        : envelope;
    final matchId = body['matchId']?.toString().trim() ?? '';
    final reference = body['reference']?.toString().trim();
    final settledAt = DateTime.tryParse(body['settledAt']?.toString() ?? '');
    final resultBody = body['result'] is Map
        ? Map<String, dynamic>.from(body['result'] as Map)
        : const <String, dynamic>{};
    final result = _parseResultKind(
      body['resultKind'] ?? body['outcome'] ?? resultBody['kind'],
    );
    if (matchId.isEmpty || settledAt == null) return null;
    MatchPlayer? opponent;
    final opponentBody = body['opponent'];
    if (opponentBody is Map) {
      final opponentJson = Map<String, dynamic>.from(opponentBody);
      final opponentId = opponentJson['id']?.toString().trim() ?? '';
      final opponentName =
          (opponentJson['username'] ?? opponentJson['name'])
              ?.toString()
              .trim() ??
          '';
      if (opponentId.isNotEmpty && opponentName.isNotEmpty) {
        opponent = MatchPlayer(
          id: opponentId,
          name: opponentName,
          avatarId: opponentJson['avatarId']?.toString() ?? 'avatar_01',
          rank: opponentJson['rank']?.toString(),
        );
      }
    }
    final termsBody = body['terms'];
    final termsJson = termsBody is Map
        ? Map<String, dynamic>.from(termsBody)
        : const <String, dynamic>{};
    final moneyBody = body['money'];
    final moneyJson = moneyBody is Map
        ? Map<String, dynamic>.from(moneyBody)
        : const <String, dynamic>{};
    final stake = _minorUnits(
      termsJson['stakeMinorUnits'] ?? moneyJson['stakeEachMinor'],
    );
    final terms = stake == null
        ? null
        : MatchTerms(
            stakeMinorUnits: stake,
            opponentStakeMinorUnits: _minorUnits(
              termsJson['opponentStakeMinorUnits'],
            ),
            platformFeeMinorUnits: _minorUnits(
              termsJson['platformFeeMinorUnits'] ?? moneyJson['feeMinor'],
            ),
            totalPrizeMinorUnits: _minorUnits(
              termsJson['totalPotMinorUnits'] ??
                  termsJson['totalPrizeMinorUnits'] ??
                  moneyJson['grossPotMinor'],
            ),
            timeControl:
                termsJson['timeControl']?.toString() ?? 'Server unavailable',
            gameType: termsJson['gameType']?.toString() ?? 'Server unavailable',
            board: termsJson['board']?.toString() ?? 'Server unavailable',
            serverQuoted: true,
          );
    return MatchReceiptData(
      matchId: matchId,
      reference: reference,
      result: result,
      opponent: opponent,
      settledAt: settledAt,
      terms: terms,
      payoutMinorUnits: _minorUnits(
        body['payoutMinorUnits'] ?? moneyJson['winnerPayoutMinor'],
      ),
      refundMinorUnits: _minorUnits(
        body['refundMinorUnits'] ?? moneyJson['refundMinor'],
      ),
      settlementReference: body['settlementReference']?.toString(),
    );
  }
}

ResultKind? _parseResultKind(dynamic value) =>
    switch (value?.toString().toLowerCase()) {
      'victory' || 'win' || 'won' => ResultKind.victory,
      'defeat' || 'loss' || 'lost' => ResultKind.defeat,
      'draw' => ResultKind.draw,
      'timeout' || 'timeout_result' => ResultKind.timeout,
      'resignation' || 'resign' => ResultKind.resignation,
      'disconnect_forfeit' || 'forfeit' => ResultKind.disconnectForfeit,
      'cancelled' || 'canceled' || 'system_cancelled' => ResultKind.cancelled,
      _ => null,
    };

SettlementPhase _parseSettlementPhase(dynamic value) =>
    switch (value?.toString().toLowerCase()) {
      'complete' || 'completed' || 'confirmed' => SettlementPhase.confirmed,
      'settled' => SettlementPhase.confirmed,
      'delayed' || 'review' => SettlementPhase.delayed,
      'failed' || 'unavailable' => SettlementPhase.failed,
      _ => SettlementPhase.pending,
    };

int? _minorUnits(dynamic value) {
  if (value == null) return null;
  final parsed = int.tryParse(value.toString());
  return parsed == null || parsed < 0 ? null : parsed;
}
