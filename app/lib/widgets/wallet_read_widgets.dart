import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../models/match_flow.dart';
import '../models/wallet_read.dart';
import '../theme/colors.dart';
import '../theme/typography.dart';
import 'flow_widgets.dart';

class WalletAmount extends StatelessWidget {
  const WalletAmount(this.minorUnits, {super.key, this.style});

  final int? minorUnits;
  final TextStyle? style;

  @override
  Widget build(BuildContext context) => Text(
    minorUnits == null
        ? 'Unavailable'
        : Money(minorUnits!).format(showKobo: true),
    style: style ?? AppTypography.balance,
  );
}

class WalletMetricCard extends StatelessWidget {
  const WalletMetricCard({
    required this.label,
    required this.value,
    required this.icon,
    super.key,
    this.onTap,
  });

  final String label;
  final int? value;
  final IconData icon;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => Expanded(
    child: Semantics(
      button: onTap != null,
      label:
          '$label, ${value == null ? 'unavailable' : Money(value!).format()}',
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(14),
        child: FlowCard(
          padding: const EdgeInsets.all(12),
          child: SizedBox(
            height: 74,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Icon(icon, size: 15, color: AppColors.textSecondary),
                    const SizedBox(width: 6),
                    Flexible(
                      child: Text(label, style: AppTypography.bodySmall),
                    ),
                  ],
                ),
                const Spacer(),
                WalletAmount(
                  value,
                  style: AppTypography.stake.copyWith(
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    ),
  );
}

class WalletTransactionRow extends StatelessWidget {
  const WalletTransactionRow({required this.entry, super.key, this.onTap});

  final WalletEntry entry;
  final VoidCallback? onTap;

  String get _label => switch (entry.kind) {
    WalletEntryKind.deposit => 'Deposit',
    WalletEntryKind.withdrawal => 'Withdrawal',
    WalletEntryKind.stake => 'Match Stake',
    WalletEntryKind.payout => 'Payout',
    WalletEntryKind.refund => 'Refund',
    WalletEntryKind.other => entry.description ?? 'Transaction',
  };

  IconData get _icon => switch (entry.kind) {
    WalletEntryKind.deposit => LucideIcons.arrowDownToLine,
    WalletEntryKind.withdrawal => LucideIcons.arrowUpFromLine,
    WalletEntryKind.stake => LucideIcons.swords,
    WalletEntryKind.payout => LucideIcons.trophy,
    WalletEntryKind.refund => LucideIcons.rotateCcw,
    WalletEntryKind.other => LucideIcons.receipt,
  };

  @override
  Widget build(BuildContext context) {
    final status = entry.status.toUpperCase();
    final statusColor = status == 'SUCCESS' || status == 'COMPLETED'
        ? AppColors.success
        : status == 'FAILED' || status == 'REVERSED'
        ? AppColors.danger
        : AppColors.warning;
    return Semantics(
      button: onTap != null,
      label:
          '$_label, ${Money(entry.amountMinorUnits.abs()).format()}, $status',
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: FlowCard(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          child: Row(
            children: [
              Container(
                width: 38,
                height: 38,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: statusColor.withValues(alpha: .12),
                  border: Border.all(color: statusColor.withValues(alpha: .55)),
                ),
                child: Icon(_icon, color: statusColor, size: 18),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(_label, style: AppTypography.labelBold),
                    const SizedBox(height: 2),
                    Text(
                      '${entry.createdAt.day}/${entry.createdAt.month}/${entry.createdAt.year}',
                      style: AppTypography.bodySmall,
                    ),
                  ],
                ),
              ),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Text(
                    '${entry.isCredit ? '+' : '-'}${Money(entry.amountMinorUnits.abs()).format()}',
                    style: AppTypography.labelBold,
                  ),
                  const SizedBox(height: 2),
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(LucideIcons.circle, size: 7, color: statusColor),
                      const SizedBox(width: 4),
                      Text(
                        status.toLowerCase(),
                        style: AppTypography.bodySmall.copyWith(
                          color: statusColor,
                        ),
                      ),
                    ],
                  ),
                ],
              ),
              if (onTap != null) ...[
                const SizedBox(width: 5),
                const Icon(LucideIcons.chevronRight, size: 17),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class WalletSkeleton extends StatelessWidget {
  const WalletSkeleton({super.key, this.rows = 4});

  final int rows;

  @override
  Widget build(BuildContext context) => Column(
    children: List.generate(
      rows,
      (_) => const Padding(
        padding: EdgeInsets.only(bottom: 10),
        child: FlowCard(
          child: SizedBox(
            height: 48,
            child: LinearProgressIndicator(minHeight: 7),
          ),
        ),
      ),
    ),
  );
}
