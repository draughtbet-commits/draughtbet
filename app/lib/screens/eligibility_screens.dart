import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../models/eligibility.dart';
import '../providers/eligibility_provider.dart';
import '../theme/colors.dart';
import '../theme/typography.dart';
import '../widgets/flow_widgets.dart';

class AgeLegalEligibilityScreen extends StatelessWidget {
  const AgeLegalEligibilityScreen({super.key});

  @override
  Widget build(BuildContext context) => _EligibilityScaffold(
    title: 'AGE & ELIGIBILITY',
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 36),
        const _EligibilityHero(
          icon: LucideIcons.shieldCheck,
          color: AppColors.valueAccent,
        ),
        const SizedBox(height: 24),
        Text(
          'PLAY RESPONSIBLY',
          textAlign: TextAlign.center,
          style: AppTypography.heading2,
        ),
        const SizedBox(height: 10),
        Text(
          'Draught Bet is available only to eligible adults in supported countries.',
          textAlign: TextAlign.center,
          style: AppTypography.bodyLarge.copyWith(
            color: AppColors.textSecondary,
          ),
        ),
        const SizedBox(height: 24),
        const FlowCard(
          child: Column(
            children: [
              _RuleRow(
                icon: LucideIcons.calendarCheck,
                title: 'You must be at least 18',
                subtitle: 'Your date of birth is checked by the server.',
              ),
              _RuleRow(
                icon: LucideIcons.mapPinCheck,
                title: 'You must be in a supported country',
                subtitle: 'Location eligibility is resolved by the server.',
              ),
              _RuleRow(
                icon: LucideIcons.scale,
                title: 'Real-money play has limits',
                subtitle: 'Safer-play controls apply across every device.',
              ),
            ],
          ),
        ),
        const SizedBox(height: 36),
        PrimaryActionButton(label: 'Continue', onPressed: () => context.pop()),
      ],
    ),
  );
}

class EligibilityBlockedScreen extends ConsumerWidget {
  const EligibilityBlockedScreen({this.decision, super.key});
  final EligibilityDecision? decision;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final effective = decision ?? ref.watch(eligibilityProvider).decision;
    final display = _blockedDisplay(effective);
    return _EligibilityScaffold(
      title: 'ACTION BLOCKED',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const SizedBox(height: 36),
          _EligibilityHero(icon: display.icon, color: display.color),
          const SizedBox(height: 24),
          Text(
            display.title,
            textAlign: TextAlign.center,
            style: AppTypography.heading2.copyWith(color: display.color),
          ),
          const SizedBox(height: 10),
          Text(
            effective?.message ??
                'The server did not confirm eligibility for this action.',
            textAlign: TextAlign.center,
            style: AppTypography.bodyLarge.copyWith(
              color: AppColors.textSecondary,
            ),
          ),
          const SizedBox(height: 24),
          FlowCard(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(LucideIcons.info, color: AppColors.primaryBright),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    display.explanation,
                    style: AppTypography.bodySmall,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 36),
          PrimaryActionButton(
            label: display.primaryLabel,
            icon: display.icon,
            onPressed: () => _remediate(context, effective?.remediation),
          ),
          const SizedBox(height: 10),
          SecondaryActionButton(
            label: 'Back to Home',
            onPressed: () => context.go('/home'),
          ),
        ],
      ),
    );
  }
}

class AccountRestrictedScreen extends StatelessWidget {
  const AccountRestrictedScreen({this.caseReference, super.key});
  final String? caseReference;

  String get maskedReference {
    final value = caseReference?.trim();
    if (value == null || value.length < 6) return 'Unavailable';
    return '${value.substring(0, 3)}••••${value.substring(value.length - 3)}';
  }

  @override
  Widget build(BuildContext context) => _EligibilityScaffold(
    title: 'ACCOUNT RESTRICTED',
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 36),
        const _EligibilityHero(
          icon: LucideIcons.lockKeyhole,
          color: AppColors.valueAccent,
        ),
        const SizedBox(height: 24),
        Text(
          'ACCOUNT RESTRICTED',
          textAlign: TextAlign.center,
          style: AppTypography.heading2,
        ),
        const SizedBox(height: 10),
        Text(
          'Your account is currently restricted while it is reviewed.',
          textAlign: TextAlign.center,
          style: AppTypography.bodyLarge.copyWith(
            color: AppColors.textSecondary,
          ),
        ),
        const SizedBox(height: 24),
        FlowCard(
          child: Row(
            children: [
              Expanded(
                child: Text('Case reference', style: AppTypography.bodySmall),
              ),
              Text(maskedReference, style: AppTypography.bodyMedium),
            ],
          ),
        ),
        const SizedBox(height: 16),
        const Text(
          'No money or play action will be attempted while this restriction is active.',
          textAlign: TextAlign.center,
          style: AppTypography.bodySmall,
        ),
        const SizedBox(height: 36),
        PrimaryActionButton(
          label: 'Go to Home',
          onPressed: () => context.go('/home'),
        ),
      ],
    ),
  );
}

class _EligibilityScaffold extends StatelessWidget {
  const _EligibilityScaffold({required this.title, required this.child});
  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: AppColors.background,
    appBar: AppBar(
      title: Text(title),
      backgroundColor: AppColors.background,
      elevation: 0,
    ),
    body: SafeArea(
      child: LayoutBuilder(
        builder: (context, constraints) => SingleChildScrollView(
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 560),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
                child: ConstrainedBox(
                  constraints: BoxConstraints(
                    minHeight: constraints.maxHeight > 32
                        ? constraints.maxHeight - 32
                        : 0,
                  ),
                  child: child,
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

class _EligibilityHero extends StatelessWidget {
  const _EligibilityHero({required this.icon, required this.color});
  final IconData icon;
  final Color color;

  @override
  Widget build(BuildContext context) => Center(
    child: Container(
      width: 122,
      height: 122,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: color.withValues(alpha: .1),
        border: Border.all(color: color, width: 3),
        boxShadow: [
          BoxShadow(color: color.withValues(alpha: .24), blurRadius: 30),
        ],
      ),
      child: Icon(icon, color: color, size: 56),
    ),
  );
}

class _RuleRow extends StatelessWidget {
  const _RuleRow({
    required this.icon,
    required this.title,
    required this.subtitle,
  });
  final IconData icon;
  final String title;
  final String subtitle;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 8),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, color: AppColors.primaryBright, size: 22),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: AppTypography.bodyMedium),
              const SizedBox(height: 2),
              Text(subtitle, style: AppTypography.bodySmall),
            ],
          ),
        ),
      ],
    ),
  );
}

class _BlockedDisplay {
  const _BlockedDisplay({
    required this.title,
    required this.explanation,
    required this.primaryLabel,
    required this.icon,
    required this.color,
  });
  final String title;
  final String explanation;
  final String primaryLabel;
  final IconData icon;
  final Color color;
}

_BlockedDisplay _blockedDisplay(EligibilityDecision? decision) {
  return switch (decision?.reason) {
    EligibilityReason.kycRequired ||
    EligibilityReason.ageNotVerified => const _BlockedDisplay(
      title: 'VERIFICATION REQUIRED',
      explanation:
          'Complete the server-owned verification step, then submit the original action again.',
      primaryLabel: 'Verify identity',
      icon: LucideIcons.shieldCheck,
      color: AppColors.valueAccent,
    ),
    EligibilityReason.stakeLimitExceeded ||
    EligibilityReason.depositLimitExceeded => const _BlockedDisplay(
      title: 'LIMIT REACHED',
      explanation:
          'Your current effective safer-play limit remains active across every device.',
      primaryLabel: 'View limits',
      icon: LucideIcons.gauge,
      color: AppColors.valueAccent,
    ),
    EligibilityReason.timeoutActive ||
    EligibilityReason.selfExcluded => const _BlockedDisplay(
      title: 'RESTRICTION ACTIVE',
      explanation:
          'This server-enforced restriction cannot be bypassed or shortened in Flutter.',
      primaryLabel: 'View restriction',
      icon: LucideIcons.shieldAlert,
      color: AppColors.valueAccent,
    ),
    EligibilityReason.accountRestricted ||
    EligibilityReason.countryNotAllowed ||
    EligibilityReason.eligibilityRequired => const _BlockedDisplay(
      title: 'ACCOUNT RESTRICTED',
      explanation:
          'The app cannot change this server decision. Contact support if you need help.',
      primaryLabel: 'View details',
      icon: LucideIcons.lockKeyhole,
      color: AppColors.danger,
    ),
    _ => const _BlockedDisplay(
      title: 'ELIGIBILITY UNAVAILABLE',
      explanation:
          'No protected action was completed because the server decision is unavailable.',
      primaryLabel: 'Try again later',
      icon: LucideIcons.cloudOff,
      color: AppColors.valueAccent,
    ),
  };
}

void _remediate(BuildContext context, EligibilityRemediation? remediation) {
  switch (remediation) {
    case EligibilityRemediation.verifyIdentity:
      context.go('/profile/verification');
    case EligibilityRemediation.viewLimits:
    case EligibilityRemediation.saferPlay:
      context.go('/profile/settings/safer-play');
    case EligibilityRemediation.wait:
      context.go('/profile/settings/restriction');
    case EligibilityRemediation.contactSupport:
      context.go('/profile/settings/account-restricted');
    case EligibilityRemediation.retry:
    case EligibilityRemediation.none:
    case null:
      context.go('/home');
  }
}
