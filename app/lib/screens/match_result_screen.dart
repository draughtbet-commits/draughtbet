import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../models/match_flow.dart';
import '../providers/match_provider.dart';
import '../theme/colors.dart';
import '../widgets/flow_widgets.dart';

class MatchResultScreen extends ConsumerWidget {
  const MatchResultScreen({super.key, required this.result});

  final MatchResultViewData result;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final live = ref.watch(matchProvider);
    final sameMatch =
        result.matchId != null && live.currentMatchId == result.matchId;
    final settlement = sameMatch ? live.settlementPhase : result.settlement;
    final confirmedPayout = sameMatch ? live.confirmedPayoutMinorUnits : null;
    final victory = result.kind == ResultKind.victory;
    final draw = result.kind == ResultKind.draw;
    final accent = draw
        ? AppColors.valueAccent
        : victory
        ? AppColors.primaryBright
        : AppColors.danger;
    final label = draw
        ? 'DRAW'
        : victory
        ? 'VICTORY'
        : 'DEFEAT';
    final settlementText = switch (settlement) {
      SettlementPhase.pending => 'Settlement processing',
      SettlementPhase.confirmed => 'Settlement confirmed',
      SettlementPhase.delayed => 'Settlement delayed — your result is safe',
      SettlementPhase.failed => 'Settlement status unavailable — retry later',
    };

    return PopScope(
      canPop: false,
      child: Scaffold(
        backgroundColor: AppColors.background,
        body: SafeArea(
          child: FlowPage(
            scrollable: false,
            child: Column(
              children: [
                const Spacer(),
                Icon(
                  victory
                      ? LucideIcons.trophy
                      : draw
                      ? LucideIcons.handshake
                      : LucideIcons.swords,
                  color: accent,
                  size: 44,
                ),
                const SizedBox(height: 10),
                Text(
                  label,
                  style: TextStyle(
                    fontFamily: 'Sora',
                    color: accent,
                    fontSize: 34,
                    fontWeight: FontWeight.w700,
                    letterSpacing: 1.1,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  result.reason,
                  style: TextStyle(
                    fontFamily: 'Inter',
                    color: AppColors.textSecondary,
                    fontSize: 12,
                  ),
                ),
                const SizedBox(height: 20),
                GameAvatar(
                  avatarId: result.opponent.avatarId,
                  size: 78,
                  accent: accent,
                  label: result.opponent.name,
                ),
                const SizedBox(height: 8),
                Text(
                  victory
                      ? 'You defeated ${result.opponent.name}'
                      : draw
                      ? 'Match with ${result.opponent.name}'
                      : 'Better luck next time',
                  style: TextStyle(
                    fontFamily: 'Inter',
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 22),
                FlowCard(
                  borderColor: accent.withValues(alpha: .4),
                  child: Column(
                    children: [
                      _ResultRow(
                        label: victory ? 'You Won' : 'You Lost',
                        value: victory
                            ? settlement == SettlementPhase.confirmed
                                  ? confirmedPayout != null
                                        ? Money(confirmedPayout).format()
                                        : result.terms.totalPrizeMinorUnits !=
                                              null
                                        ? Money(
                                            result.terms.totalPrizeMinorUnits!,
                                          ).format()
                                        : 'See receipt'
                                  : 'Pending'
                            : Money(result.terms.stakeMinorUnits).format(),
                        color: accent,
                        large: true,
                      ),
                      const Divider(height: 18),
                      _ResultRow(
                        label: 'Stake',
                        value: Money(result.terms.stakeMinorUnits).format(),
                      ),
                      _ResultRow(
                        label: 'Opponent Stake',
                        value: result.terms.opponentStakeMinorUnits == null
                            ? 'See receipt'
                            : Money(
                                result.terms.opponentStakeMinorUnits!,
                              ).format(),
                      ),
                      _ResultRow(
                        label: 'Platform Fee',
                        value: result.terms.platformFeeMinorUnits == null
                            ? 'See receipt'
                            : '-${Money(result.terms.platformFeeMinorUnits!).format()}',
                      ),
                      const SizedBox(height: 6),
                      Row(
                        children: [
                          Icon(
                            settlement == SettlementPhase.confirmed
                                ? LucideIcons.circleCheck
                                : settlement == SettlementPhase.failed
                                ? LucideIcons.circleAlert
                                : LucideIcons.clock3,
                            color: accent,
                            size: 15,
                          ),
                          const SizedBox(width: 7),
                          Expanded(
                            child: Text(
                              settlementText,
                              style: TextStyle(
                                fontFamily: 'Inter',
                                color: AppColors.textSecondary,
                                fontSize: 10,
                              ),
                            ),
                          ),
                        ],
                      ),
                      if (result.receiptReference != null)
                        Align(
                          alignment: Alignment.centerLeft,
                          child: Text(
                            'Receipt ${result.receiptReference}',
                            style: TextStyle(
                              fontFamily: 'Inter',
                              color: AppColors.textSecondary,
                              fontSize: 10,
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
                const Spacer(),
                if (settlement == SettlementPhase.failed &&
                    result.matchId != null) ...[
                  SecondaryActionButton(
                    label: 'Retry result status',
                    icon: LucideIcons.refreshCw,
                    onPressed: () => ref
                        .read(matchProvider.notifier)
                        .fetchGameState(result.matchId!),
                  ),
                  const SizedBox(height: 10),
                ],
                PrimaryActionButton(
                  label: 'Back to Home',
                  destructive: !victory && !draw,
                  onPressed: () => context.go('/home'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ResultRow extends StatelessWidget {
  const _ResultRow({
    required this.label,
    required this.value,
    this.color,
    this.large = false,
  });

  final String label;
  final String value;
  final Color? color;
  final bool large;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(
        children: [
          Expanded(
            child: Text(
              label,
              style: TextStyle(
                fontFamily: 'Inter',
                color: AppColors.textSecondary,
                fontSize: large ? 13 : 11,
                fontWeight: large ? FontWeight.w700 : FontWeight.w400,
              ),
            ),
          ),
          Text(
            value,
            style: TextStyle(
              fontFamily: 'Inter',
              color: color ?? AppColors.textPrimary,
              fontSize: large ? 18 : 11,
              fontWeight: FontWeight.w700,
            ),
          ),
        ],
      ),
    );
  }
}
