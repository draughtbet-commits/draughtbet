import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../providers/wallet_provider.dart';
import '../theme/colors.dart';
import '../theme/typography.dart';

class WalletScreen extends ConsumerStatefulWidget {
  const WalletScreen({super.key});

  @override
  ConsumerState<WalletScreen> createState() => _WalletScreenState();
}

class _WalletScreenState extends ConsumerState<WalletScreen> {
  @override
  void initState() {
    super.initState();
    Future.microtask(() {
      ref.read(walletProvider.notifier).fetchBalance();
      ref.read(walletProvider.notifier).fetchTransactions();
    });
  }

  void _showDepositModal() {
    showModalBottomSheet(
      context: context,
      backgroundColor: AppColors.surface1,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (context) => const _DepositModal(),
    );
  }

  void _showWithdrawalModal() {
    showModalBottomSheet(
      context: context,
      backgroundColor: AppColors.surface1,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (context) => const _WithdrawalModal(),
    );
  }

  @override
  Widget build(BuildContext context) {
    final walletState = ref.watch(walletProvider);
    final currencyFormatter = NumberFormat.currency(symbol: '₦', decimalDigits: 0);
    final double balance = (int.tryParse(walletState.balance ?? '0') ?? 0) / 100;

    return Scaffold(
      backgroundColor: AppColors.voidBg,
      appBar: AppBar(
        backgroundColor: AppColors.voidBg,
        title: Text('Wallet', style: AppTypography.heading2),
        elevation: 0,
      ),
      body: walletState.isLoading && walletState.balance == null
          ? const Center(child: CircularProgressIndicator(color: AppColors.gold500))
          : Column(
              children: [
                const SizedBox(height: 24),
                // Balance Chip
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 24),
                  decoration: BoxDecoration(
                    color: AppColors.surface2,
                    borderRadius: BorderRadius.circular(24),
                    border: Border.all(color: AppColors.hairline),
                  ),
                  child: Column(
                    children: [
                      Text('Available Balance', style: AppTypography.bodySmall),
                      const SizedBox(height: 8),
                      Text(
                        currencyFormatter.format(balance),
                        style: AppTypography.heading1.copyWith(color: AppColors.gold500),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 24),
                // Action Buttons
                Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    ElevatedButton.icon(
                      onPressed: _showDepositModal,
                      style: ElevatedButton.styleFrom(
                        backgroundColor: AppColors.gold500,
                        foregroundColor: AppColors.voidBg,
                        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                      ),
                      icon: const Icon(LucideIcons.arrowDownToLine),
                      label: Text('Deposit', style: AppTypography.labelBold),
                    ),
                    const SizedBox(width: 16),
                    OutlinedButton.icon(
                      onPressed: _showWithdrawalModal,
                      style: OutlinedButton.styleFrom(
                        foregroundColor: AppColors.textPrimary,
                        side: const BorderSide(color: AppColors.hairline),
                        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                      ),
                      icon: const Icon(LucideIcons.arrowUpFromLine),
                      label: Text('Withdraw', style: AppTypography.labelBold),
                    ),
                  ],
                ),
                const SizedBox(height: 32),
                // Transactions
                Expanded(
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                    decoration: const BoxDecoration(
                      color: AppColors.surface1,
                      borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const SizedBox(height: 24),
                        Text('Recent Transactions', style: AppTypography.heading3),
                        const SizedBox(height: 16),
                        Expanded(
                          child: walletState.transactions.isEmpty
                              ? Center(
                                  child: Text(
                                    'No recent transactions',
                                    style: AppTypography.bodyMedium.copyWith(color: AppColors.textMuted),
                                  ),
                                )
                              : ListView.separated(
                                  itemCount: walletState.transactions.length,
                                  separatorBuilder: (context, index) => const Divider(color: AppColors.hairline),
                                  itemBuilder: (context, index) {
                                    final tx = walletState.transactions[index];
                                    final amt = (int.tryParse(tx.amountMinorUnits) ?? 0) / 100;
                                    final isPositive = tx.type == 'DEPOSIT' || tx.type == 'PAYOUT';
                                    
                                    return ListTile(
                                      contentPadding: EdgeInsets.zero,
                                      leading: CircleAvatar(
                                        backgroundColor: AppColors.surface3,
                                        child: Icon(
                                          isPositive ? LucideIcons.arrowDownLeft : LucideIcons.arrowUpRight,
                                          color: isPositive ? AppColors.success : AppColors.danger,
                                          size: 16,
                                        ),
                                      ),
                                      title: Text(tx.type, style: AppTypography.bodyMedium),
                                      subtitle: Text(
                                        DateFormat.yMMMd().format(tx.createdAt),
                                        style: AppTypography.bodySmall,
                                      ),
                                      trailing: Column(
                                        mainAxisAlignment: MainAxisAlignment.center,
                                        crossAxisAlignment: CrossAxisAlignment.end,
                                        children: [
                                          Text(
                                            '${isPositive ? '+' : '-'}${currencyFormatter.format(amt)}',
                                            style: AppTypography.labelBold.copyWith(
                                              color: isPositive ? AppColors.success : AppColors.textPrimary,
                                            ),
                                          ),
                                          Text(
                                            tx.status,
                                            style: AppTypography.bodySmall.copyWith(
                                              color: tx.status == 'PENDING' ? AppColors.warning : AppColors.textMuted,
                                              fontSize: 10,
                                            ),
                                          ),
                                        ],
                                      ),
                                    );
                                  },
                                ),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
    );
  }
}

class _DepositModal extends ConsumerStatefulWidget {
  const _DepositModal();

  @override
  ConsumerState<_DepositModal> createState() => _DepositModalState();
}

class _DepositModalState extends ConsumerState<_DepositModal> {
  final _amountController = TextEditingController();
  String _gateway = 'paystack';
  bool _isLoading = false;

  Future<void> _submit() async {
    final amount = double.tryParse(_amountController.text);
    if (amount == null || amount <= 0) return;
    
    setState(() => _isLoading = true);
    final response = await ref.read(walletProvider.notifier).initiateDeposit(
      (amount * 100).toInt(),
      _gateway,
    );
    setState(() => _isLoading = false);

    if (response != null && response['authorizationUrl'] != null && mounted) {
      context.pop(); // close modal
      context.push('/checkout', extra: response['authorizationUrl']);
    } else if (mounted) {
      final error = ref.read(walletProvider).error ?? 'Failed to initiate deposit';
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(error)));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(
        left: 24,
        right: 24,
        top: 24,
        bottom: MediaQuery.of(context).viewInsets.bottom + 24,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Deposit Funds', style: AppTypography.heading2),
          const SizedBox(height: 16),
          TextField(
            controller: _amountController,
            keyboardType: TextInputType.number,
            style: AppTypography.bodyMedium,
            decoration: InputDecoration(
              labelText: 'Amount (₦)',
              labelStyle: AppTypography.bodySmall,
              filled: true,
              fillColor: AppColors.surface2,
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
                borderSide: BorderSide.none,
              ),
            ),
          ),
          const SizedBox(height: 16),
          Text('Select Gateway', style: AppTypography.bodySmall),
          Row(
            children: [
              Expanded(
                child: RadioListTile<String>(
                  title: Text('Paystack', style: AppTypography.bodyMedium),
                  value: 'paystack',
                  groupValue: _gateway,
                  activeColor: AppColors.gold500,
                  onChanged: (val) => setState(() => _gateway = val!),
                ),
              ),
              Expanded(
                child: RadioListTile<String>(
                  title: Text('Flutterwave', style: AppTypography.bodyMedium),
                  value: 'flutterwave',
                  groupValue: _gateway,
                  activeColor: AppColors.gold500,
                  onChanged: (val) => setState(() => _gateway = val!),
                ),
              ),
            ],
          ),
          const SizedBox(height: 24),
          SizedBox(
            width: double.infinity,
            child: ElevatedButton(
              onPressed: _isLoading ? null : _submit,
              style: ElevatedButton.styleFrom(
                backgroundColor: AppColors.gold500,
                padding: const EdgeInsets.symmetric(vertical: 16),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
              ),
              child: _isLoading 
                  ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(color: AppColors.voidBg))
                  : Text('Continue to Payment', style: AppTypography.labelBold.copyWith(color: AppColors.voidBg)),
            ),
          ),
        ],
      ),
    );
  }
}

class _WithdrawalModal extends ConsumerStatefulWidget {
  const _WithdrawalModal();

  @override
  ConsumerState<_WithdrawalModal> createState() => _WithdrawalModalState();
}

class _WithdrawalModalState extends ConsumerState<_WithdrawalModal> {
  final _amountController = TextEditingController();
  bool _isLoading = false;

  Future<void> _submit() async {
    final amount = double.tryParse(_amountController.text);
    if (amount == null || amount <= 0) return;
    
    setState(() => _isLoading = true);
    final success = await ref.read(walletProvider.notifier).requestWithdrawal(
      (amount * 100).toInt(),
    );
    setState(() => _isLoading = false);

    if (success && mounted) {
      context.pop(); // close modal
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Withdrawal request submitted for review.')),
      );
    } else if (mounted) {
      final error = ref.read(walletProvider).error ?? 'Failed to request withdrawal';
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(error)));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(
        left: 24,
        right: 24,
        top: 24,
        bottom: MediaQuery.of(context).viewInsets.bottom + 24,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Withdraw Funds', style: AppTypography.heading2),
          const SizedBox(height: 8),
          Text('Withdrawals are subject to admin approval and typically process within 24 hours.', style: AppTypography.bodySmall),
          const SizedBox(height: 16),
          TextField(
            controller: _amountController,
            keyboardType: TextInputType.number,
            style: AppTypography.bodyMedium,
            decoration: InputDecoration(
              labelText: 'Amount (₦)',
              labelStyle: AppTypography.bodySmall,
              filled: true,
              fillColor: AppColors.surface2,
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
                borderSide: BorderSide.none,
              ),
            ),
          ),
          const SizedBox(height: 24),
          SizedBox(
            width: double.infinity,
            child: ElevatedButton(
              onPressed: _isLoading ? null : _submit,
              style: ElevatedButton.styleFrom(
                backgroundColor: AppColors.gold500,
                padding: const EdgeInsets.symmetric(vertical: 16),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
              ),
              child: _isLoading 
                  ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(color: AppColors.voidBg))
                  : Text('Submit Request', style: AppTypography.labelBold.copyWith(color: AppColors.voidBg)),
            ),
          ),
        ],
      ),
    );
  }
}
