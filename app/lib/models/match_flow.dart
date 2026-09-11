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

enum ResultKind { victory, defeat, draw }

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
    required this.terms,
    this.matchId,
    this.reason = 'Match completed',
    this.settlement = SettlementPhase.pending,
    this.receiptReference,
  });

  final ResultKind kind;
  final MatchPlayer opponent;
  final MatchTerms terms;
  final String? matchId;
  final String reason;
  final SettlementPhase settlement;
  final String? receiptReference;
}
