import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:google_fonts/google_fonts.dart';
import '../providers/profile_provider.dart';
import '../theme/colors.dart';

class BalanceCard extends ConsumerStatefulWidget {
  const BalanceCard({Key? key}) : super(key: key);

  @override
  ConsumerState<BalanceCard> createState() => _BalanceCardState();
}

class _BalanceCardState extends ConsumerState<BalanceCard> {
  bool _hideBalance = false;

  int get _balanceMinorUnits =>
      ref.watch(profileProvider).profile?.walletBalanceMinorUnits ?? 0;

  String _formatNaira(int minorUnits) {
    final format = NumberFormat.currency(symbol: '₦', decimalDigits: 0);
    return format.format(minorUnits / 100);
  }

  @override
  Widget build(BuildContext context) {
    final balance = _hideBalance ? '₦••••••' : _formatNaira(_balanceMinorUnits);

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
            style: GoogleFonts.inter(
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
                  child: Text(
                    balance,
                    maxLines: 1,
                    style: GoogleFonts.sora(
                      fontSize: 24,
                      fontWeight: FontWeight.w700,
                      color: AppColors.textPrimary,
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 10),
              GestureDetector(
                onTap: () => setState(() => _hideBalance = !_hideBalance),
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
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      'Locked',
                      style: GoogleFonts.inter(
                        fontSize: 11,
                        fontWeight: FontWeight.w600,
                        letterSpacing: 1.2,
                        color: AppColors.textMuted,
                      ),
                    ),
                    const SizedBox(width: 10),
                    Flexible(
                      child: Text(
                        '₦0.00',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: GoogleFonts.sora(
                          fontSize: 16,
                          fontWeight: FontWeight.w600,
                          color: AppColors.textMuted,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 10),
              GestureDetector(
                onTap: () => context.go('/wallet'),
                child: Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                  decoration: BoxDecoration(
                    color: AppColors.voidBg,
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(color: AppColors.brand, width: 1.5),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Icon(LucideIcons.plus,
                          size: 14, color: AppColors.brand),
                      const SizedBox(width: 4),
                      Text(
                        'Add Money',
                        style: GoogleFonts.inter(
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