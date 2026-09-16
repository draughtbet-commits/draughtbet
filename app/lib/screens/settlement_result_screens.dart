import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../models/match_flow.dart';
import '../providers/settlement_provider.dart';
import '../theme/colors.dart';
import '../theme/typography.dart';
import '../widgets/draught_board.dart';
import '../widgets/flow_widgets.dart';

class SettlementStatusScreen extends ConsumerStatefulWidget {
  const SettlementStatusScreen({
    super.key,
    required this.result,
    required this.phase,
    this.autoRefresh = true,
  });

  final MatchResultViewData result;
  final SettlementPhase phase;
  final bool autoRefresh;

  @override
  ConsumerState<SettlementStatusScreen> createState() =>
      _SettlementStatusScreenState();
}

class _SettlementStatusScreenState
    extends ConsumerState<SettlementStatusScreen> {
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
    final phase = state.result?.settlement ?? widget.phase;
    final spec = _SettlementSpec.forPhase(phase);
    final refreshing = state.phase == SettlementLoadPhase.refreshing;

    return Scaffold(
      backgroundColor: AppColors.background,
      body: ResultBoardBackdrop(
        child: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(20),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 340),
                child: FlowCard(
                  borderColor: spec.accent.withValues(alpha: .5),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Icon(spec.icon, color: spec.accent, size: 72),
                      const SizedBox(height: 18),
                      Text(
                        spec.title,
                        textAlign: TextAlign.center,
                        style: AppTypography.heading2.copyWith(
                          color: spec.accent,
                        ),
                      ),
                      const SizedBox(height: 6),
                      if (result.matchId != null)
                        Text(
                          'Match #${result.matchId}',
                          textAlign: TextAlign.center,
                          style: AppTypography.bodySmall,
                        ),
                      const SizedBox(height: 14),
                      Text(
                        spec.message,
                        textAlign: TextAlign.center,
                        style: AppTypography.bodyLarge,
                      ),
                      const SizedBox(height: 22),
                      FlowCard(
                        child: Row(
                          children: [
                            Icon(spec.noticeIcon, color: spec.accent, size: 22),
                            const SizedBox(width: 12),
                            Expanded(
                              child: Text(
                                spec.notice,
                                style: AppTypography.bodySmall.copyWith(
                                  color: AppColors.textPrimary,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                      if (state.message != null) ...[
                        const SizedBox(height: 12),
                        Text(
                          state.message!,
                          textAlign: TextAlign.center,
                          style: AppTypography.bodySmall.copyWith(
                            color: state.phase == SettlementLoadPhase.error
                                ? AppColors.danger
                                : AppColors.warning,
                          ),
                        ),
                      ],
                      const SizedBox(height: 22),
                      if (phase == SettlementPhase.confirmed && matchId != null)
                        PrimaryActionButton(
                          label: 'View receipt',
                          icon: LucideIcons.receiptText,
                          onPressed: () => context.push(
                            '/matches/$matchId/receipt',
                            extra: result,
                          ),
                        )
                      else if (matchId != null)
                        PrimaryActionButton(
                          label: 'Check status',
                          icon: LucideIcons.refreshCw,
                          loading: refreshing,
                          onPressed: () => ref
                              .read(settlementProvider(matchId).notifier)
                              .refreshStatus(),
                        ),
                      if (phase == SettlementPhase.delayed) ...[
                        const SizedBox(height: 9),
                        SecondaryActionButton(
                          label: 'Contact support',
                          icon: LucideIcons.messagesSquare,
                          onPressed: () =>
                              ScaffoldMessenger.of(context).showSnackBar(
                                const SnackBar(
                                  content: Text(
                                    'Support contact is not available in the current contract.',
                                  ),
                                ),
                              ),
                        ),
                      ],
                      const SizedBox(height: 9),
                      TextButton(
                        onPressed: () => context.go('/home'),
                        child: const Text('Return home'),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class ResultBoardBackdrop extends StatelessWidget {
  const ResultBoardBackdrop({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) => Stack(
    fit: StackFit.expand,
    children: [
      DecoratedBox(
        decoration: const BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [AppColors.surfaceRaised, AppColors.background],
          ),
        ),
        child: Align(
          alignment: const Alignment(0, -.18),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 18),
            child: IgnorePointer(
              child: Opacity(
                opacity: .5,
                child: DraughtBoard(
                  board: List<int>.filled(50, 0),
                  legalMoves: const [],
                  selectedSquare: null,
                  inputEnabled: false,
                  onSquareTapped: _ignoreSquareTap,
                ),
              ),
            ),
          ),
        ),
      ),
      ColoredBox(color: AppColors.background.withValues(alpha: .72)),
      child,
    ],
  );
}

void _ignoreSquareTap(int _) {}

class MatchReceiptScreen extends ConsumerStatefulWidget {
  const MatchReceiptScreen({
    super.key,
    required this.matchId,
    this.initialReceipt,
    this.autoLoad = true,
  });

  final String matchId;
  final MatchReceiptData? initialReceipt;
  final bool autoLoad;

  @override
  ConsumerState<MatchReceiptScreen> createState() => _MatchReceiptScreenState();
}

class _MatchReceiptScreenState extends ConsumerState<MatchReceiptScreen> {
  @override
  void initState() {
    super.initState();
    if (widget.autoLoad && widget.initialReceipt == null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        ref.read(settlementProvider(widget.matchId).notifier).loadReceipt();
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(settlementProvider(widget.matchId));
    final receipt = state.receipt ?? widget.initialReceipt;
    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(title: const Text('MATCH RECEIPT'), centerTitle: true),
      body: SafeArea(
        top: false,
        child: receipt == null
            ? state.phase == SettlementLoadPhase.refreshing
                  ? const Center(child: CircularProgressIndicator())
                  : RecoverableState(
                      title: 'Receipt unavailable',
                      message:
                          state.message ??
                          'A verified server receipt is not available yet.',
                      actionLabel: 'Retry',
                      onAction: () => ref
                          .read(settlementProvider(widget.matchId).notifier)
                          .loadReceipt(),
                    )
            : FlowPage(child: _ReceiptBody(receipt: receipt)),
      ),
    );
  }
}

class _ReceiptBody extends StatelessWidget {
  const _ReceiptBody({required this.receipt});

  final MatchReceiptData receipt;

  @override
  Widget build(BuildContext context) {
    final resultLabel = _resultLabel(receipt.result);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 12),
        const Icon(LucideIcons.crown, color: AppColors.valueAccent, size: 68),
        const SizedBox(height: 8),
        Text(
          resultLabel,
          textAlign: TextAlign.center,
          style: AppTypography.heading2.copyWith(
            color: AppColors.primaryBright,
          ),
        ),
        const SizedBox(height: 3),
        Text(
          'Settlement complete',
          textAlign: TextAlign.center,
          style: AppTypography.bodyLarge,
        ),
        const SizedBox(height: 18),
        FlowCard(
          child: Column(
            children: [
              _ReceiptRow(label: 'Receipt', value: receipt.reference),
              _ReceiptRow(label: 'Match ID', value: receipt.matchId),
              _ReceiptRow(
                label: 'Date',
                value: DateFormat('MMM d, y · HH:mm').format(receipt.settledAt),
              ),
              const Divider(height: 20),
              Row(
                children: [
                  GameAvatar(
                    avatarId: receipt.opponent.avatarId,
                    size: 42,
                    label: receipt.opponent.name,
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      receipt.opponent.name,
                      style: AppTypography.labelBold,
                    ),
                  ),
                  if (receipt.opponent.rank != null)
                    RankPill(label: receipt.opponent.rank!),
                ],
              ),
              if (receipt.terms != null) ...[
                const Divider(height: 20),
                _ReceiptRow(
                  label: 'Stake',
                  value: Money(receipt.terms!.stakeMinorUnits).format(),
                ),
                if (receipt.terms!.platformFeeMinorUnits != null)
                  _ReceiptRow(
                    label: 'Platform fee',
                    value: Money(
                      receipt.terms!.platformFeeMinorUnits!,
                    ).format(),
                  ),
                if (receipt.terms!.totalPrizeMinorUnits != null)
                  _ReceiptRow(
                    label: 'Total pot',
                    value: Money(receipt.terms!.totalPrizeMinorUnits!).format(),
                  ),
              ],
              if (receipt.payoutMinorUnits != null)
                _ReceiptRow(
                  label: 'Payout',
                  value: Money(receipt.payoutMinorUnits!).format(),
                  accent: true,
                ),
              if (receipt.refundMinorUnits != null)
                _ReceiptRow(
                  label: 'Refund',
                  value: Money(receipt.refundMinorUnits!).format(),
                  accent: true,
                ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        FlowCard(
          borderColor: AppColors.primaryBright,
          child: Row(
            children: [
              const Icon(
                LucideIcons.circleCheck,
                color: AppColors.primaryBright,
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  'Settlement complete. This receipt uses verified server data.',
                  style: AppTypography.bodySmall.copyWith(
                    color: AppColors.textPrimary,
                  ),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        SecondaryActionButton(
          label: 'Share result',
          icon: LucideIcons.share2,
          onPressed: () => showShareReceiptResultSheet(context, receipt),
        ),
        const SizedBox(height: 9),
        PrimaryActionButton(
          label: 'Play again',
          onPressed: () => context.go('/home'),
        ),
      ],
    );
  }
}

class _ReceiptRow extends StatelessWidget {
  const _ReceiptRow({
    required this.label,
    required this.value,
    this.accent = false,
  });

  final String label;
  final String value;
  final bool accent;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 5),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(child: Text(label, style: AppTypography.bodySmall)),
        const SizedBox(width: 12),
        Flexible(
          child: Text(
            value,
            textAlign: TextAlign.end,
            style: AppTypography.labelBold.copyWith(
              color: accent ? AppColors.primaryBright : AppColors.textPrimary,
            ),
          ),
        ),
      ],
    ),
  );
}

Future<void> showShareResultSheet(
  BuildContext context,
  MatchResultViewData result,
) {
  return showModalBottomSheet<void>(
    context: context,
    backgroundColor: AppColors.surface,
    showDragHandle: true,
    builder: (context) =>
        ShareResultSheet(shareText: result.privacySafeShareText()),
  );
}

Future<void> showShareReceiptResultSheet(
  BuildContext context,
  MatchReceiptData receipt,
) {
  final text =
      '${_resultLabel(receipt.result)} against '
      '${receipt.opponent.name} on Draught Bet.';
  return showModalBottomSheet<void>(
    context: context,
    backgroundColor: AppColors.surface,
    showDragHandle: true,
    builder: (context) => ShareResultSheet(shareText: text),
  );
}

class ShareResultSheet extends StatelessWidget {
  const ShareResultSheet({super.key, required this.shareText});

  final String shareText;

  @override
  Widget build(BuildContext context) => SafeArea(
    child: Padding(
      padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Icon(
            LucideIcons.share2,
            color: AppColors.primaryBright,
            size: 42,
          ),
          const SizedBox(height: 12),
          Text(
            'SHARE RESULT',
            textAlign: TextAlign.center,
            style: AppTypography.heading3,
          ),
          const SizedBox(height: 8),
          Text(
            'Only the public match outcome and opponent name will be shared.',
            textAlign: TextAlign.center,
            style: AppTypography.bodySmall,
          ),
          const SizedBox(height: 16),
          FlowCard(
            child: Text(
              shareText,
              textAlign: TextAlign.center,
              style: AppTypography.bodyLarge,
            ),
          ),
          const SizedBox(height: 14),
          PrimaryActionButton(
            label: 'Copy result',
            icon: LucideIcons.copy,
            onPressed: () async {
              await Clipboard.setData(ClipboardData(text: shareText));
              if (!context.mounted) return;
              Navigator.pop(context);
              ScaffoldMessenger.of(
                context,
              ).showSnackBar(const SnackBar(content: Text('Result copied.')));
            },
          ),
          const SizedBox(height: 8),
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
        ],
      ),
    ),
  );
}

class _SettlementSpec {
  const _SettlementSpec({
    required this.title,
    required this.message,
    required this.notice,
    required this.icon,
    required this.noticeIcon,
    required this.accent,
  });

  final String title;
  final String message;
  final String notice;
  final IconData icon;
  final IconData noticeIcon;
  final Color accent;

  static _SettlementSpec forPhase(SettlementPhase phase) => switch (phase) {
    SettlementPhase.pending => const _SettlementSpec(
      title: 'SETTLEMENT PROCESSING',
      message:
          'Your result is final. The server is still finalising wallet settlement.',
      notice: 'Your wallet will update only after server confirmation.',
      icon: LucideIcons.settings,
      noticeIcon: LucideIcons.clock3,
      accent: AppColors.textSecondary,
    ),
    SettlementPhase.confirmed => const _SettlementSpec(
      title: 'SETTLEMENT COMPLETE',
      message: 'Your match result and settlement have been confirmed.',
      notice: 'Verified settlement details are available in your receipt.',
      icon: LucideIcons.circleCheck,
      noticeIcon: LucideIcons.receiptText,
      accent: AppColors.primaryBright,
    ),
    SettlementPhase.delayed => const _SettlementSpec(
      title: 'SETTLEMENT DELAYED',
      message:
          'Your result is recorded, but wallet settlement is taking longer than usual.',
      notice: 'Your wallet will update only after server confirmation.',
      icon: LucideIcons.triangleAlert,
      noticeIcon: LucideIcons.clock3,
      accent: AppColors.warning,
    ),
    SettlementPhase.failed => const _SettlementSpec(
      title: 'STATUS UNAVAILABLE',
      message: 'The verified settlement status cannot be loaded right now.',
      notice: 'No wallet value has been changed locally.',
      icon: LucideIcons.circleAlert,
      noticeIcon: LucideIcons.shieldAlert,
      accent: AppColors.danger,
    ),
  };
}

String _resultLabel(ResultKind kind) => switch (kind) {
  ResultKind.victory => 'Victory',
  ResultKind.defeat => 'Defeat',
  ResultKind.draw => 'Draw',
  ResultKind.timeout => 'Timeout',
  ResultKind.resignation => 'Victory by resignation',
  ResultKind.disconnectForfeit => 'Victory by forfeit',
  ResultKind.cancelled => 'Match cancelled',
};
