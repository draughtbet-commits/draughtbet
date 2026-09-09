import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:intl/intl.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../providers/profile_provider.dart';
import '../theme/avatars.dart';
import '../theme/colors.dart';
import '../theme/tier_theme.dart';
import 'package:google_fonts/google_fonts.dart';

class PlayerCard extends ConsumerWidget {
  const PlayerCard({Key? key}) : super(key: key);

  String _formatNaira(int minorUnits) {
    final format = NumberFormat.currency(symbol: '₦', decimalDigits: 0);
    return format.format(minorUnits / 100);
  }

  Future<void> _openAvatarPicker(BuildContext context, WidgetRef ref) {
    final profile = ref.read(profileProvider).profile;
    final currentId = profile?.avatar;

    return showModalBottomSheet<void>(
      context: context,
      backgroundColor: AppColors.surface1,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (sheetContext) {
        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(20, 12, 20, 24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Center(
                  child: Container(
                    width: 36,
                    height: 4,
                    decoration: BoxDecoration(
                      color: AppColors.textMuted.withValues(alpha: 0.4),
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                ),
                const SizedBox(height: 20),
                Text(
                  'Choose your avatar',
                  textAlign: TextAlign.center,
                  style: GoogleFonts.sora(
                    fontSize: 18,
                    fontWeight: FontWeight.w700,
                    color: AppColors.textPrimary,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  'Pick from our predesigned avatars — no uploads',
                  textAlign: TextAlign.center,
                  style: GoogleFonts.inter(
                    fontSize: 13,
                    color: AppColors.textMuted,
                  ),
                ),
                const SizedBox(height: 20),
                GridView.builder(
                  shrinkWrap: true,
                  physics: const NeverScrollableScrollPhysics(),
                  gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                    crossAxisCount: 4,
                    mainAxisSpacing: 16,
                    crossAxisSpacing: 16,
                    childAspectRatio: 1,
                  ),
                  itemCount: avatarCatalog.length,
                  itemBuilder: (context, index) {
                    final avatar = avatarCatalog[index];
                    final selected = avatar.id == currentId;
                    return GestureDetector(
                      onTap: () async {
                        final ok = await ref
                            .read(profileProvider.notifier)
                            .setAvatar(avatar.id);
                        if (sheetContext.mounted) Navigator.pop(sheetContext);
                        if (!ok && context.mounted) {
                          ScaffoldMessenger.of(context).showSnackBar(
                            const SnackBar(
                              content: Text('Couldn\'t update your avatar'),
                              backgroundColor: AppColors.danger,
                            ),
                          );
                        }
                      },
                      child: Container(
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          border: Border.all(
                            color: selected
                                ? AppColors.brand
                                : const Color(0x00000000),
                            width: 3,
                          ),
                        ),
                        padding: const EdgeInsets.all(2),
                        child: ClipOval(
                          child: SvgPicture.asset(
                            avatar.assetPath,
                            fit: BoxFit.cover,
                          ),
                        ),
                      ),
                    );
                  },
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(profileProvider);
    final profile = state.profile;
    final avatar = avatarById(profile?.avatar) ?? defaultAvatar;
    final tier = profile?.tier ?? 'AMATEUR';
    final theme = TierTheme.forTier(tier);

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.surface1,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppColors.hairline),
      ),
      child: Row(
        children: [
          GestureDetector(
            onTap: () => _openAvatarPicker(context, ref),
            child: Stack(
              clipBehavior: Clip.none,
              children: [
                Container(
                  width: 56,
                  height: 56,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    border: Border.all(color: AppColors.brand, width: 2),
                  ),
                  child: ClipOval(
                    child: SvgPicture.asset(avatar.assetPath, fit: BoxFit.cover),
                  ),
                ),
                Positioned(
                  right: -2,
                  bottom: -2,
                  child: Container(
                    width: 22,
                    height: 22,
                    decoration: const BoxDecoration(
                      shape: BoxShape.circle,
                      color: AppColors.brand,
                    ),
                    child: const Icon(
                      LucideIcons.pencil,
                      size: 12,
                      color: AppColors.voidBg,
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Flexible(
                      child: Text(
                        profile?.displayName ?? 'Player',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: GoogleFonts.sora(
                          fontSize: 18,
                          fontWeight: FontWeight.w700,
                          color: AppColors.textPrimary,
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 8, vertical: 3),
                      decoration: BoxDecoration(
                        color: theme.primaryColor.withValues(alpha: 0.15),
                        borderRadius: BorderRadius.circular(20),
                      ),
                      child: Text(
                        theme.displayName,
                        style: GoogleFonts.inter(
                          fontSize: 11,
                          fontWeight: FontWeight.w600,
                          color: theme.primaryColor,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 6),
                Text(
                  _formatNaira(profile?.walletBalanceMinorUnits ?? 0),
                  style: GoogleFonts.inter(
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                    color: AppColors.textMuted,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  'Tap your avatar to change it',
                  style: GoogleFonts.inter(
                    fontSize: 12,
                    color: AppColors.textMuted.withValues(alpha: 0.7),
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