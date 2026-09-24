import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../models/deposit_flow.dart';
import '../providers/deposit_provider.dart';
import '../theme/colors.dart';
import '../theme/typography.dart';
import '../widgets/flow_widgets.dart';
import 'checkout_webview_screen.dart';

typedef CheckoutLauncher =
    Future<Object?> Function(BuildContext context, Uri checkoutUri);

class AddMoneyScreen extends ConsumerStatefulWidget {
  const AddMoneyScreen({super.key, this.initialAmount});

  /// Used by deterministic previews/tests. Production always starts empty.
  final String? initialAmount;

  @override
  ConsumerState<AddMoneyScreen> createState() => _AddMoneyScreenState();
}

class _AddMoneyScreenState extends ConsumerState<AddMoneyScreen> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _amountController;

  @override
  void initState() {
    super.initState();
    _amountController = TextEditingController(text: widget.initialAmount);
  }

  @override
  void dispose() {
    _amountController.dispose();
    super.dispose();
  }

  int? _minorUnits(String input) {
    final value = input.replaceAll(',', '').trim();
    if (!RegExp(r'^\d+(\.\d{1,2})?$').hasMatch(value)) return null;
    final parts = value.split('.');
    final whole = int.tryParse(parts.first);
    if (whole == null) return null;
    final kobo = parts.length == 1 ? 0 : int.parse(parts.last.padRight(2, '0'));
    final result = whole * 100 + kobo;
    return result > 0 ? result : null;
  }

  Future<void> _continue() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    final amount = _minorUnits(_amountController.text);
    if (amount == null) return;
    final ok = await ref.read(depositProvider.notifier).requestQuote(amount);
    if (ok && mounted) context.push('/wallet/payment-method');
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(depositProvider);
    final loading = state.phase == DepositFlowPhase.loadingQuote;
    return _DepositScaffold(
      title: 'ADD MONEY',
      child: Form(
        key: _formKey,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const ScreenHeading(
              title: 'How much would you like to add?',
              subtitle: 'Enter an amount to request verified deposit terms.',
            ),
            const SizedBox(height: 22),
            Text('Amount', style: AppTypography.labelBold),
            const SizedBox(height: 8),
            TextFormField(
              key: const ValueKey('deposit-amount-field'),
              controller: _amountController,
              autofocus: true,
              keyboardType: const TextInputType.numberWithOptions(
                decimal: true,
              ),
              inputFormatters: [
                FilteringTextInputFormatter.allow(RegExp(r'[0-9.,]')),
              ],
              style: AppTypography.heading2,
              decoration: const InputDecoration(
                prefixText: '₦ ',
                prefixStyle: TextStyle(
                  fontFamily: 'Inter',
                  color: AppColors.textPrimary,
                  fontSize: 24,
                  fontWeight: FontWeight.w600,
                ),
                hintText: '0.00',
                helperText: 'Fees and total are confirmed by the server.',
              ),
              validator: (value) => _minorUnits(value ?? '') == null
                  ? 'Enter a valid amount greater than zero.'
                  : null,
              onFieldSubmitted: (_) => loading ? null : _continue(),
            ),
            const SizedBox(height: 18),
            _VerifiedValueCard(state: state),
            if (state.error != null) ...[
              const SizedBox(height: 12),
              _InlineNotice(
                icon: LucideIcons.wifiOff,
                message: state.error!,
                color: AppColors.warning,
              ),
            ],
            const SizedBox(height: 24),
            PrimaryActionButton(
              label: 'Continue',
              loading: loading,
              onPressed: loading ? null : _continue,
            ),
            if (state.intent != null && !state.intent!.isTerminal) ...[
              const SizedBox(height: 12),
              SecondaryActionButton(
                label: 'Resume pending deposit',
                icon: LucideIcons.rotateCcw,
                onPressed: () => context.push('/wallet/deposit-pending'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _VerifiedValueCard extends StatelessWidget {
  const _VerifiedValueCard({required this.state});

  final DepositFlowState state;

  @override
  Widget build(BuildContext context) {
    final quote = state.quote;
    return FlowCard(
      child: Column(
        children: [
          _DetailRow(
            label: 'Deposit amount',
            value: formatDepositMoney(quote?.amountMinorUnits, quote?.currency),
          ),
          const SizedBox(height: 11),
          _DetailRow(
            label: 'Fee',
            value: formatDepositMoney(quote?.feeMinorUnits, quote?.currency),
          ),
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 11),
            child: Divider(height: 1),
          ),
          _DetailRow(
            label: 'Total',
            value: formatDepositMoney(quote?.totalMinorUnits, quote?.currency),
            emphasized: true,
          ),
        ],
      ),
    );
  }
}

class PaymentMethodScreen extends ConsumerWidget {
  const PaymentMethodScreen({super.key});

  Future<void> _continue(BuildContext context, WidgetRef ref) async {
    final created = await ref.read(depositProvider.notifier).createIntent();
    if (created && context.mounted) {
      context.push('/wallet/hosted-checkout');
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(depositProvider);
    final methods = state.quote?.paymentMethods ?? const [];
    final creating = state.phase == DepositFlowPhase.creatingIntent;
    return _DepositScaffold(
      title: 'PAYMENT METHOD',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const ScreenHeading(
            title: 'Choose how to pay',
            subtitle:
                'Available methods are supplied securely for this deposit.',
          ),
          const SizedBox(height: 18),
          if (state.quote == null)
            const _UnavailableCard(
              title: 'Deposit terms unavailable',
              message: 'Return to Add Money to request verified deposit terms.',
            )
          else if (methods.isEmpty)
            const _UnavailableCard(
              title: 'No payment methods available',
              message:
                  'There are no verified payment methods for this deposit right now.',
            )
          else
            ...methods.map(
              (method) => Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: _PaymentMethodTile(
                  method: method,
                  selected: state.selectedMethod?.id == method.id,
                  onTap: creating
                      ? null
                      : () => ref
                            .read(depositProvider.notifier)
                            .selectMethod(method),
                ),
              ),
            ),
          if (state.error != null) ...[
            const SizedBox(height: 6),
            _InlineNotice(
              icon: LucideIcons.triangleAlert,
              message: state.error!,
              color: AppColors.warning,
            ),
          ],
          const SizedBox(height: 18),
          PrimaryActionButton(
            key: const ValueKey('create-deposit-button'),
            label: 'Continue to payment',
            loading: creating,
            onPressed:
                state.selectedMethod == null || creating || methods.isEmpty
                ? null
                : () => _continue(context, ref),
          ),
          const SizedBox(height: 12),
          const _SecurityNote(),
        ],
      ),
    );
  }
}

class HostedCheckoutScreen extends ConsumerWidget {
  const HostedCheckoutScreen({super.key, this.checkoutLauncher});

  final CheckoutLauncher? checkoutLauncher;

  Future<void> _openCheckout(
    BuildContext context,
    WidgetRef ref,
    Uri checkoutUri,
  ) async {
    final launcher = checkoutLauncher ?? _defaultCheckoutLauncher;
    await launcher(context, checkoutUri);
    if (!context.mounted) return;
    final notifier = ref.read(depositProvider.notifier);
    unawaited(notifier.handleProviderReturn());
    context.go('/wallet/deposit-processing');
  }

  static Future<Object?> _defaultCheckoutLauncher(
    BuildContext context,
    Uri checkoutUri,
  ) => Navigator.of(context).push<Object?>(
    MaterialPageRoute(
      builder: (_) => CheckoutWebviewScreen(authorizationUrl: checkoutUri),
    ),
  );

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final intent = ref.watch(depositProvider).intent;
    return _DepositScaffold(
      title: 'HOSTED CHECKOUT',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const SizedBox(height: 22),
          const _HeroIcon(
            icon: LucideIcons.link,
            color: AppColors.primaryBright,
          ),
          const SizedBox(height: 20),
          Text(
            intent == null ? 'CHECKOUT UNAVAILABLE' : 'CHECKOUT READY',
            textAlign: TextAlign.center,
            style: AppTypography.heading2,
          ),
          const SizedBox(height: 8),
          Text(
            intent == null
                ? 'Verified checkout details could not be loaded.'
                : 'Complete your payment securely with the selected provider.',
            textAlign: TextAlign.center,
            style: AppTypography.bodySmall,
          ),
          const SizedBox(height: 24),
          _DepositDetailsCard(intent: intent),
          const SizedBox(height: 18),
          PrimaryActionButton(
            label: 'Pay now',
            icon: LucideIcons.externalLink,
            onPressed: intent?.authorizationUrl == null
                ? null
                : () => _openCheckout(context, ref, intent!.authorizationUrl!),
          ),
          const SizedBox(height: 10),
          SecondaryActionButton(
            label: 'Cancel',
            onPressed: () => context.pop(),
          ),
          const SizedBox(height: 16),
          const _InlineNotice(
            icon: LucideIcons.info,
            message:
                'This is a payment request only. Your wallet updates only after server confirmation.',
            color: AppColors.textSecondary,
          ),
        ],
      ),
    );
  }
}

class DepositStatusScreen extends ConsumerStatefulWidget {
  const DepositStatusScreen({
    super.key,
    required this.requestedPhase,
    this.autoRefresh = true,
  });

  final DepositFlowPhase requestedPhase;
  final bool autoRefresh;

  @override
  ConsumerState<DepositStatusScreen> createState() =>
      _DepositStatusScreenState();
}

class _DepositStatusScreenState extends ConsumerState<DepositStatusScreen> {
  @override
  void initState() {
    super.initState();
    if (widget.autoRefresh) {
      Future.microtask(() {
        final state = ref.read(depositProvider);
        if (state.intent == null) {
          ref.read(depositProvider.notifier).recover();
        } else if (!state.intent!.isTerminal) {
          ref.read(depositProvider.notifier).refreshStatus();
        }
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(depositProvider);
    final phase = _visiblePhase(state, widget.requestedPhase);
    final config = _StatusConfig.forPhase(phase);
    final intent = state.intent;
    return _DepositScaffold(
      title: config.appBarTitle,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const SizedBox(height: 18),
          _HeroIcon(
            icon: config.icon,
            color: config.color,
            loading: config.loading,
          ),
          const SizedBox(height: 20),
          Text(
            config.title,
            textAlign: TextAlign.center,
            style: AppTypography.heading2.copyWith(color: config.titleColor),
          ),
          const SizedBox(height: 8),
          Text(
            _statusMessage(phase, intent),
            textAlign: TextAlign.center,
            style: AppTypography.bodyLarge,
          ),
          const SizedBox(height: 24),
          _DepositDetailsCard(intent: intent, showStatus: true),
          if (state.error != null) ...[
            const SizedBox(height: 12),
            _InlineNotice(
              icon: LucideIcons.info,
              message: state.error!,
              color: AppColors.warning,
            ),
          ],
          const SizedBox(height: 22),
          if (phase == DepositFlowPhase.successful)
            PrimaryActionButton(
              label: 'View wallet',
              icon: LucideIcons.walletCards,
              onPressed: () => context.go('/wallet'),
            )
          else if (phase == DepositFlowPhase.failed) ...[
            PrimaryActionButton(
              label: 'Try again',
              icon: LucideIcons.rotateCcw,
              onPressed: () => context.go('/wallet/add-money'),
            ),
            const SizedBox(height: 10),
            SecondaryActionButton(
              label: 'View wallet',
              onPressed: () => context.go('/wallet'),
            ),
          ] else ...[
            PrimaryActionButton(
              key: const ValueKey('refresh-deposit-status'),
              label: 'Check status',
              icon: LucideIcons.refreshCw,
              onPressed: () =>
                  ref.read(depositProvider.notifier).refreshStatus(),
            ),
            const SizedBox(height: 10),
            SecondaryActionButton(
              label: 'Back to wallet',
              onPressed: () => context.go('/wallet'),
            ),
          ],
          const SizedBox(height: 14),
          Text(
            phase == DepositFlowPhase.successful
                ? 'This status was verified by the server.'
                : phase == DepositFlowPhase.failed
                ? 'Your wallet was not credited for this failed deposit.'
                : 'Do not make another payment while confirmation is pending.',
            textAlign: TextAlign.center,
            style: AppTypography.bodySmall,
          ),
        ],
      ),
    );
  }
}

DepositFlowPhase _visiblePhase(
  DepositFlowState state,
  DepositFlowPhase requested,
) {
  if (state.intent == null) return requested;
  return switch (state.intent!.status) {
    DepositStatus.processing => DepositFlowPhase.processing,
    DepositStatus.pending => DepositFlowPhase.pending,
    DepositStatus.successful => DepositFlowPhase.successful,
    DepositStatus.failed => DepositFlowPhase.failed,
  };
}

String _statusMessage(DepositFlowPhase phase, DepositIntentData? intent) {
  if (intent == null) {
    return 'Deposit details are unavailable. Check status to recover the existing reference.';
  }
  return switch (phase) {
    DepositFlowPhase.processing =>
      'We are verifying your payment. This usually takes a few moments.',
    DepositFlowPhase.pending =>
      'Your payment is awaiting server confirmation. Your wallet is unchanged.',
    DepositFlowPhase.successful =>
      'Your deposit has been confirmed and your wallet is up to date.',
    DepositFlowPhase.failed =>
      intent.failureReason ?? 'The deposit could not be completed.',
    _ => 'Deposit status is unavailable.',
  };
}

class _StatusConfig {
  const _StatusConfig({
    required this.appBarTitle,
    required this.title,
    required this.icon,
    required this.color,
    this.loading = false,
    this.titleColor = AppColors.textPrimary,
  });

  final String appBarTitle;
  final String title;
  final IconData icon;
  final Color color;
  final bool loading;
  final Color titleColor;

  static _StatusConfig forPhase(DepositFlowPhase phase) => switch (phase) {
    DepositFlowPhase.successful => const _StatusConfig(
      appBarTitle: 'DEPOSIT SUCCESSFUL',
      title: 'DEPOSIT SUCCESSFUL',
      icon: LucideIcons.check,
      color: AppColors.success,
      titleColor: AppColors.primaryBright,
    ),
    DepositFlowPhase.failed => const _StatusConfig(
      appBarTitle: 'DEPOSIT FAILED',
      title: 'DEPOSIT FAILED',
      icon: LucideIcons.x,
      color: AppColors.danger,
      titleColor: AppColors.danger,
    ),
    DepositFlowPhase.pending => const _StatusConfig(
      appBarTitle: 'DEPOSIT PENDING',
      title: 'AWAITING CONFIRMATION',
      icon: LucideIcons.hourglass,
      color: AppColors.warning,
    ),
    _ => const _StatusConfig(
      appBarTitle: 'DEPOSIT PROCESSING',
      title: 'DEPOSIT PROCESSING',
      icon: LucideIcons.loaderCircle,
      color: AppColors.primaryBright,
      loading: true,
    ),
  };
}

class _DepositScaffold extends StatelessWidget {
  const _DepositScaffold({required this.title, required this.child});

  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: AppColors.background,
    appBar: AppBar(title: Text(title), centerTitle: true),
    body: SafeArea(top: false, child: FlowPage(child: child)),
  );
}

class _PaymentMethodTile extends StatelessWidget {
  const _PaymentMethodTile({
    required this.method,
    required this.selected,
    required this.onTap,
  });

  final DepositPaymentMethod method;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    selected: selected,
    child: InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(14),
      child: FlowCard(
        borderColor: selected ? AppColors.primaryBright : AppColors.border,
        child: Row(
          children: [
            Container(
              width: 42,
              height: 42,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: AppColors.primaryBright.withValues(alpha: .1),
              ),
              child: const Icon(
                LucideIcons.walletCards,
                color: AppColors.primaryBright,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(method.label, style: AppTypography.labelBold),
                  if (method.description != null)
                    Text(method.description!, style: AppTypography.bodySmall),
                  if (method.maskedInstrument != null)
                    Text(
                      method.maskedInstrument!,
                      style: AppTypography.bodySmall,
                    ),
                ],
              ),
            ),
            Icon(
              selected ? LucideIcons.circleCheckBig : LucideIcons.circle,
              color: selected
                  ? AppColors.primaryBright
                  : AppColors.textSecondary,
              size: 22,
            ),
          ],
        ),
      ),
    ),
  );
}

class _DepositDetailsCard extends StatelessWidget {
  const _DepositDetailsCard({required this.intent, this.showStatus = false});

  final DepositIntentData? intent;
  final bool showStatus;

  @override
  Widget build(BuildContext context) => FlowCard(
    child: Column(
      children: [
        _DetailRow(
          label: 'Amount',
          value: formatDepositMoney(intent?.amountMinorUnits, intent?.currency),
          emphasized: true,
        ),
        const SizedBox(height: 11),
        _DetailRow(
          label: 'Reference',
          value: intent?.maskedReference ?? 'Unavailable',
        ),
        const SizedBox(height: 11),
        _DetailRow(
          label: 'Payment method',
          value:
              intent?.maskedInstrument ??
              intent?.paymentMethodLabel ??
              'Unavailable',
        ),
        if (showStatus) ...[
          const SizedBox(height: 11),
          _DetailRow(
            label: 'Status',
            value: intent?.status.name.toUpperCase() ?? 'UNAVAILABLE',
          ),
        ],
        if (intent?.availableBalanceMinorUnits != null) ...[
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 11),
            child: Divider(height: 1),
          ),
          _DetailRow(
            label: 'Available balance',
            value: formatDepositMoney(
              intent!.availableBalanceMinorUnits,
              intent!.currency,
            ),
            emphasized: true,
          ),
        ],
      ],
    ),
  );
}

class _DetailRow extends StatelessWidget {
  const _DetailRow({
    required this.label,
    required this.value,
    this.emphasized = false,
  });

  final String label;
  final String value;
  final bool emphasized;

  @override
  Widget build(BuildContext context) => Row(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Expanded(child: Text(label, style: AppTypography.bodySmall)),
      const SizedBox(width: 12),
      Flexible(
        child: Text(
          value,
          textAlign: TextAlign.right,
          style: emphasized
              ? AppTypography.labelBold.copyWith(color: AppColors.primaryBright)
              : AppTypography.bodyLarge,
        ),
      ),
    ],
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
      width: 106,
      height: 106,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: color.withValues(alpha: .08),
        border: Border.all(color: color.withValues(alpha: .7), width: 2),
        boxShadow: [
          BoxShadow(color: color.withValues(alpha: .22), blurRadius: 32),
        ],
      ),
      child: loading
          ? Padding(
              padding: const EdgeInsets.all(29),
              child: CircularProgressIndicator(color: color, strokeWidth: 4),
            )
          : Icon(icon, size: 49, color: color),
    ),
  );
}

class _InlineNotice extends StatelessWidget {
  const _InlineNotice({
    required this.icon,
    required this.message,
    required this.color,
  });

  final IconData icon;
  final String message;
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      color: color.withValues(alpha: .08),
      borderRadius: BorderRadius.circular(12),
      border: Border.all(color: color.withValues(alpha: .45)),
    ),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, color: color, size: 19),
        const SizedBox(width: 9),
        Expanded(child: Text(message, style: AppTypography.bodySmall)),
      ],
    ),
  );
}

class _UnavailableCard extends StatelessWidget {
  const _UnavailableCard({required this.title, required this.message});

  final String title;
  final String message;

  @override
  Widget build(BuildContext context) => FlowCard(
    child: Column(
      children: [
        const Icon(LucideIcons.cloudOff, color: AppColors.warning, size: 34),
        const SizedBox(height: 10),
        Text(title, style: AppTypography.heading3, textAlign: TextAlign.center),
        const SizedBox(height: 6),
        Text(
          message,
          style: AppTypography.bodySmall,
          textAlign: TextAlign.center,
        ),
      ],
    ),
  );
}

class _SecurityNote extends StatelessWidget {
  const _SecurityNote();

  @override
  Widget build(BuildContext context) => const _InlineNotice(
    icon: LucideIcons.shieldCheck,
    message:
        'Payment details are handled by the hosted provider and are never stored in this app.',
    color: AppColors.textSecondary,
  );
}
