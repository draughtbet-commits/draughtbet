import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../models/match_flow.dart';
import '../providers/profile_provider.dart';
import '../theme/colors.dart';

class BalanceCard extends ConsumerStatefulWidget {
  const BalanceCard({super.key});

  @override
  ConsumerState<BalanceCard> createState() => _BalanceCardState();
}

class _BalanceCardState extends ConsumerState<BalanceCard> {
  bool _hideBalance = false;

  String _formatNaira(int minorUnits) {
    return Money(minorUnits).format(showKobo: true);
  }

  @override
  Widget build(BuildContext context) {
    final profileState = ref.watch(profileProvider);
    final loading = profileState.isLoading && profileState.profile == null;
    final unavailable =
        profileState.error != null && profileState.profile == null;
    final balance = _hideBalance
        ? '₦••••••'
        : unavailable
        ? 'Unavailable'
        : _formatNaira(profileState.profile?.walletBalanceMinorUnits ?? 0);

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.surface1,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppColors.hairline),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            'AVAILABLE BALANCE',
            style: TextStyle(
              fontFamily: 'Inter',
              fontSize: 11,
              fontWeight: FontWeight.w600,
              letterSpacing: 1.2,
              color: AppColors.textMuted,
            ),
          ),
          const SizedBox(height: 6),
          Row(
            children: [
              Expanded(
                child: FittedBox(
                  fit: BoxFit.scaleDown,
                  alignment: Alignment.centerLeft,
                  child: loading
                      ? const SizedBox(
                          width: 150,
                          child: LinearProgressIndicator(minHeight: 8),
                        )
                      : Text(
                          balance,
                          maxLines: 1,
                          style: TextStyle(
                            fontFamily: 'Inter',
                            fontSize: unavailable ? 18 : 24,
                            fontWeight: FontWeight.w700,
                            color: unavailable
                                ? AppColors.textSecondary
                                : AppColors.textPrimary,
                          ),
                        ),
                ),
              ),
              const SizedBox(width: 10),
              GestureDetector(
                onTap: loading || unavailable
                    ? null
                    : () => setState(() => _hideBalance = !_hideBalance),
                child: Container(
                  width: 30,
                  height: 30,
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(8),
                    color: AppColors.voidBg,
                  ),
                  child: Icon(
                    _hideBalance ? LucideIcons.eyeOff : LucideIcons.eye,
                    size: 16,
                    color: AppColors.textMuted,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 14),
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Locked',
                      style: TextStyle(
                        fontFamily: 'Inter',
                        fontSize: 11,
                        fontWeight: FontWeight.w600,
                        letterSpacing: 1.2,
                        color: AppColors.textMuted,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      '—',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontFamily: 'Sora',
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                        color: AppColors.textMuted,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 10),
              GestureDetector(
                onTap: loading
                    ? null
                    : unavailable
                    ? () => ref.read(profileProvider.notifier).load()
                    : () => context.go('/wallet'),
                child: Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 14,
                    vertical: 8,
                  ),
                  decoration: BoxDecoration(
                    color: AppColors.voidBg,
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(color: AppColors.brand, width: 1.5),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(
                        unavailable ? LucideIcons.refreshCw : LucideIcons.plus,
                        size: 14,
                        color: AppColors.brand,
                      ),
                      const SizedBox(width: 4),
                      Text(
                        unavailable ? 'Try again' : 'Add Money',
                        style: TextStyle(
                          fontFamily: 'Inter',
                          fontSize: 13,
                          fontWeight: FontWeight.w600,
                          color: AppColors.textPrimary,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
