import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../models/match_flow.dart';
import '../providers/settlement_provider.dart';
import '../theme/colors.dart';
import '../theme/typography.dart';
import '../widgets/flow_widgets.dart';
import 'settlement_result_screens.dart';

class MatchResultScreen extends ConsumerStatefulWidget {
  const MatchResultScreen({
    super.key,
    required this.result,
    this.autoRefresh = true,
  });

  final MatchResultViewData result;
  final bool autoRefresh;

  @override
  ConsumerState<MatchResultScreen> createState() => _MatchResultScreenState();
}

class _MatchResultScreenState extends ConsumerState<MatchResultScreen> {
  @override
  void initState() {
    super.initState();
    if (widget.autoRefresh && widget.result.matchId != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        ref
            .read(settlementProvider(widget.result.matchId!).notifier)
            .refreshStatus();
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final matchId = widget.result.matchId;
    final state = matchId == null
        ? const SettlementUiState()
        : ref.watch(settlementProvider(matchId));
    final result = state.result ?? widget.result;
    final visual = ResultVisualSpec.forKind(result.kind);

    if (result.kind != ResultKind.victory && result.kind != ResultKind.defeat) {
      return _CompactOutcomeScreen(result: result, visual: visual);
    }

    return PopScope(
      canPop: false,
      child: Scaffold(
        backgroundColor: AppColors.background,
        body: SafeArea(
          child: FlowPage(
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 720),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const SizedBox(height: 34),
                  _ResultHero(result: result, visual: visual),
                  const SizedBox(height: 18),
                  if (!result.serverVerified)
                    const _AuthorityWarning()
                  else
                    _FinancialSummary(result: result, visual: visual),
                  if (state.phase == SettlementLoadPhase.error ||
                      state.phase == SettlementLoadPhase.unavailable) ...[
                    const SizedBox(height: 12),
                    _StatusNotice(
                      message:
                          state.message ??
                          'Settlement status is temporarily unavailable.',
                    ),
                  ],
                  const SizedBox(height: 18),
                  _SettlementLine(result: result),
                  const SizedBox(height: 24),
                  if (result.matchId != null) ...[
                    SecondaryActionButton(
                      label: 'View receipt',
                      icon: LucideIcons.receiptText,
                      onPressed: () => context.push(
                        '/matches/${result.matchId}/receipt',
                        extra: result,
                      ),
                    ),
                    const SizedBox(height: 9),
                    TextButton.icon(
                      onPressed: () => showShareResultSheet(context, result),
                      icon: const Icon(LucideIcons.share2, size: 17),
                      label: const Text('Share result'),
                    ),
                    const SizedBox(height: 5),
                  ],
                  PrimaryActionButton(
                    label: 'Back to Home',
                    destructive: result.kind == ResultKind.defeat,
                    onPressed: () => context.go('/home'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _CompactOutcomeScreen extends StatelessWidget {
  const _CompactOutcomeScreen({required this.result, required this.visual});

  final MatchResultViewData result;
  final ResultVisualSpec visual;

  @override
  Widget build(BuildContext context) => PopScope(
    canPop: false,
    child: Scaffold(
      backgroundColor: AppColors.background,
      body: ResultBoardBackdrop(
        child: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(20),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 330),
                child: FlowCard(
                  borderColor: visual.accent.withValues(alpha: .5),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Icon(visual.icon, color: visual.accent, size: 58),
                      const SizedBox(height: 14),
                      Text(
                        visual.title,
                        textAlign: TextAlign.center,
                        style: AppTypography.heading2.copyWith(
                          color: visual.accent,
                          fontSize: visual.title.length > 18 ? 21 : 27,
                        ),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        result.reason,
                        textAlign: TextAlign.center,
                        style: AppTypography.bodyLarge,
                      ),
                      const SizedBox(height: 16),
                      _SettlementLine(result: result),
                      const SizedBox(height: 20),
                      if (result.matchId != null &&
                          result.kind != ResultKind.cancelled) ...[
                        PrimaryActionButton(
                          label: 'View receipt',
                          icon: LucideIcons.receiptText,
                          onPressed: () => context.push(
                            '/matches/${result.matchId}/receipt',
                            extra: result,
                          ),
                        ),
                        const SizedBox(height: 9),
                      ],
                      SecondaryActionButton(
                        label: 'Return home',
                        onPressed: () => context.go('/home'),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

class _ResultHero extends StatelessWidget {
  const _ResultHero({required this.result, required this.visual});

  final MatchResultViewData result;
  final ResultVisualSpec visual;

  @override
  Widget build(BuildContext context) => Column(
    children: [
      DecoratedBox(
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: visual.accent.withValues(alpha: .11),
          boxShadow: [
            BoxShadow(
              color: visual.accent.withValues(alpha: .24),
              blurRadius: 32,
              spreadRadius: 2,
            ),
          ],
        ),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Icon(visual.icon, color: visual.accent, size: 62),
        ),
      ),
      const SizedBox(height: 16),
      Text(
        visual.title,
        textAlign: TextAlign.center,
        style: AppTypography.heading1.copyWith(
          color: visual.accent,
          fontSize: visual.title.length > 18 ? 25 : 32,
          letterSpacing: .8,
        ),
      ),
      const SizedBox(height: 6),
      Text(
        result.reason,
        textAlign: TextAlign.center,
        style: AppTypography.bodyLarge.copyWith(color: AppColors.textSecondary),
      ),
      const SizedBox(height: 18),
      GameAvatar(
        avatarId: result.opponent.avatarId,
        size: 74,
        accent: visual.accent,
        label: result.opponent.name,
      ),
      const SizedBox(height: 7),
      Text(result.opponent.name, style: AppTypography.labelBold),
    ],
  );
}

class _FinancialSummary extends StatelessWidget {
  const _FinancialSummary({required this.result, required this.visual});

  final MatchResultViewData result;
  final ResultVisualSpec visual;

  @override
  Widget build(BuildContext context) {
    final terms = result.terms;
    final rows = <MapEntry<String, String>>[];
    if (terms != null) {
      rows.add(MapEntry('Stake', Money(terms.stakeMinorUnits).format()));
      if (terms.opponentStakeMinorUnits != null) {
        rows.add(
          MapEntry(
            'Opponent stake',
            Money(terms.opponentStakeMinorUnits!).format(),
          ),
        );
      }
      if (terms.platformFeeMinorUnits != null) {
        rows.add(
          MapEntry(
            'Platform fee',
            Money(terms.platformFeeMinorUnits!).format(),
          ),
        );
      }
      if (terms.totalPrizeMinorUnits != null) {
        rows.add(
          MapEntry('Total pot', Money(terms.totalPrizeMinorUnits!).format()),
        );
      }
    }
    if (result.settlement == SettlementPhase.confirmed &&
        result.payoutMinorUnits != null) {
      rows.add(MapEntry('Payout', Money(result.payoutMinorUnits!).format()));
    }
    if (result.settlement == SettlementPhase.confirmed &&
        result.refundMinorUnits != null) {
      rows.add(MapEntry('Refund', Money(result.refundMinorUnits!).format()));
    }

    if (rows.isEmpty) {
      return const _StatusNotice(
        message: 'Financial details are awaiting server confirmation.',
      );
    }
    return FlowCard(
      borderColor: visual.accent.withValues(alpha: .42),
      child: Column(
        children: [
          for (final row in rows)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 5),
              child: Row(
                children: [
                  Expanded(
                    child: Text(row.key, style: AppTypography.bodySmall),
                  ),
                  Text(
                    row.value,
                    style: AppTypography.labelBold.copyWith(
                      color: row.key == 'Payout' || row.key == 'Refund'
                          ? AppColors.primaryBright
                          : AppColors.textPrimary,
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class _SettlementLine extends StatelessWidget {
  const _SettlementLine({required this.result});

  final MatchResultViewData result;

  @override
  Widget build(BuildContext context) {
    final (icon, text, color) = switch (result.settlement) {
      SettlementPhase.pending => (
        LucideIcons.loaderCircle,
        'Result final · settlement processing',
        AppColors.textSecondary,
      ),
      SettlementPhase.confirmed => (
        LucideIcons.circleCheck,
        'Settlement complete',
        AppColors.primaryBright,
      ),
      SettlementPhase.delayed => (
        LucideIcons.clockAlert,
        'Settlement delayed · result remains final',
        AppColors.warning,
      ),
      SettlementPhase.failed => (
        LucideIcons.circleAlert,
        'Settlement status unavailable',
        AppColors.danger,
      ),
    };
    return Semantics(
      liveRegion: true,
      label: text,
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(icon, color: color, size: 17),
          const SizedBox(width: 8),
          Flexible(
            child: Text(
              text,
              textAlign: TextAlign.center,
              style: AppTypography.bodySmall.copyWith(color: color),
            ),
          ),
        ],
      ),
    );
  }
}

class _AuthorityWarning extends StatelessWidget {
  const _AuthorityWarning();

  @override
  Widget build(BuildContext context) => const _StatusNotice(
    message:
        'Verified result details are unavailable. No financial values are shown.',
  );
}

class _StatusNotice extends StatelessWidget {
  const _StatusNotice({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) => FlowCard(
    child: Row(
      children: [
        const Icon(LucideIcons.info, color: AppColors.textSecondary, size: 19),
        const SizedBox(width: 10),
        Expanded(child: Text(message, style: AppTypography.bodySmall)),
      ],
    ),
  );
}

class ResultVisualSpec {
  const ResultVisualSpec({
    required this.title,
    required this.icon,
    required this.accent,
  });

  final String title;
  final IconData icon;
  final Color accent;

  static ResultVisualSpec forKind(ResultKind kind) => switch (kind) {
    ResultKind.victory => const ResultVisualSpec(
      title: 'VICTORY',
      icon: LucideIcons.crown,
      accent: AppColors.primaryBright,
    ),
    ResultKind.defeat => const ResultVisualSpec(
      title: 'DEFEAT',
      icon: LucideIcons.swords,
      accent: AppColors.danger,
    ),
    ResultKind.draw => const ResultVisualSpec(
      title: 'DRAW',
      icon: LucideIcons.handshake,
      accent: AppColors.valueAccent,
    ),
    ResultKind.timeout => const ResultVisualSpec(
      title: 'TIMEOUT',
      icon: LucideIcons.clockAlert,
      accent: AppColors.danger,
    ),
    ResultKind.resignation => const ResultVisualSpec(
      title: 'VICTORY BY RESIGNATION',
      icon: LucideIcons.crown,
      accent: AppColors.valueAccent,
    ),
    ResultKind.disconnectForfeit => const ResultVisualSpec(
      title: 'VICTORY BY FORFEIT',
      icon: LucideIcons.crown,
      accent: AppColors.valueAccent,
    ),
    ResultKind.cancelled => const ResultVisualSpec(
      title: 'MATCH CANCELLED',
      icon: LucideIcons.info,
      accent: AppColors.textPrimary,
    ),
  };
}
