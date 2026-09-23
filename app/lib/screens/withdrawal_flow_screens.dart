import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../models/withdrawal_flow.dart';
import '../providers/withdrawal_provider.dart';
import '../theme/colors.dart';
import '../theme/typography.dart';
import '../widgets/flow_widgets.dart';

class WithdrawMoneyScreen extends ConsumerStatefulWidget {
  const WithdrawMoneyScreen({super.key, this.initialAmount});

  final String? initialAmount;

  @override
  ConsumerState<WithdrawMoneyScreen> createState() =>
      _WithdrawMoneyScreenState();
}

class _WithdrawMoneyScreenState extends ConsumerState<WithdrawMoneyScreen> {
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
    final fraction = parts.length == 1
        ? 0
        : int.parse(parts.last.padRight(2, '0'));
    final amount = whole * 100 + fraction;
    return amount > 0 ? amount : null;
  }

  Future<void> _continue() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    final amount = _minorUnits(_amountController.text);
    if (amount == null) return;
    final phase = await ref
        .read(withdrawalProvider.notifier)
        .requestQuote(amount);
    if (!mounted) return;
    switch (phase) {
      case WithdrawalFlowPhase.selectingBank:
        context.push('/wallet/withdraw/select-bank-account');
      case WithdrawalFlowPhase.verificationRequired:
        context.push('/wallet/withdraw/verification-required');
      case WithdrawalFlowPhase.limitReached:
        context.push('/wallet/withdraw/withdrawal-limit-reached');
      default:
        break;
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(withdrawalProvider);
    final loading = state.phase == WithdrawalFlowPhase.loadingQuote;
    return _WithdrawalScaffold(
      title: 'WITHDRAW MONEY',
      child: Form(
        key: _formKey,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const ScreenHeading(
              title: 'Withdraw from your wallet',
              subtitle:
                  'Enter an amount within your available balance and account limits.',
            ),
            const SizedBox(height: 20),
            Text('Amount', style: AppTypography.labelBold),
            const SizedBox(height: 8),
            TextFormField(
              key: const ValueKey('withdrawal-amount-field'),
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
                helperText:
                    'Balance, limits and charges are confirmed by the server.',
              ),
              validator: (value) => _minorUnits(value ?? '') == null
                  ? 'Enter a valid amount greater than zero.'
                  : null,
              onFieldSubmitted: (_) => loading ? null : _continue(),
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: ['2,000', '5,000', '10,000']
                  .map(
                    (amount) => ActionChip(
                      label: Text('₦$amount'),
                      onPressed: loading
                          ? null
                          : () => _amountController.text = amount,
                    ),
                  )
                  .toList(growable: false),
            ),
            if (state.quote != null) ...[
              const SizedBox(height: 18),
              _AmountCard(quote: state.quote!),
            ],
            if (state.error != null) ...[
              const SizedBox(height: 12),
              _Notice(message: state.error!, color: AppColors.warning),
            ],
            const SizedBox(height: 24),
            PrimaryActionButton(
              label: 'Continue',
              loading: loading,
              onPressed: loading ? null : _continue,
            ),
            if (state.withdrawal != null && !state.withdrawal!.isTerminal) ...[
              const SizedBox(height: 10),
              SecondaryActionButton(
                label: 'Resume pending withdrawal',
                icon: LucideIcons.rotateCcw,
                onPressed: () =>
                    context.push('/wallet/withdraw/withdrawal-pending-review'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class SelectBankAccountScreen extends ConsumerStatefulWidget {
  const SelectBankAccountScreen({super.key, this.autoLoad = true});

  final bool autoLoad;

  @override
  ConsumerState<SelectBankAccountScreen> createState() =>
      _SelectBankAccountScreenState();
}

class _SelectBankAccountScreenState
    extends ConsumerState<SelectBankAccountScreen> {
  @override
  void initState() {
    super.initState();
    if (widget.autoLoad) {
      Future.microtask(() {
        if (ref.read(withdrawalProvider).bankAccounts.isEmpty) {
          ref.read(withdrawalProvider.notifier).loadBankAccounts();
        }
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(withdrawalProvider);
    final loading = state.phase == WithdrawalFlowPhase.loadingBanks;
    return _WithdrawalScaffold(
      title: 'SELECT BANK ACCOUNT',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const ScreenHeading(
            title: 'Where should we send it?',
            subtitle: 'Choose a verified payout destination.',
          ),
          const SizedBox(height: 18),
          if (loading)
            const _LoadingCard(label: 'Loading saved bank accounts…')
          else if (state.bankAccounts.isEmpty)
            _UnavailableCard(
              title: 'No saved bank accounts',
              message:
                  state.error ??
                  'Add and verify a bank account before continuing.',
            )
          else
            ...state.bankAccounts.map(
              (account) => Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: _BankAccountTile(
                  account: account,
                  selected: state.selectedBankAccount?.id == account.id,
                  onTap: () => ref
                      .read(withdrawalProvider.notifier)
                      .selectBankAccount(account),
                ),
              ),
            ),
          const SizedBox(height: 8),
          SecondaryActionButton(
            label: 'Add new bank account',
            icon: LucideIcons.plus,
            onPressed: () => context.push('/wallet/withdraw/add-bank-account'),
          ),
          const SizedBox(height: 14),
          PrimaryActionButton(
            label: 'Continue',
            onPressed: state.selectedBankAccount == null
                ? null
                : () => context.push('/wallet/withdraw/withdrawal-review'),
          ),
          if (state.error != null && state.bankAccounts.isNotEmpty) ...[
            const SizedBox(height: 12),
            _Notice(message: state.error!, color: AppColors.warning),
          ],
        ],
      ),
    );
  }
}

class AddBankAccountScreen extends ConsumerStatefulWidget {
  const AddBankAccountScreen({super.key});

  @override
  ConsumerState<AddBankAccountScreen> createState() =>
      _AddBankAccountScreenState();
}

class _AddBankAccountScreenState extends ConsumerState<AddBankAccountScreen> {
  final _formKey = GlobalKey<FormState>();
  final _bankName = TextEditingController();
  final _bankCode = TextEditingController();
  final _accountNumber = TextEditingController();

  @override
  void dispose() {
    _bankName.dispose();
    _bankCode.dispose();
    _accountNumber.dispose();
    super.dispose();
  }

  void _verify() {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    unawaited(
      ref
          .read(withdrawalProvider.notifier)
          .verifyBankAccount(
            bankCode: _bankCode.text.trim(),
            bankName: _bankName.text.trim(),
            accountNumber: _accountNumber.text.trim(),
          ),
    );
    context.push('/wallet/withdraw/verifying-bank-account');
  }

  @override
  Widget build(BuildContext context) => _WithdrawalScaffold(
    title: 'ADD BANK ACCOUNT',
    child: Form(
      key: _formKey,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const ScreenHeading(
            title: 'Add a payout account',
            subtitle: 'Enter bank details for secure server-side verification.',
          ),
          const SizedBox(height: 18),
          TextFormField(
            controller: _bankName,
            textCapitalization: TextCapitalization.words,
            decoration: const InputDecoration(labelText: 'Bank name'),
            validator: (value) =>
                (value?.trim().length ?? 0) < 2 ? 'Enter the bank name.' : null,
          ),
          const SizedBox(height: 12),
          TextFormField(
            controller: _bankCode,
            keyboardType: TextInputType.number,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly],
            decoration: const InputDecoration(labelText: 'Bank code'),
            validator: (value) =>
                (value?.trim().isEmpty ?? true) ? 'Enter the bank code.' : null,
          ),
          const SizedBox(height: 12),
          TextFormField(
            key: const ValueKey('bank-account-number-field'),
            controller: _accountNumber,
            keyboardType: TextInputType.number,
            obscureText: true,
            inputFormatters: [
              FilteringTextInputFormatter.digitsOnly,
              LengthLimitingTextInputFormatter(20),
            ],
            decoration: const InputDecoration(
              labelText: 'Account number',
              helperText: 'The account name is returned by the server.',
            ),
            validator: (value) {
              final length = value?.trim().length ?? 0;
              return length < 8 ? 'Enter a valid account number.' : null;
            },
          ),
          const SizedBox(height: 16),
          const _Notice(
            message:
                'Draught Bet never displays or stores an unmasked account number after verification.',
            color: AppColors.textSecondary,
            icon: LucideIcons.shieldCheck,
          ),
          const SizedBox(height: 22),
          PrimaryActionButton(
            label: 'Verify account',
            icon: LucideIcons.badgeCheck,
            onPressed: _verify,
          ),
          const SizedBox(height: 10),
          SecondaryActionButton(label: 'Cancel', onPressed: context.pop),
        ],
      ),
    ),
  );
}

class VerifyingBankAccountScreen extends ConsumerWidget {
  const VerifyingBankAccountScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(withdrawalProvider);
    final failed = state.phase == WithdrawalFlowPhase.bankVerificationFailed;
    final verified =
        state.selectedBankAccount != null &&
        state.phase == WithdrawalFlowPhase.reviewing;
    return _WithdrawalScaffold(
      title: 'VERIFY BANK ACCOUNT',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const SizedBox(height: 24),
          _HeroIcon(
            icon: failed
                ? LucideIcons.circleX
                : verified
                ? LucideIcons.badgeCheck
                : LucideIcons.loaderCircle,
            color: failed
                ? AppColors.danger
                : verified
                ? AppColors.primaryBright
                : AppColors.gold500,
            loading: !failed && !verified,
          ),
          const SizedBox(height: 22),
          Text(
            failed
                ? 'VERIFICATION FAILED'
                : verified
                ? 'ACCOUNT VERIFIED'
                : 'VERIFYING BANK ACCOUNT',
            style: AppTypography.heading2.copyWith(
              color: failed ? AppColors.danger : AppColors.textPrimary,
            ),
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 8),
          Text(
            failed
                ? state.error ?? 'The account details could not be verified.'
                : verified
                ? 'The payout destination was verified by the server.'
                : 'Checking the account name with the payout provider.',
            style: AppTypography.bodyLarge,
            textAlign: TextAlign.center,
          ),
          if (verified) ...[
            const SizedBox(height: 20),
            _BankSummary(account: state.selectedBankAccount!),
          ],
          const SizedBox(height: 24),
          if (failed)
            PrimaryActionButton(
              label: 'Edit details',
              icon: LucideIcons.pencil,
              onPressed: context.pop,
            )
          else if (verified)
            PrimaryActionButton(
              label: 'Continue',
              onPressed: () => context.go('/wallet/withdraw/withdrawal-review'),
            ),
        ],
      ),
    );
  }
}

class WithdrawalReviewScreen extends ConsumerWidget {
  const WithdrawalReviewScreen({super.key});

  Future<void> _submit(BuildContext context, WidgetRef ref) async {
    final created = await ref
        .read(withdrawalProvider.notifier)
        .createWithdrawal();
    if (!created || !context.mounted) return;
    final phase = ref.read(withdrawalProvider).phase;
    final route = switch (phase) {
      WithdrawalFlowPhase.processing =>
        '/wallet/withdraw/withdrawal-processing',
      WithdrawalFlowPhase.successful =>
        '/wallet/withdraw/withdrawal-successful',
      WithdrawalFlowPhase.reversed => '/wallet/withdraw/withdrawal-reversed',
      _ => '/wallet/withdraw/withdrawal-pending-review',
    };
    context.go(route);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(withdrawalProvider);
    final quote = state.quote;
    final bank = state.selectedBankAccount;
    final ready = quote != null && bank != null;
    return _WithdrawalScaffold(
      title: 'WITHDRAWAL REVIEW',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const ScreenHeading(
            title: 'Review withdrawal',
            subtitle:
                'Confirm the server-provided amount, destination and charges.',
          ),
          const SizedBox(height: 18),
          if (!ready)
            const _UnavailableCard(
              title: 'Withdrawal details unavailable',
              message:
                  'Return to Withdraw Money to request verified withdrawal terms.',
            )
          else ...[
            _ReviewCard(quote: quote, bankAccount: bank),
            const SizedBox(height: 12),
            const _Notice(
              icon: LucideIcons.info,
              message:
                  'Funds are reserved while the withdrawal is reviewed. Submission does not mean the payout has completed.',
              color: AppColors.textSecondary,
            ),
          ],
          if (state.error != null) ...[
            const SizedBox(height: 12),
            _Notice(message: state.error!, color: AppColors.warning),
          ],
          const SizedBox(height: 22),
          PrimaryActionButton(
            key: const ValueKey('create-withdrawal-button'),
            label: 'Confirm withdrawal',
            icon: LucideIcons.lockKeyhole,
            loading: state.isCreating,
            onPressed: !ready || state.isCreating
                ? null
                : () => _submit(context, ref),
          ),
          const SizedBox(height: 10),
          SecondaryActionButton(label: 'Cancel', onPressed: context.pop),
        ],
      ),
    );
  }
}

class WithdrawalGateScreen extends ConsumerWidget {
  const WithdrawalGateScreen({super.key, required this.phase});

  final WithdrawalFlowPhase phase;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(withdrawalProvider);
    final verification = phase == WithdrawalFlowPhase.verificationRequired;
    final quote = state.quote;
    return _WithdrawalScaffold(
      title: verification ? 'VERIFICATION REQUIRED' : 'WITHDRAWAL LIMIT',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const SizedBox(height: 24),
          _HeroIcon(
            icon: verification ? LucideIcons.shieldCheck : LucideIcons.gauge,
            color: AppColors.gold500,
          ),
          const SizedBox(height: 22),
          Text(
            verification ? 'VERIFICATION REQUIRED' : 'LIMIT REACHED',
            textAlign: TextAlign.center,
            style: AppTypography.heading2,
          ),
          const SizedBox(height: 8),
          Text(
            quote?.message ??
                (verification
                    ? 'Identity verification is required before withdrawal.'
                    : 'This request exceeds your account or safer-play limit.'),
            textAlign: TextAlign.center,
            style: AppTypography.bodyLarge,
          ),
          if (!verification) ...[
            const SizedBox(height: 20),
            FlowCard(
              child: _DetailRow(
                label: 'Server-confirmed limit',
                value: formatWithdrawalMoney(
                  quote?.limitMinorUnits,
                  quote?.currency,
                ),
                emphasized: true,
              ),
            ),
          ],
          const SizedBox(height: 24),
          PrimaryActionButton(
            label: verification ? 'View verification' : 'Enter another amount',
            icon: verification ? LucideIcons.userCheck : LucideIcons.pencil,
            onPressed: () => verification
                ? context.go('/profile')
                : context.go('/wallet/withdraw/withdraw-money'),
          ),
          const SizedBox(height: 10),
          SecondaryActionButton(
            label: verification ? 'Cancel' : 'View wallet',
            onPressed: () => context.go('/wallet'),
          ),
        ],
      ),
    );
  }
}

class WithdrawalStatusScreen extends ConsumerStatefulWidget {
  const WithdrawalStatusScreen({
    super.key,
    required this.requestedPhase,
    this.autoRefresh = true,
  });

  final WithdrawalFlowPhase requestedPhase;
  final bool autoRefresh;

  @override
  ConsumerState<WithdrawalStatusScreen> createState() =>
      _WithdrawalStatusScreenState();
}

class _WithdrawalStatusScreenState
    extends ConsumerState<WithdrawalStatusScreen> {
  @override
  void initState() {
    super.initState();
    if (widget.autoRefresh) {
      Future.microtask(() {
        final state = ref.read(withdrawalProvider);
        if (state.withdrawal == null) {
          ref.read(withdrawalProvider.notifier).recover();
        } else if (!state.withdrawal!.isTerminal) {
          ref.read(withdrawalProvider.notifier).refreshStatus();
        }
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(withdrawalProvider);
    final phase = _visiblePhase(state, widget.requestedPhase);
    final config = _StatusConfig.forPhase(phase);
    final withdrawal = state.withdrawal;
    return _WithdrawalScaffold(
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
            _statusMessage(phase, withdrawal),
            textAlign: TextAlign.center,
            style: AppTypography.bodyLarge,
          ),
          const SizedBox(height: 22),
          _WithdrawalDetailsCard(withdrawal: withdrawal),
          if (state.error != null) ...[
            const SizedBox(height: 12),
            _Notice(message: state.error!, color: AppColors.warning),
          ],
          const SizedBox(height: 22),
          if (phase == WithdrawalFlowPhase.successful) ...[
            PrimaryActionButton(
              label: 'View transaction',
              icon: LucideIcons.receiptText,
              onPressed: () => context.go('/wallet/transactions'),
            ),
            const SizedBox(height: 10),
            SecondaryActionButton(
              label: 'Back to wallet',
              onPressed: () => context.go('/wallet'),
            ),
          ] else if (phase == WithdrawalFlowPhase.reversed) ...[
            PrimaryActionButton(
              label: 'Try another bank',
              icon: LucideIcons.landmark,
              onPressed: () =>
                  context.go('/wallet/withdraw/select-bank-account'),
            ),
            const SizedBox(height: 10),
            SecondaryActionButton(
              label: 'Back to wallet',
              onPressed: () => context.go('/wallet'),
            ),
          ] else ...[
            PrimaryActionButton(
              key: const ValueKey('refresh-withdrawal-status'),
              label: 'Check status',
              icon: LucideIcons.refreshCw,
              onPressed: () =>
                  ref.read(withdrawalProvider.notifier).refreshStatus(),
            ),
            const SizedBox(height: 10),
            SecondaryActionButton(
              label: 'Back to wallet',
              onPressed: () => context.go('/wallet'),
            ),
          ],
          const SizedBox(height: 14),
          Text(
            withdrawal?.isTerminal == true
                ? 'This status was confirmed by the server.'
                : 'Do not submit another withdrawal while this request is active.',
            textAlign: TextAlign.center,
            style: AppTypography.bodySmall,
          ),
        ],
      ),
    );
  }
}

class SavedBankAccountsScreen extends ConsumerStatefulWidget {
  const SavedBankAccountsScreen({super.key, this.autoLoad = true});

  final bool autoLoad;

  @override
  ConsumerState<SavedBankAccountsScreen> createState() =>
      _SavedBankAccountsScreenState();
}

class _SavedBankAccountsScreenState
    extends ConsumerState<SavedBankAccountsScreen> {
  @override
  void initState() {
    super.initState();
    if (widget.autoLoad) {
      Future.microtask(
        () => ref.read(withdrawalProvider.notifier).loadBankAccounts(),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(withdrawalProvider);
    final loading = state.phase == WithdrawalFlowPhase.loadingBanks;
    return _WithdrawalScaffold(
      title: 'SAVED BANK ACCOUNTS',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const ScreenHeading(
            title: 'Payout destinations',
            subtitle: 'Verified bank accounts available for withdrawals.',
          ),
          const SizedBox(height: 18),
          if (loading)
            const _LoadingCard(label: 'Loading saved bank accounts…')
          else if (state.bankAccounts.isEmpty)
            _UnavailableCard(
              title: 'No saved bank accounts',
              message: state.error ?? 'Add a verified payout destination.',
            )
          else
            ...state.bankAccounts.map(
              (account) => Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: _BankAccountTile(
                  account: account,
                  selected: account.isDefault,
                ),
              ),
            ),
          const SizedBox(height: 16),
          PrimaryActionButton(
            label: 'Add bank account',
            icon: LucideIcons.plus,
            onPressed: () => context.push('/wallet/withdraw/add-bank-account'),
          ),
          if (state.error != null) ...[
            const SizedBox(height: 10),
            SecondaryActionButton(
              label: 'Try again',
              icon: LucideIcons.refreshCw,
              onPressed: () =>
                  ref.read(withdrawalProvider.notifier).loadBankAccounts(),
            ),
          ],
        ],
      ),
    );
  }
}

WithdrawalFlowPhase _visiblePhase(
  WithdrawalFlowState state,
  WithdrawalFlowPhase requested,
) {
  final withdrawal = state.withdrawal;
  if (withdrawal == null) return requested;
  return switch (withdrawal.status) {
    WithdrawalStatus.pendingReview => WithdrawalFlowPhase.pendingReview,
    WithdrawalStatus.processing => WithdrawalFlowPhase.processing,
    WithdrawalStatus.successful => WithdrawalFlowPhase.successful,
    WithdrawalStatus.reversed => WithdrawalFlowPhase.reversed,
  };
}

String _statusMessage(WithdrawalFlowPhase phase, WithdrawalData? withdrawal) {
  if (withdrawal == null) {
    return 'Withdrawal details are unavailable. Check status to recover the existing reference.';
  }
  return switch (phase) {
    WithdrawalFlowPhase.pendingReview =>
      'Your request is under review. The amount is reserved, not paid out.',
    WithdrawalFlowPhase.processing =>
      'Your approved withdrawal is being sent to the payout provider.',
    WithdrawalFlowPhase.successful =>
      'The payout provider confirmed your withdrawal.',
    WithdrawalFlowPhase.reversed =>
      withdrawal.failureReason ??
          'The payout was not completed and the reservation was released.',
    _ => 'Withdrawal status is unavailable.',
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

  static _StatusConfig forPhase(WithdrawalFlowPhase phase) => switch (phase) {
    WithdrawalFlowPhase.pendingReview => const _StatusConfig(
      appBarTitle: 'WITHDRAWAL STATUS',
      title: 'PENDING REVIEW',
      icon: LucideIcons.clock3,
      color: AppColors.gold500,
    ),
    WithdrawalFlowPhase.processing => const _StatusConfig(
      appBarTitle: 'WITHDRAWAL STATUS',
      title: 'PAYOUT PROCESSING',
      icon: LucideIcons.settings,
      color: AppColors.gold500,
      loading: true,
    ),
    WithdrawalFlowPhase.successful => const _StatusConfig(
      appBarTitle: 'WITHDRAWAL STATUS',
      title: 'WITHDRAWAL CONFIRMED',
      icon: LucideIcons.check,
      color: AppColors.success,
      titleColor: AppColors.primaryBright,
    ),
    WithdrawalFlowPhase.reversed => const _StatusConfig(
      appBarTitle: 'WITHDRAWAL STATUS',
      title: 'WITHDRAWAL REVERSED',
      icon: LucideIcons.x,
      color: AppColors.danger,
      titleColor: AppColors.danger,
    ),
    _ => const _StatusConfig(
      appBarTitle: 'WITHDRAWAL STATUS',
      title: 'STATUS UNAVAILABLE',
      icon: LucideIcons.circleAlert,
      color: AppColors.warning,
    ),
  };
}

class _WithdrawalScaffold extends StatelessWidget {
  const _WithdrawalScaffold({required this.title, required this.child});

  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: AppColors.background,
    appBar: AppBar(title: Text(title), centerTitle: true),
    body: SafeArea(top: false, child: FlowPage(child: child)),
  );
}

class _AmountCard extends StatelessWidget {
  const _AmountCard({required this.quote});

  final WithdrawalQuote quote;

  @override
  Widget build(BuildContext context) => FlowCard(
    child: Column(
      children: [
        _DetailRow(
          label: 'Available balance',
          value: formatWithdrawalMoney(
            quote.availableBalanceMinorUnits,
            quote.currency,
          ),
        ),
        const SizedBox(height: 11),
        _DetailRow(
          label: 'Withdrawal amount',
          value: formatWithdrawalMoney(quote.amountMinorUnits, quote.currency),
          emphasized: true,
        ),
      ],
    ),
  );
}

class _ReviewCard extends StatelessWidget {
  const _ReviewCard({required this.quote, required this.bankAccount});

  final WithdrawalQuote quote;
  final WithdrawalBankAccount bankAccount;

  @override
  Widget build(BuildContext context) => FlowCard(
    child: Column(
      children: [
        _DetailRow(
          label: 'Amount',
          value: formatWithdrawalMoney(quote.amountMinorUnits, quote.currency),
        ),
        const SizedBox(height: 11),
        _DetailRow(
          label: 'Provider fee',
          value: formatWithdrawalMoney(quote.feeMinorUnits, quote.currency),
        ),
        const Padding(
          padding: EdgeInsets.symmetric(vertical: 11),
          child: Divider(height: 1),
        ),
        _DetailRow(
          label: 'You receive',
          value: formatWithdrawalMoney(
            quote.netAmountMinorUnits,
            quote.currency,
          ),
          emphasized: true,
        ),
        const SizedBox(height: 14),
        _DetailRow(label: 'To', value: bankAccount.displayLabel),
        const SizedBox(height: 7),
        _DetailRow(label: 'Account name', value: bankAccount.accountName),
      ],
    ),
  );
}

class _WithdrawalDetailsCard extends StatelessWidget {
  const _WithdrawalDetailsCard({required this.withdrawal});

  final WithdrawalData? withdrawal;

  @override
  Widget build(BuildContext context) => FlowCard(
    child: Column(
      children: [
        _DetailRow(
          label: 'Amount',
          value: formatWithdrawalMoney(
            withdrawal?.amountMinorUnits,
            withdrawal?.currency,
          ),
          emphasized: true,
        ),
        const SizedBox(height: 11),
        _DetailRow(
          label: 'Provider fee',
          value: formatWithdrawalMoney(
            withdrawal?.feeMinorUnits,
            withdrawal?.currency,
          ),
        ),
        const SizedBox(height: 11),
        _DetailRow(
          label: withdrawal?.status == WithdrawalStatus.reversed
              ? 'Requested amount'
              : 'You receive',
          value: formatWithdrawalMoney(
            withdrawal?.netAmountMinorUnits,
            withdrawal?.currency,
          ),
        ),
        const Padding(
          padding: EdgeInsets.symmetric(vertical: 11),
          child: Divider(height: 1),
        ),
        const SizedBox(height: 11),
        _DetailRow(
          label: 'Reference',
          value: withdrawal?.maskedReference ?? 'Unavailable',
        ),
        const SizedBox(height: 11),
        _DetailRow(
          label: 'To',
          value: withdrawal?.bankAccount?.displayLabel ?? 'Unavailable',
        ),
        const SizedBox(height: 11),
        _DetailRow(
          label: 'Status',
          value: _withdrawalStatusLabel(withdrawal?.status),
        ),
        if (withdrawal?.availableBalanceMinorUnits != null) ...[
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 11),
            child: Divider(height: 1),
          ),
          _DetailRow(
            label: 'Available balance',
            value: formatWithdrawalMoney(
              withdrawal!.availableBalanceMinorUnits,
              withdrawal!.currency,
            ),
            emphasized: true,
          ),
        ],
      ],
    ),
  );
}

String _withdrawalStatusLabel(WithdrawalStatus? status) => switch (status) {
  WithdrawalStatus.pendingReview => 'PENDING REVIEW',
  WithdrawalStatus.processing => 'PROCESSING',
  WithdrawalStatus.successful => 'SUCCESSFUL',
  WithdrawalStatus.reversed => 'REVERSED',
  null => 'UNAVAILABLE',
};

class _BankSummary extends StatelessWidget {
  const _BankSummary({required this.account});

  final WithdrawalBankAccount account;

  @override
  Widget build(BuildContext context) => FlowCard(
    child: Column(
      children: [
        _DetailRow(label: 'Account name', value: account.accountName),
        const SizedBox(height: 10),
        _DetailRow(label: 'Bank', value: account.bankName),
        const SizedBox(height: 10),
        _DetailRow(label: 'Account', value: account.maskedAccountNumber),
      ],
    ),
  );
}

class _BankAccountTile extends StatelessWidget {
  const _BankAccountTile({
    required this.account,
    required this.selected,
    this.onTap,
  });

  final WithdrawalBankAccount account;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => Semantics(
    button: onTap != null,
    selected: selected,
    label: '${account.bankName}, ${account.maskedAccountNumber}',
    child: InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(14),
      child: FlowCard(
        borderColor: selected ? AppColors.primaryBright : AppColors.border,
        child: Row(
          children: [
            Container(
              width: 43,
              height: 43,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: AppColors.primaryBright.withValues(alpha: .1),
              ),
              child: const Icon(
                LucideIcons.landmark,
                color: AppColors.primaryBright,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(account.bankName, style: AppTypography.labelBold),
                  Text(
                    '${account.accountName} · ${account.maskedAccountNumber}',
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
        border: Border.all(color: color.withValues(alpha: .72), width: 2),
        boxShadow: [
          BoxShadow(color: color.withValues(alpha: .2), blurRadius: 32),
        ],
      ),
      child: loading
          ? Padding(
              padding: const EdgeInsets.all(29),
              child: CircularProgressIndicator(color: color, strokeWidth: 4),
            )
          : Icon(icon, color: color, size: 49),
    ),
  );
}

class _Notice extends StatelessWidget {
  const _Notice({
    required this.message,
    required this.color,
    this.icon = LucideIcons.info,
  });

  final String message;
  final Color color;
  final IconData icon;

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

class _LoadingCard extends StatelessWidget {
  const _LoadingCard({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) => FlowCard(
    child: Row(
      children: [
        const SizedBox.square(
          dimension: 22,
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
        const SizedBox(width: 12),
        Expanded(child: Text(label, style: AppTypography.bodyLarge)),
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
        const Icon(LucideIcons.cloudOff, color: AppColors.warning, size: 36),
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
