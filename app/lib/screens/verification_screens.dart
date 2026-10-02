import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../models/eligibility.dart';
import '../providers/eligibility_provider.dart';
import '../theme/colors.dart';
import '../theme/typography.dart';
import '../widgets/flow_widgets.dart';

class CanonicalAccountRefresh extends ConsumerStatefulWidget {
  const CanonicalAccountRefresh({required this.child, super.key});
  final Widget child;

  @override
  ConsumerState<CanonicalAccountRefresh> createState() =>
      _CanonicalAccountRefreshState();
}

class _CanonicalAccountRefreshState
    extends ConsumerState<CanonicalAccountRefresh>
    with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        ref.read(eligibilityProvider.notifier).refreshCanonical();
      }
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      ref.read(eligibilityProvider.notifier).refreshCanonical();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

class VerificationIntroScreen extends ConsumerWidget {
  const VerificationIntroScreen({super.key});

  void _start(BuildContext context, EligibilityState state) {
    final status = state.verification?.status;
    if (status != null &&
        status != VerificationStatus.notRequired &&
        status != VerificationStatus.required &&
        status != VerificationStatus.rejected &&
        status != VerificationStatus.expired &&
        status != VerificationStatus.unavailable) {
      context.go(_routeForStatus(status));
      return;
    }
    context.push('/profile/verification/personal-details');
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(eligibilityProvider);
    return CanonicalAccountRefresh(
      child: _VerificationScaffold(
        title: 'VERIFY YOUR IDENTITY',
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const SizedBox(height: 36),
            const _HeroIcon(
              icon: LucideIcons.badgeCheck,
              color: AppColors.primaryBright,
            ),
            const SizedBox(height: 24),
            Text(
              'VERIFY YOUR IDENTITY',
              textAlign: TextAlign.center,
              style: AppTypography.heading2,
            ),
            const SizedBox(height: 8),
            Text(
              'A quick and secure process to confirm it is really you.',
              textAlign: TextAlign.center,
              style: AppTypography.bodyLarge.copyWith(
                color: AppColors.textSecondary,
              ),
            ),
            const SizedBox(height: 28),
            const FlowCard(
              child: Column(
                children: [
                  _BenefitRow(
                    icon: LucideIcons.landmark,
                    label: 'Required for withdrawals',
                  ),
                  _BenefitRow(
                    icon: LucideIcons.shieldCheck,
                    label: 'Helps keep your account safe',
                  ),
                  _BenefitRow(
                    icon: LucideIcons.clock3,
                    label: 'Status is confirmed by the server',
                  ),
                ],
              ),
            ),
            if (state.message != null) ...[
              const SizedBox(height: 12),
              _InlineMessage(state.message!),
            ],
            const SizedBox(height: 36),
            PrimaryActionButton(
              label: 'Continue',
              icon: LucideIcons.shieldCheck,
              onPressed: () => _start(context, state),
            ),
            const SizedBox(height: 10),
            TextButton(
              onPressed: () => context.pop(),
              child: const Text('Maybe later'),
            ),
          ],
        ),
      ),
    );
  }
}

class VerificationPersonalDetailsScreen extends StatefulWidget {
  const VerificationPersonalDetailsScreen({super.key});

  @override
  State<VerificationPersonalDetailsScreen> createState() =>
      _VerificationPersonalDetailsScreenState();
}

class _VerificationPersonalDetailsScreenState
    extends State<VerificationPersonalDetailsScreen> {
  final _form = GlobalKey<FormState>();

  @override
  Widget build(BuildContext context) => _VerificationScaffold(
    title: 'PERSONAL DETAILS',
    child: Form(
      key: _form,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const SizedBox(height: 12),
          const ScreenHeading(
            title: 'Personal details',
            subtitle: 'Enter details exactly as they appear on your ID.',
          ),
          const SizedBox(height: 22),
          const _PrivateField(label: 'Full name', hint: 'As shown on your ID'),
          const SizedBox(height: 14),
          const _PrivateField(
            label: 'Date of birth',
            hint: 'Select date of birth',
            icon: LucideIcons.calendarDays,
          ),
          const SizedBox(height: 14),
          const _PrivateField(
            label: 'Nationality',
            hint: 'Select nationality',
            icon: LucideIcons.chevronDown,
          ),
          const SizedBox(height: 14),
          const _PrivateField(
            label: 'Residential address',
            hint: 'Enter your address',
          ),
          const SizedBox(height: 18),
          const _InlineMessage(
            'These fields remain only on this screen. The current backend has no personal-details submission contract.',
            icon: LucideIcons.shieldAlert,
          ),
          const SizedBox(height: 28),
          PrimaryActionButton(
            label: 'Continue',
            onPressed: () => context.push('/profile/verification/select-id'),
          ),
        ],
      ),
    ),
  );
}

class VerificationIdTypeScreen extends StatefulWidget {
  const VerificationIdTypeScreen({super.key});

  @override
  State<VerificationIdTypeScreen> createState() =>
      _VerificationIdTypeScreenState();
}

class _VerificationIdTypeScreenState extends State<VerificationIdTypeScreen> {
  VerificationCheckType _selected = VerificationCheckType.idDocument;

  @override
  Widget build(BuildContext context) => _VerificationScaffold(
    title: 'SELECT ID TYPE',
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const ScreenHeading(
          title: 'Select ID type',
          subtitle: 'Choose a server-supported verification check.',
        ),
        const SizedBox(height: 22),
        for (final type in VerificationCheckType.values) ...[
          _ChoiceTile(
            selected: _selected == type,
            title: type.label,
            onTap: () => setState(() => _selected = type),
          ),
          const SizedBox(height: 9),
        ],
        const SizedBox(height: 36),
        PrimaryActionButton(
          label: 'Continue',
          onPressed: () => context.push(
            '/profile/verification/upload-id?type=${_selected.wireValue}',
          ),
        ),
      ],
    ),
  );
}

class VerificationUploadIdScreen extends StatelessWidget {
  const VerificationUploadIdScreen({required this.type, super.key});
  final VerificationCheckType type;

  @override
  Widget build(BuildContext context) => _VerificationScaffold(
    title: 'UPLOAD ID',
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const ScreenHeading(
          title: 'Upload ID',
          subtitle: 'Take a clear photo of your document.',
        ),
        const SizedBox(height: 24),
        SizedBox(
          height: 280,
          child: Container(
            decoration: BoxDecoration(
              color: AppColors.surface.withValues(alpha: .82),
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: AppColors.textSecondary),
            ),
            child: const Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(
                  LucideIcons.scanLine,
                  size: 72,
                  color: AppColors.textSecondary,
                ),
                SizedBox(height: 18),
                Text('Secure document capture', style: AppTypography.heading3),
                SizedBox(height: 8),
                Padding(
                  padding: EdgeInsets.symmetric(horizontal: 24),
                  child: Text(
                    'Your document is never stored in Flutter logs or local preferences.',
                    textAlign: TextAlign.center,
                    style: AppTypography.bodySmall,
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 18),
        const _InlineMessage(
          'A document-upload endpoint or provider SDK is not available. Continue uses only the server-supported check type and sends no document data.',
          icon: LucideIcons.info,
        ),
        const SizedBox(height: 18),
        PrimaryActionButton(
          label: type == VerificationCheckType.selfie
              ? 'Continue to selfie check'
              : 'Continue',
          onPressed: () => context.push(
            '/profile/verification/selfie?type=${type.wireValue}',
          ),
        ),
      ],
    ),
  );
}

class VerificationSelfieScreen extends ConsumerWidget {
  const VerificationSelfieScreen({required this.type, super.key});
  final VerificationCheckType type;

  Future<void> _continue(BuildContext context, WidgetRef ref) async {
    context.push('/profile/verification/processing');
    final status = await ref
        .read(eligibilityProvider.notifier)
        .startVerification(type);
    if (!context.mounted) return;
    context.go(_routeForStatus(status));
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final busy = ref.watch(
      eligibilityProvider.select((value) => value.submitting),
    );
    return _VerificationScaffold(
      title: 'SELFIE CHECK',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const ScreenHeading(
            title: 'Selfie check',
            subtitle: 'Look at the camera and follow the instructions.',
          ),
          const SizedBox(height: 36),
          Center(
            child: Container(
              width: 190,
              height: 190,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: AppColors.surfaceRaised,
                border: Border.all(color: AppColors.primaryBright, width: 4),
                boxShadow: const [
                  BoxShadow(color: AppColors.primaryGlow, blurRadius: 28),
                ],
              ),
              child: const Icon(
                LucideIcons.scanFace,
                size: 82,
                color: AppColors.textSecondary,
              ),
            ),
          ),
          const SizedBox(height: 36),
          const FlowCard(
            child: Column(
              children: [
                _BenefitRow(
                  icon: LucideIcons.scanFace,
                  label: 'Keep your face in the frame',
                ),
                _BenefitRow(icon: LucideIcons.sun, label: 'Use good lighting'),
                _BenefitRow(
                  icon: LucideIcons.eye,
                  label: 'Follow the on-screen prompts',
                ),
              ],
            ),
          ),
          const SizedBox(height: 18),
          PrimaryActionButton(
            label: busy ? 'Starting secure check' : 'Start secure check',
            loading: busy,
            onPressed: busy ? null : () => _continue(context, ref),
          ),
        ],
      ),
    );
  }
}

class VerificationStatusScreen extends ConsumerWidget {
  const VerificationStatusScreen({required this.status, super.key});
  final VerificationStatus status;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(eligibilityProvider);
    final effective = state.verification?.status ?? status;
    final data = _statusData(effective);
    return CanonicalAccountRefresh(
      child: _VerificationScaffold(
        title: data.appBarTitle,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const SizedBox(height: 36),
            _HeroIcon(
              icon: data.icon,
              color: data.color,
              loading: data.loading,
            ),
            const SizedBox(height: 24),
            Text(
              data.title,
              textAlign: TextAlign.center,
              style: AppTypography.heading2.copyWith(color: data.color),
            ),
            const SizedBox(height: 9),
            Text(
              data.message,
              textAlign: TextAlign.center,
              style: AppTypography.bodyLarge.copyWith(
                color: AppColors.textSecondary,
              ),
            ),
            if (state.verification?.caseId != null) ...[
              const SizedBox(height: 22),
              FlowCard(
                child: _MaskedReference(
                  label: 'Case reference',
                  value: state.verification!.caseId!,
                ),
              ),
            ],
            if (state.message != null) ...[
              const SizedBox(height: 14),
              _InlineMessage(state.message!),
            ],
            const SizedBox(height: 36),
            PrimaryActionButton(
              label: data.primaryLabel,
              icon: data.primaryIcon,
              onPressed: () => _handleStatusAction(context, ref, effective),
            ),
            if (data.secondaryLabel != null) ...[
              const SizedBox(height: 10),
              SecondaryActionButton(
                label: data.secondaryLabel!,
                onPressed: () => context.go('/home'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

Future<void> _handleStatusAction(
  BuildContext context,
  WidgetRef ref,
  VerificationStatus status,
) async {
  switch (status) {
    case VerificationStatus.started:
    case VerificationStatus.pending:
    case VerificationStatus.underReview:
      await ref.read(eligibilityProvider.notifier).refreshCanonical();
    case VerificationStatus.rejected:
    case VerificationStatus.expired:
    case VerificationStatus.required:
    case VerificationStatus.notRequired:
    case VerificationStatus.unavailable:
      if (context.mounted) context.go('/profile/verification');
    case VerificationStatus.verified:
      if (context.mounted) context.go('/profile');
  }
}

String _routeForStatus(VerificationStatus status) => switch (status) {
  VerificationStatus.verified => '/profile/verification/successful',
  VerificationStatus.rejected => '/profile/verification/rejected',
  VerificationStatus.expired => '/profile/verification/expired',
  VerificationStatus.started ||
  VerificationStatus.pending ||
  VerificationStatus.underReview => '/profile/verification/processing',
  _ => '/profile/verification',
};

class _VerificationScaffold extends StatelessWidget {
  const _VerificationScaffold({required this.title, required this.child});

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

class _HeroIcon extends StatelessWidget {
  const _HeroIcon({
    required this.icon,
    required this.color,
    this.loading = false,
  });
  final IconData icon;
  final Color color;
  final bool loading;

  @override
  Widget build(BuildContext context) => Center(
    child: Container(
      width: 116,
      height: 116,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: color.withValues(alpha: .1),
        border: Border.all(color: color, width: 3),
        boxShadow: [
          BoxShadow(color: color.withValues(alpha: .24), blurRadius: 28),
        ],
      ),
      child: loading
          ? Padding(
              padding: const EdgeInsets.all(32),
              child: CircularProgressIndicator(color: color, strokeWidth: 4),
            )
          : Icon(icon, color: color, size: 54),
    ),
  );
}

class _BenefitRow extends StatelessWidget {
  const _BenefitRow({required this.icon, required this.label});
  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 8),
    child: Row(
      children: [
        Icon(icon, color: AppColors.primaryBright, size: 21),
        const SizedBox(width: 12),
        Expanded(child: Text(label, style: AppTypography.bodyLarge)),
      ],
    ),
  );
}

class _PrivateField extends StatelessWidget {
  const _PrivateField({required this.label, required this.hint, this.icon});
  final String label;
  final String hint;
  final IconData? icon;

  @override
  Widget build(BuildContext context) => TextFormField(
    obscureText: false,
    enableSuggestions: false,
    autocorrect: false,
    decoration: InputDecoration(
      labelText: label,
      hintText: hint,
      suffixIcon: icon == null ? null : Icon(icon, size: 18),
    ),
  );
}

class _ChoiceTile extends StatelessWidget {
  const _ChoiceTile({
    required this.selected,
    required this.title,
    required this.onTap,
  });
  final bool selected;
  final String title;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Semantics(
    selected: selected,
    button: true,
    child: InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(12),
      child: Ink(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(
            color: selected ? AppColors.primaryBright : AppColors.border,
          ),
        ),
        child: Row(
          children: [
            Icon(
              selected ? LucideIcons.circleCheck : LucideIcons.circle,
              color: selected
                  ? AppColors.primaryBright
                  : AppColors.textSecondary,
            ),
            const SizedBox(width: 12),
            Expanded(child: Text(title, style: AppTypography.bodyLarge)),
          ],
        ),
      ),
    ),
  );
}

class _InlineMessage extends StatelessWidget {
  const _InlineMessage(this.message, {this.icon = LucideIcons.info});
  final String message;
  final IconData icon;

  @override
  Widget build(BuildContext context) => FlowCard(
    padding: const EdgeInsets.all(13),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, color: AppColors.valueAccent, size: 19),
        const SizedBox(width: 10),
        Expanded(child: Text(message, style: AppTypography.bodySmall)),
      ],
    ),
  );
}

class _MaskedReference extends StatelessWidget {
  const _MaskedReference({required this.label, required this.value});
  final String label;
  final String value;

  String get masked {
    final clean = value.trim();
    if (clean.length <= 6) return 'Protected';
    return '${clean.substring(0, 3)}••••${clean.substring(clean.length - 3)}';
  }

  @override
  Widget build(BuildContext context) => Row(
    children: [
      Expanded(child: Text(label, style: AppTypography.bodySmall)),
      Text(masked, style: AppTypography.bodyMedium),
    ],
  );
}

class _VerificationStatusData {
  const _VerificationStatusData({
    required this.appBarTitle,
    required this.title,
    required this.message,
    required this.icon,
    required this.color,
    required this.primaryLabel,
    required this.primaryIcon,
    this.secondaryLabel,
    this.loading = false,
  });

  final String appBarTitle;
  final String title;
  final String message;
  final IconData icon;
  final Color color;
  final String primaryLabel;
  final IconData primaryIcon;
  final String? secondaryLabel;
  final bool loading;
}

_VerificationStatusData _statusData(
  VerificationStatus status,
) => switch (status) {
  VerificationStatus.verified => const _VerificationStatusData(
    appBarTitle: 'VERIFICATION COMPLETE',
    title: 'IDENTITY VERIFIED',
    message: 'The server confirmed your identity verification.',
    icon: LucideIcons.circleCheckBig,
    color: AppColors.primaryBright,
    primaryLabel: 'Continue',
    primaryIcon: LucideIcons.arrowRight,
  ),
  VerificationStatus.rejected => const _VerificationStatusData(
    appBarTitle: 'VERIFICATION RESULT',
    title: 'VERIFICATION REJECTED',
    message:
        'We could not verify the submitted information. Review your details before trying again.',
    icon: LucideIcons.circleX,
    color: AppColors.danger,
    primaryLabel: 'Review and retry',
    primaryIcon: LucideIcons.rotateCcw,
    secondaryLabel: 'Back to Home',
  ),
  VerificationStatus.expired => const _VerificationStatusData(
    appBarTitle: 'VERIFICATION EXPIRED',
    title: 'VERIFICATION EXPIRED',
    message:
        'Your verification must be renewed before a protected action can continue.',
    icon: LucideIcons.hourglass,
    color: AppColors.valueAccent,
    primaryLabel: 'Verify again',
    primaryIcon: LucideIcons.shieldCheck,
    secondaryLabel: 'Later',
  ),
  VerificationStatus.started ||
  VerificationStatus.pending ||
  VerificationStatus.underReview => const _VerificationStatusData(
    appBarTitle: 'VERIFICATION STATUS',
    title: 'VERIFICATION PROCESSING',
    message:
        'Your verification is being reviewed. This may take a few moments.',
    icon: LucideIcons.scanSearch,
    color: AppColors.primaryBright,
    primaryLabel: 'Refresh status',
    primaryIcon: LucideIcons.refreshCw,
    secondaryLabel: 'Back to Home',
    loading: true,
  ),
  VerificationStatus.required ||
  VerificationStatus.notRequired => const _VerificationStatusData(
    appBarTitle: 'VERIFICATION',
    title: 'VERIFICATION REQUIRED',
    message: 'Complete identity verification to continue this action.',
    icon: LucideIcons.shieldAlert,
    color: AppColors.valueAccent,
    primaryLabel: 'Start verification',
    primaryIcon: LucideIcons.shieldCheck,
    secondaryLabel: 'Maybe later',
  ),
  VerificationStatus.unavailable => const _VerificationStatusData(
    appBarTitle: 'VERIFICATION',
    title: 'STATUS UNAVAILABLE',
    message:
        'Verification status could not be confirmed. No protected action has been completed.',
    icon: LucideIcons.cloudOff,
    color: AppColors.valueAccent,
    primaryLabel: 'Try again',
    primaryIcon: LucideIcons.refreshCw,
    secondaryLabel: 'Back to Home',
  ),
};
