import 'package:draughts_arena/models/match_flow.dart';

const settlementOpponent = MatchPlayer(
  id: 'player-2',
  name: 'KingMoves',
  avatarId: 'avatar_04',
  rank: 'MASTER',
  rating: 1780,
);

const settlementTerms = MatchTerms(
  stakeMinorUnits: 200000,
  opponentStakeMinorUnits: 200000,
  platformFeeMinorUnits: 10000,
  totalPrizeMinorUnits: 390000,
  timeControl: '10 minutes',
  gameType: 'Classic',
  board: '10×10 (International)',
  serverQuoted: true,
);

MatchResultViewData settlementResult(
  ResultKind kind, {
  SettlementPhase phase = SettlementPhase.confirmed,
  String? reason,
}) {
  return MatchResultViewData(
    kind: kind,
    opponent: settlementOpponent,
    terms: settlementTerms,
    matchId: 'DB241567',
    reason: reason ?? _reasonFor(kind),
    settlement: phase,
    payoutMinorUnits:
        phase == SettlementPhase.confirmed &&
            (kind == ResultKind.victory ||
                kind == ResultKind.resignation ||
                kind == ResultKind.disconnectForfeit)
        ? 390000
        : null,
    refundMinorUnits:
        phase == SettlementPhase.confirmed && kind == ResultKind.draw
        ? 200000
        : null,
    settlementReference: 'SET-241567',
    receiptReference: 'RCP-241567',
    endedAt: DateTime.utc(2024, 5, 11, 20, 14),
    serverVerified: true,
  );
}

final settlementReceipt = MatchReceiptData(
  matchId: 'DB241567',
  reference: 'RCP-241567',
  result: ResultKind.victory,
  opponent: settlementOpponent,
  settledAt: DateTime.utc(2024, 5, 11, 20, 14),
  terms: settlementTerms,
  payoutMinorUnits: 390000,
  settlementReference: 'SET-241567',
);

String _reasonFor(ResultKind kind) => switch (kind) {
  ResultKind.victory => 'You defeated KingMoves',
  ResultKind.defeat => 'Better luck next time',
  ResultKind.draw => 'The match ended in a draw.',
  ResultKind.timeout => 'The server clock expired.',
  ResultKind.resignation => 'Your opponent resigned the match.',
  ResultKind.disconnectForfeit => 'Your opponent failed to reconnect in time.',
  ResultKind.cancelled => 'This match was cancelled by the system.',
};
