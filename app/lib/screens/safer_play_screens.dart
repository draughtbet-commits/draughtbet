import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../models/match_flow.dart';
import '../providers/eligibility_provider.dart';
import '../theme/colors.dart';
import '../theme/typography.dart';
import '../widgets/flow_widgets.dart';
import 'verification_screens.dart';

class SaferPlayDashboardScreen extends ConsumerWidget {
  const SaferPlayDashboardScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(eligibilityProvider);
    return CanonicalAccountRefresh(
      child: _SaferScaffold(
        title: 'SAFER PLAY',
        child: state.phase != EligibilityLoadPhase.ready
            ? _SaferAvailability(state: state)
            : Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const SizedBox(height: 14),
                  const Center(
                    child: _SaferHero(
                      icon: LucideIcons.shieldCheck,
                      color: AppColors.primaryBright,
                    ),
                  ),
                  const SizedBox(height: 22),
                  Text(
                    'Play smart. Play longer.',
                    textAlign: TextAlign.center,
                    style: AppTypography.heading2,
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'Tools and resources to help you keep control and enjoy the game.',
                    textAlign: TextAlign.center,
                    style: AppTypography.bodySmall,
                  ),
                  const SizedBox(height: 28),
                  _ControlTile(
                    icon: LucideIcons.walletCards,
                    title: 'Deposit limits',
                    subtitle: _limitSummary(
                      state.saferPlay?.effectiveDepositLimitMinorUnits,
                      'Rolling 24-hour limit',
                    ),
                    onTap: () =>
                        context.push('/profile/settings/deposit-limits'),
                  ),
                  _ControlTile(
                    icon: LucideIcons.gauge,
                    title: 'Stake limits',
                    subtitle: _limitSummary(
                      state.saferPlay?.effectiveStakeLimitMinorUnits,
                      'Per-match limit',
                    ),
                    onTap: () => context.push('/profile/settings/stake-limits'),
                  ),
                  _ControlTile(
                    icon: LucideIcons.timerReset,
                    title: 'Take a break',
                    subtitle: 'Temporarily pause real-money play',
                    onTap: () => context.push('/profile/settings/take-a-break'),
                  ),
                  _ControlTile(
                    icon: LucideIcons.userRoundX,
                    title: 'Self-exclusion',
                    subtitle: 'Take a longer break from Draught Bet',
                    onTap: () =>
                        context.push('/profile/settings/self-exclusion'),
                  ),
                  _ControlTile(
                    icon: LucideIcons.bellRing,
                    title: 'Session reminder',
                    subtitle: 'Review elapsed play time',
                    onTap: () =>
                        context.push('/profile/settings/session-reminder'),
                  ),
                  if (state.saferPlay?.isTimeoutActive(DateTime.now()) ==
                          true ||
                      state.saferPlay?.isSelfExcluded(DateTime.now()) == true)
                    _ControlTile(
                      icon: LucideIcons.shieldAlert,
                      title: 'Active restriction',
                      subtitle: 'A server-enforced control is active',
                      color: AppColors.valueAccent,
                      onTap: () =>
                          context.push('/profile/settings/restriction'),
                    ),
                  const SizedBox(height: 18),
                  FlowCard(
                    borderColor: AppColors.valueAccent.withValues(alpha: .65),
                    child: const Text(
                      'A fair game is a better game.',
                      textAlign: TextAlign.center,
                      style: AppTypography.bodyLarge,
                    ),
                  ),
                  if (state.message != null) ...[
                    const SizedBox(height: 12),
                    _SaferMessage(state.message!),
                  ],
                ],
              ),
      ),
    );
  }
}

class LimitEditorScreen extends ConsumerStatefulWidget {
  const LimitEditorScreen({required this.deposit, super.key});
  final bool deposit;

  @override
  ConsumerState<LimitEditorScreen> createState() => _LimitEditorScreenState();
}

class _LimitEditorScreenState extends ConsumerState<LimitEditorScreen> {
  final _controller = TextEditingController();
  String? _validation;
  bool _confirming = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final major = int.tryParse(_controller.text.trim().replaceAll(',', ''));
    if (major == null || major <= 0) {
      setState(() => _validation = 'Enter a valid amount greater than zero.');
      return;
    }
    setState(() {
      _validation = null;
      _confirming = true;
    });
    final confirmed = await _confirmSaferPlayAction(
      context,
      title: widget.deposit ? 'Confirm deposit limit' : 'Confirm stake limit',
      message:
          'Set this limit to ${Money(major * 100).format()}? The server decides whether it is active immediately or enters a cooling period.',
      confirmLabel: 'Confirm limit',
    );
    if (!mounted) return;
    setState(() => _confirming = false);
    if (!confirmed) return;
    final ok = await ref
        .read(eligibilityProvider.notifier)
        .setLimit(deposit: widget.deposit, amount: major * 100);
    if (!mounted || !ok) return;
    context.go(
      '/profile/settings/limit-confirmed?control=${widget.deposit ? 'deposit' : 'stake'}',
    );
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(eligibilityProvider);
    final profile = state.saferPlay;
    final effective = widget.deposit
        ? profile?.effectiveDepositLimitMinorUnits
        : profile?.effectiveStakeLimitMinorUnits;
    final pending = widget.deposit
        ? profile?.pendingDepositLimitMinorUnits
        : profile?.pendingStakeLimitMinorUnits;
    final raisedAt = widget.deposit
        ? profile?.pendingDepositLimitRaisedAt
        : profile?.pendingStakeLimitRaisedAt;
    return CanonicalAccountRefresh(
      child: _SaferScaffold(
        title: widget.deposit ? 'DEPOSIT LIMITS' : 'STAKE LIMITS',
        child: state.phase != EligibilityLoadPhase.ready
            ? _SaferAvailability(state: state)
            : Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  ScreenHeading(
                    title: widget.deposit
                        ? 'Set deposit limit'
                        : 'Set stake limit',
                    subtitle: widget.deposit
                        ? 'Choose the maximum you can deposit in a rolling 24-hour period.'
                        : 'Choose the maximum you can stake on one match.',
                  ),
                  const SizedBox(height: 22),
                  if (effective != null)
                    FlowCard(
                      child: _ValueRow(
                        label: 'Current effective limit',
                        value: Money(effective).format(),
                      ),
                    ),
                  if (pending != null) ...[
                    const SizedBox(height: 10),
                    FlowCard(
                      borderColor: AppColors.valueAccent,
                      child: Column(
                        children: [
                          _ValueRow(
                            label: 'Pending higher limit',
                            value: Money(pending).format(),
                          ),
                          const SizedBox(height: 8),
                          Text(
                            raisedAt == null
                                ? 'The server will confirm when this change is effective.'
                                : 'Requested ${DateFormat.yMMMd().add_jm().format(raisedAt.toLocal())}. The server applies its cooling window.',
                            style: AppTypography.bodySmall,
                          ),
                        ],
                      ),
                    ),
                  ],
                  const SizedBox(height: 22),
                  TextField(
                    key: const Key('limit-amount-field'),
                    controller: _controller,
                    keyboardType: TextInputType.number,
                    inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                    decoration: InputDecoration(
                      labelText: 'Amount (NGN)',
                      hintText: 'Enter amount',
                      errorText: _validation,
                      prefixText: '₦ ',
                    ),
                  ),
                  const SizedBox(height: 16),
                  const _SaferMessage(
                    'Setting or lowering a limit applies immediately. A higher limit is staged by the server and does not apply immediately.',
                  ),
                  const SizedBox(height: 24),
                  PrimaryActionButton(
                    key: const Key('save-limit-button'),
                    label: state.submitting || _confirming
                        ? 'Confirming limit'
                        : 'Review limit',
                    loading: state.submitting || _confirming,
                    onPressed: state.submitting || _confirming ? null : _save,
                  ),
                  if (state.message != null) ...[
                    const SizedBox(height: 12),
                    _SaferMessage(state.message!, danger: true),
                  ],
                ],
              ),
      ),
    );
  }
}

class TakeBreakScreen extends ConsumerStatefulWidget {
  const TakeBreakScreen({super.key});

  @override
  ConsumerState<TakeBreakScreen> createState() => _TakeBreakScreenState();
}

class _TakeBreakScreenState extends ConsumerState<TakeBreakScreen> {
  int _minutes = 24 * 60;
  bool _confirming = false;

  Future<void> _confirm() async {
    setState(() => _confirming = true);
    final confirmed = await _confirmSaferPlayAction(
      context,
      title: 'Start this break?',
      message:
          'Real-money play will be paused for ${_breakLabel(_minutes)}. An active break can only be extended.',
      confirmLabel: 'Start break',
    );
    if (!mounted) return;
    setState(() => _confirming = false);
    if (!confirmed) return;
    final ok = await ref.read(eligibilityProvider.notifier).takeBreak(_minutes);
    if (mounted && ok) context.go('/profile/settings/restriction');
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(eligibilityProvider);
    return CanonicalAccountRefresh(
      child: _SaferScaffold(
        title: 'TAKE A BREAK',
        child: state.phase != EligibilityLoadPhase.ready
            ? _SaferAvailability(state: state)
            : Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Center(
                    child: _SaferHero(
                      icon: LucideIcons.clock3,
                      color: AppColors.primaryBright,
                    ),
                  ),
                  const SizedBox(height: 22),
                  Text(
                    'Take a break',
                    textAlign: TextAlign.center,
                    style: AppTypography.heading2,
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'Pause matchmaking, callouts and staking for a fixed period.',
                    textAlign: TextAlign.center,
                    style: AppTypography.bodySmall,
                  ),
                  const SizedBox(height: 24),
                  for (final option in const {
                    1440: '24 hours',
                    10080: '7 days',
                    43200: '30 days',
                  }.entries)
                    _RadioOption<int>(
                      value: option.key,
                      groupValue: _minutes,
                      label: option.value,
                      onChanged: (value) => setState(() => _minutes = value),
                    ),
                  const SizedBox(height: 36),
                  const _SaferMessage(
                    'An active break can only be extended. It cannot be shortened in the app.',
                  ),
                  const SizedBox(height: 16),
                  PrimaryActionButton(
                    label: state.submitting || _confirming
                        ? 'Confirming break'
                        : 'Continue',
                    loading: state.submitting || _confirming,
                    onPressed: state.submitting || _confirming
                        ? null
                        : _confirm,
                  ),
                ],
              ),
      ),
    );
  }
}

class SelfExclusionScreen extends ConsumerStatefulWidget {
  const SelfExclusionScreen({super.key});

  @override
  ConsumerState<SelfExclusionScreen> createState() =>
      _SelfExclusionScreenState();
}

class _SelfExclusionScreenState extends ConsumerState<SelfExclusionScreen> {
  String _until = '30d';
  bool _understood = false;
  bool _confirming = false;

  Future<void> _confirm() async {
    setState(() => _confirming = true);
    final confirmed = await _confirmSaferPlayAction(
      context,
      title: 'Confirm self-exclusion',
      message:
          'Deposits, withdrawals and real-money play will be blocked for ${_exclusionLabel(_until)}. This cannot be ended from the app.',
      confirmLabel: 'Confirm exclusion',
      destructive: true,
    );
    if (!mounted) return;
    setState(() => _confirming = false);
    if (!confirmed) return;
    final ok = await ref.read(eligibilityProvider.notifier).selfExclude(_until);
    if (mounted && ok) context.go('/profile/settings/restriction');
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(eligibilityProvider);
    return CanonicalAccountRefresh(
      child: _SaferScaffold(
        title: 'SELF-EXCLUSION',
        child: state.phase != EligibilityLoadPhase.ready
            ? _SaferAvailability(state: state)
            : Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Center(
                    child: _SaferHero(
                      icon: LucideIcons.userRoundX,
                      color: AppColors.valueAccent,
                    ),
                  ),
                  const SizedBox(height: 22),
                  Text(
                    'Self-exclusion',
                    textAlign: TextAlign.center,
                    style: AppTypography.heading2,
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'Block deposits, withdrawals and real-money play for the selected period.',
                    textAlign: TextAlign.center,
                    style: AppTypography.bodySmall,
                  ),
                  const SizedBox(height: 22),
                  for (final option in const {
                    '30d': '30 days',
                    '90d': '90 days',
                    '365d': '1 year',
                  }.entries)
                    _RadioOption<String>(
                      value: option.key,
                      groupValue: _until,
                      label: option.value,
                      onChanged: (value) => setState(() => _until = value),
                    ),
                  const SizedBox(height: 14),
                  FlowCard(
                    borderColor: AppColors.valueAccent,
                    padding: EdgeInsets.zero,
                    child: Semantics(
                      checked: _understood,
                      button: true,
                      label: 'I understand this cannot be ended from the app',
                      child: InkWell(
                        borderRadius: BorderRadius.circular(16),
                        onTap: () => setState(() => _understood = !_understood),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 12,
                            vertical: 10,
                          ),
                          child: Row(
                            children: [
                              Checkbox(
                                value: _understood,
                                activeColor: AppColors.primaryAction,
                                onChanged: (value) =>
                                    setState(() => _understood = value == true),
                              ),
                              const SizedBox(width: 8),
                              const Expanded(
                                child: Text(
                                  'I understand this cannot be ended from the app.',
                                  style: AppTypography.bodyLarge,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 22),
                  PrimaryActionButton(
                    label: state.submitting
                        ? 'Confirming exclusion'
                        : 'Confirm self-exclusion',
                    destructive: true,
                    loading: state.submitting || _confirming,
                    onPressed: !_understood || state.submitting || _confirming
                        ? null
                        : _confirm,
                  ),
                ],
              ),
      ),
    );
  }
}

class SessionReminderScreen extends StatelessWidget {
  const SessionReminderScreen({super.key});

  @override
  Widget build(BuildContext context) => _SaferScaffold(
    title: 'SESSION REMINDER',
    child: Column(
      children: [
        const SizedBox(height: 36),
        const _SaferHero(icon: LucideIcons.timer, color: AppColors.valueAccent),
        const SizedBox(height: 22),
        Text('Time for a check-in', style: AppTypography.heading2),
        const SizedBox(height: 10),
        Text(
          'Session duration is not available from the current server contract. Review your play and take a break if needed.',
          textAlign: TextAlign.center,
          style: AppTypography.bodyLarge.copyWith(
            color: AppColors.textSecondary,
          ),
        ),
        const SizedBox(height: 36),
        PrimaryActionButton(
          label: 'Take a break',
          icon: LucideIcons.timerReset,
          onPressed: () => context.go('/profile/settings/take-a-break'),
        ),
        const SizedBox(height: 10),
        SecondaryActionButton(
          label: 'Continue',
          onPressed: () => context.pop(),
        ),
      ],
    ),
  );
}

class ActiveRestrictionScreen extends ConsumerWidget {
  const ActiveRestrictionScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(eligibilityProvider);
    final profile = state.saferPlay;
    final now = DateTime.now();
    final selfExcluded = profile?.isSelfExcluded(now) ?? false;
    final timedOut = profile?.isTimeoutActive(now) ?? false;
    final until = selfExcluded
        ? profile?.selfExcludedUntil
        : profile?.timeoutUntil;
    final active = selfExcluded || timedOut;
    return CanonicalAccountRefresh(
      child: _SaferScaffold(
        title: 'ACTIVE RESTRICTION',
        child: state.phase != EligibilityLoadPhase.ready
            ? _SaferAvailability(state: state)
            : Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const SizedBox(height: 36),
                  const Center(
                    child: _SaferHero(
                      icon: LucideIcons.shieldAlert,
                      color: AppColors.valueAccent,
                    ),
                  ),
                  const SizedBox(height: 22),
                  Text(
                    !active
                        ? 'NO ACTIVE RESTRICTION'
                        : selfExcluded
                        ? 'SELF-EXCLUSION ACTIVE'
                        : 'BREAK ACTIVE',
                    textAlign: TextAlign.center,
                    style: AppTypography.heading2.copyWith(
                      color: AppColors.valueAccent,
                    ),
                  ),
                  const SizedBox(height: 10),
                  Text(
                    !active
                        ? 'The server did not return an active break or self-exclusion.'
                        : until == null
                        ? 'The server confirmed a restriction, but its end time is unavailable.'
                        : 'This restriction is active until ${DateFormat.yMMMd().add_jm().format(until.toLocal())}.',
                    textAlign: TextAlign.center,
                    style: AppTypography.bodyLarge.copyWith(
                      color: AppColors.textSecondary,
                    ),
                  ),
                  const SizedBox(height: 24),
                  if (active)
                    FlowCard(
                      child: Text(
                        selfExcluded
                            ? 'Deposits, withdrawals and real-money play remain blocked across devices.'
                            : 'Matchmaking, callouts and staking remain blocked across devices.',
                        textAlign: TextAlign.center,
                        style: AppTypography.bodyLarge,
                      ),
                    ),
                  const SizedBox(height: 36),
                  PrimaryActionButton(
                    label: 'Back to Home',
                    onPressed: () => context.go('/home'),
                  ),
                ],
              ),
      ),
    );
  }
}

class LimitConfirmedScreen extends ConsumerWidget {
  const LimitConfirmedScreen({this.deposit, super.key});

  final bool? deposit;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(eligibilityProvider);
    final profile = state.saferPlay;
    final pending = switch (deposit) {
      true => profile?.pendingDepositLimitMinorUnits,
      false => profile?.pendingStakeLimitMinorUnits,
      null =>
        profile?.pendingDepositLimitMinorUnits ??
            profile?.pendingStakeLimitMinorUnits,
    };
    final effective = switch (deposit) {
      true => profile?.effectiveDepositLimitMinorUnits,
      false => profile?.effectiveStakeLimitMinorUnits,
      null =>
        profile?.effectiveDepositLimitMinorUnits ??
            profile?.effectiveStakeLimitMinorUnits,
    };
    final confirmed = pending != null || effective != null;
    return CanonicalAccountRefresh(
      child: _SaferScaffold(
        title: 'LIMIT CONFIRMED',
        child: state.phase != EligibilityLoadPhase.ready
            ? _SaferAvailability(state: state)
            : Column(
                children: [
                  const SizedBox(height: 36),
                  const _SaferHero(
                    icon: LucideIcons.circleCheckBig,
                    color: AppColors.primaryBright,
                  ),
                  const SizedBox(height: 22),
                  Text(
                    confirmed ? 'LIMIT CONFIRMED' : 'LIMIT STATUS UNAVAILABLE',
                    textAlign: TextAlign.center,
                    style: AppTypography.heading2,
                  ),
                  const SizedBox(height: 10),
                  Text(
                    pending != null
                        ? 'The server staged ${Money(pending).format()} for its cooling window. Your current effective limit remains active.'
                        : effective != null
                        ? 'The server confirmed an effective limit of ${Money(effective).format()}.'
                        : 'The server did not return a confirmed limit. No active value is being inferred by the app.',
                    textAlign: TextAlign.center,
                    style: AppTypography.bodyLarge.copyWith(
                      color: AppColors.textSecondary,
                    ),
                  ),
                  const SizedBox(height: 36),
                  PrimaryActionButton(
                    label: 'Done',
                    onPressed: () => context.go('/profile/settings/safer-play'),
                  ),
                ],
              ),
      ),
    );
  }
}

class _SaferScaffold extends StatelessWidget {
  const _SaferScaffold({required this.title, required this.child});
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
          keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
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

class _SaferAvailability extends ConsumerWidget {
  const _SaferAvailability({required this.state});

  final EligibilityState state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final loading =
        state.phase == EligibilityLoadPhase.initial ||
        state.phase == EligibilityLoadPhase.loading;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 36),
        Center(
          child: _SaferHero(
            icon: loading ? LucideIcons.loaderCircle : LucideIcons.cloudOff,
            color: loading ? AppColors.primaryBright : AppColors.valueAccent,
          ),
        ),
        const SizedBox(height: 22),
        Text(
          loading ? 'LOADING SAFER-PLAY CONTROLS' : 'CONTROLS UNAVAILABLE',
          textAlign: TextAlign.center,
          style: AppTypography.heading2,
        ),
        const SizedBox(height: 10),
        Text(
          loading
              ? 'Checking the controls currently confirmed by the server.'
              : state.message ??
                    'The server did not confirm the current controls. No restriction or limit will be changed.',
          textAlign: TextAlign.center,
          style: AppTypography.bodyLarge.copyWith(
            color: AppColors.textSecondary,
          ),
        ),
        const SizedBox(height: 36),
        PrimaryActionButton(
          label: loading ? 'Checking status' : 'Try again',
          icon: LucideIcons.refreshCw,
          loading: loading,
          onPressed: loading
              ? null
              : () => ref.read(eligibilityProvider.notifier).refreshCanonical(),
        ),
      ],
    );
  }
}

Future<bool> _confirmSaferPlayAction(
  BuildContext context, {
  required String title,
  required String message,
  required String confirmLabel,
  bool destructive = false,
}) async {
  final confirmed = await showDialog<bool>(
    context: context,
    barrierDismissible: false,
    builder: (dialogContext) => AlertDialog(
      backgroundColor: AppColors.surfaceRaised,
      title: Text(title, style: AppTypography.heading3),
      content: Text(message, style: AppTypography.bodyLarge),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(dialogContext).pop(false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          key: const Key('confirm-safer-play-action'),
          style: FilledButton.styleFrom(
            backgroundColor: destructive
                ? AppColors.danger
                : AppColors.primaryAction,
          ),
          onPressed: () => Navigator.of(dialogContext).pop(true),
          child: Text(confirmLabel),
        ),
      ],
    ),
  );
  return confirmed == true;
}

String _breakLabel(int minutes) => switch (minutes) {
  1440 => '24 hours',
  10080 => '7 days',
  43200 => '30 days',
  _ => '$minutes minutes',
};

String _exclusionLabel(String until) => switch (until) {
  '30d' => '30 days',
  '90d' => '90 days',
  '365d' => '1 year',
  _ => 'the selected period',
};

class _SaferHero extends StatelessWidget {
  const _SaferHero({required this.icon, required this.color});
  final IconData icon;
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
    width: 116,
    height: 116,
    decoration: BoxDecoration(
      shape: BoxShape.circle,
      color: color.withValues(alpha: .1),
      border: Border.all(color: color, width: 3),
      boxShadow: [
        BoxShadow(color: color.withValues(alpha: .25), blurRadius: 28),
      ],
    ),
    child: Icon(icon, color: color, size: 54),
  );
}

class _ControlTile extends StatelessWidget {
  const _ControlTile({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.onTap,
    this.color = AppColors.primaryBright,
  });
  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback onTap;
  final Color color;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 9),
    child: InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(13),
      child: Ink(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(13),
          border: Border.all(color: AppColors.border),
        ),
        child: Row(
          children: [
            Icon(icon, color: color, size: 25),
            const SizedBox(width: 13),
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
            const Icon(
              LucideIcons.chevronRight,
              color: AppColors.textSecondary,
            ),
          ],
        ),
      ),
    ),
  );
}

class _RadioOption<T> extends StatelessWidget {
  const _RadioOption({
    required this.value,
    required this.groupValue,
    required this.label,
    required this.onChanged,
  });
  final T value;
  final T groupValue;
  final String label;
  final ValueChanged<T> onChanged;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 9),
    child: InkWell(
      onTap: () => onChanged(value),
      borderRadius: BorderRadius.circular(12),
      child: Ink(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(
            color: value == groupValue
                ? AppColors.primaryBright
                : AppColors.border,
          ),
        ),
        child: Row(
          children: [
            Icon(
              value == groupValue ? LucideIcons.circleDot : LucideIcons.circle,
              color: value == groupValue
                  ? AppColors.primaryBright
                  : AppColors.textSecondary,
            ),
            const SizedBox(width: 12),
            Text(label, style: AppTypography.bodyLarge),
          ],
        ),
      ),
    ),
  );
}

class _ValueRow extends StatelessWidget {
  const _ValueRow({required this.label, required this.value});
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      Expanded(child: Text(label, style: AppTypography.bodySmall)),
      Text(value, style: AppTypography.bodyMedium),
    ],
  );
}

class _SaferMessage extends StatelessWidget {
  const _SaferMessage(this.message, {this.danger = false});
  final String message;
  final bool danger;

  @override
  Widget build(BuildContext context) => FlowCard(
    borderColor: danger ? AppColors.danger : AppColors.border,
    padding: const EdgeInsets.all(13),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(
          danger ? LucideIcons.triangleAlert : LucideIcons.info,
          color: danger ? AppColors.danger : AppColors.primaryBright,
          size: 19,
        ),
        const SizedBox(width: 10),
        Expanded(child: Text(message, style: AppTypography.bodySmall)),
      ],
    ),
  );
}

String _limitSummary(int? minor, String prefix) =>
    minor == null ? '$prefix · Not set' : '$prefix · ${Money(minor).format()}';
