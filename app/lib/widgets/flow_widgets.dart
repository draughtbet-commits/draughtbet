import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../models/match_flow.dart';
import '../theme/avatars.dart';
import '../theme/colors.dart';

class FlowPage extends StatelessWidget {
  const FlowPage({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.fromLTRB(16, 8, 16, 24),
    this.scrollable = true,
  });

  final Widget child;
  final EdgeInsets padding;
  final bool scrollable;

  @override
  Widget build(BuildContext context) {
    final content = Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 560),
        child: Padding(padding: padding, child: child),
      ),
    );
    return DecoratedBox(
      decoration: const BoxDecoration(
        color: AppColors.background,
        gradient: RadialGradient(
          center: Alignment(0.9, -1.1),
          radius: 1.2,
          colors: [AppColors.primaryGlow, AppColors.background],
        ),
      ),
      child: scrollable
          ? SingleChildScrollView(
              keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
              child: content,
            )
          : content,
    );
  }
}

class FlowCard extends StatelessWidget {
  const FlowCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(16),
    this.borderColor = AppColors.border,
    this.color = AppColors.surface,
    this.onTap,
  });

  final Widget child;
  final EdgeInsets padding;
  final Color borderColor;
  final Color color;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final card = Container(
      width: double.infinity,
      padding: padding,
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: borderColor),
      ),
      child: child,
    );
    if (onTap == null) return card;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: card,
    );
  }
}

/// A single-thumb stake picker over a server-derived [min, max] range in minor
/// units. Renders the live amount plus both range ends so the player always sees
/// the bounds they are choosing within. Values snap to [stepMinorUnits]; the
/// division count is capped so a huge range does not create a jittery track.
class StakeSlider extends StatelessWidget {
  const StakeSlider({
    super.key,
    required this.value,
    required this.min,
    required this.max,
    required this.onChanged,
    this.stepMinorUnits = 50000,
    this.maxDivisions = 600,
    this.label,
  });

  final int value;
  final int min;
  final int max;
  final ValueChanged<int> onChanged;
  final int stepMinorUnits;
  final int maxDivisions;
  final String? label;

  @override
  Widget build(BuildContext context) {
    // Bounds can invert while tier limits are mid-load; keep the track sane.
    final lo = min <= max ? min : max;
    final hi = max >= min ? max : min;
    final current = value < lo ? lo : (value > hi ? hi : value);
    final divisions = hi > lo ? ((hi - lo) ~/ stepMinorUnits).clamp(1, maxDivisions) : 1;
    const valueStyle = TextStyle(
      fontFamily: 'Inter',
      fontSize: 13,
      fontWeight: FontWeight.w600,
      color: AppColors.textPrimary,
    );
    const boundStyle = TextStyle(fontSize: 10, color: AppColors.textSecondary);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (label != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Text(
              label!,
              style: const TextStyle(
                fontFamily: 'Inter',
                color: AppColors.textSecondary,
                fontSize: 11,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        Text('Stake: ${Money(current).format()}', style: valueStyle),
        Slider(
          value: current.toDouble(),
          min: lo.toDouble(),
          max: hi.toDouble(),
          divisions: divisions,
          onChanged: (v) => onChanged(v.toInt()),
        ),
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(Money(lo).format(), style: boundStyle),
            Text(Money(hi).format(), style: boundStyle),
          ],
        ),
      ],
    );
  }
}

class PrimaryActionButton extends StatelessWidget {
  const PrimaryActionButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.icon,
    this.loading = false,
    this.destructive = false,
  });

  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;
  final bool loading;
  final bool destructive;

  @override
  Widget build(BuildContext context) {
    final background = destructive ? AppColors.danger : AppColors.primaryAction;
    return Semantics(
      button: true,
      enabled: onPressed != null && !loading,
      label: loading ? '$label, in progress' : label,
      child: SizedBox(
        width: double.infinity,
        height: 52,
        child: FilledButton.icon(
          onPressed: loading ? null : onPressed,
          style: FilledButton.styleFrom(
            backgroundColor: background,
            disabledBackgroundColor: background.withValues(alpha: 0.45),
            foregroundColor: AppColors.textPrimary,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(11),
            ),
            textStyle: TextStyle(
              fontFamily: 'Inter',
              fontSize: 15,
              fontWeight: FontWeight.w700,
            ),
          ),
          icon: loading
              ? const SizedBox.square(
                  dimension: 18,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: AppColors.textPrimary,
                  ),
                )
              : Icon(icon ?? LucideIcons.arrowRight, size: 19),
          label: Text(label),
        ),
      ),
    );
  }
}

class SecondaryActionButton extends StatelessWidget {
  const SecondaryActionButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.icon,
    this.loading = false,
  });

  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;
  final bool loading;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      enabled: onPressed != null && !loading,
      child: SizedBox(
        width: double.infinity,
        height: 50,
        child: OutlinedButton.icon(
          onPressed: loading ? null : onPressed,
          style: OutlinedButton.styleFrom(
            foregroundColor: AppColors.textPrimary,
            side: const BorderSide(color: AppColors.valueAccent),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(11),
            ),
            textStyle: TextStyle(
              fontFamily: 'Inter',
              fontWeight: FontWeight.w600,
            ),
          ),
          icon: loading
              ? const SizedBox.square(
                  dimension: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : Icon(icon ?? LucideIcons.arrowLeft, size: 18),
          label: Text(label),
        ),
      ),
    );
  }
}

class GameAvatar extends StatelessWidget {
  const GameAvatar({
    super.key,
    this.avatarId = 'avatar_01',
    this.size = 52,
    this.accent = AppColors.primaryBright,
    this.label,
  });

  final String avatarId;
  final double size;
  final Color accent;
  final String? label;

  @override
  Widget build(BuildContext context) {
    final avatar = avatarById(avatarId) ?? defaultAvatar;
    return Semantics(
      image: true,
      label: label == null ? 'Player avatar' : '$label avatar',
      child: Container(
        width: size,
        height: size,
        padding: const EdgeInsets.all(2),
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: AppColors.background,
          border: Border.all(color: accent, width: 2),
          boxShadow: [
            BoxShadow(color: accent.withValues(alpha: 0.2), blurRadius: 10),
          ],
        ),
        child: ClipOval(
          child: SvgPicture.asset(avatar.assetPath, fit: BoxFit.cover),
        ),
      ),
    );
  }
}

class RankPill extends StatelessWidget {
  const RankPill({super.key, required this.label, this.color});

  final String label;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final accent = color ?? AppColors.valueAccent;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: accent.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: accent.withValues(alpha: 0.45)),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontFamily: 'Inter',
          color: accent,
          fontSize: 10,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

class ScreenHeading extends StatelessWidget {
  const ScreenHeading({
    super.key,
    required this.title,
    required this.subtitle,
    this.trailing,
  });

  final String title;
  final String subtitle;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                title,
                style: TextStyle(
                  fontFamily: 'Sora',
                  fontSize: 22,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 3),
              Text(
                subtitle,
                style: TextStyle(
                  fontFamily: 'Inter',
                  color: AppColors.textSecondary,
                  fontSize: 12,
                ),
              ),
            ],
          ),
        ),
        trailing ?? const SizedBox.shrink(),
      ],
    );
  }
}

class MatchTermsCard extends StatelessWidget {
  const MatchTermsCard({super.key, required this.terms});

  final MatchTerms terms;

  Widget _row(String label, String value, {Color? color}) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(
        children: [
          Expanded(
            child: Text(
              label,
              style: TextStyle(
                fontFamily: 'Inter',
                fontSize: 12,
                color: AppColors.textSecondary,
              ),
            ),
          ),
          Text(
            value,
            style: TextStyle(
              fontFamily: 'Inter',
              fontSize: 12,
              fontWeight: FontWeight.w600,
              color: color ?? AppColors.textPrimary,
            ),
          ),
        ],
      ),
    );
  }

  String _amount(int? value) =>
      value == null ? 'Server confirms' : Money(value).format();

  @override
  Widget build(BuildContext context) {
    return FlowCard(
      child: Column(
        children: [
          _row('Stake', Money(terms.stakeMinorUnits).format()),
          if (terms.opponentStakeMinorUnits != null)
            _row('Opponent stake', _amount(terms.opponentStakeMinorUnits)),
          _row('Platform fee', _amount(terms.platformFeeMinorUnits)),
          _row(
            'Total prize',
            _amount(terms.totalPrizeMinorUnits),
            color: terms.totalPrizeMinorUnits == null
                ? AppColors.textSecondary
                : AppColors.valueAccent,
          ),
          const Divider(height: 18),
          _row('Time control', terms.timeControl),
          _row('Game type', terms.gameType),
          _row('Board', terms.board),
        ],
      ),
    );
  }
}

class RecoverableState extends StatelessWidget {
  const RecoverableState({
    super.key,
    required this.title,
    required this.message,
    required this.actionLabel,
    required this.onAction,
    this.icon = LucideIcons.refreshCw,
  });

  final String title;
  final String message;
  final String actionLabel;
  final VoidCallback onAction;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    // The message wraps, so the natural height depends on the text and the
    // font scale. Sizing this to a fixed box overflowed by 45px on a real
    // device in the wallet's compact empty state, which is a visible yellow
    // stripe for a new player with no transactions. Scrolling the block keeps
    // the layout rhythm of the parent without ever clipping the action.
    return SingleChildScrollView(
      child: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 44, color: AppColors.textSecondary),
              const SizedBox(height: 16),
              Text(
                title,
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontFamily: 'Sora',
                  fontSize: 19,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                message,
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontFamily: 'Inter',
                  color: AppColors.textSecondary,
                ),
              ),
              const SizedBox(height: 20),
              SizedBox(
                width: 220,
                child: PrimaryActionButton(
                  label: actionLabel,
                  onPressed: onAction,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
