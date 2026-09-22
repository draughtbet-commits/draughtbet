import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../models/match_flow.dart';
import '../models/wallet_read.dart';
import '../providers/wallet_provider.dart';
import '../theme/colors.dart';
import '../theme/typography.dart';
import '../widgets/flow_widgets.dart';
import '../widgets/wallet_read_widgets.dart';

class WalletDashboardScreen extends ConsumerStatefulWidget {
  const WalletDashboardScreen({super.key, this.autoLoad = true});

  final bool autoLoad;

  @override
  ConsumerState<WalletDashboardScreen> createState() =>
      _WalletDashboardScreenState();
}

class _WalletDashboardScreenState extends ConsumerState<WalletDashboardScreen> {
  @override
  void initState() {
    super.initState();
    if (widget.autoLoad) {
      Future.microtask(() {
        ref.read(walletProvider.notifier).fetchBalance();
        ref.read(walletProvider.notifier).fetchTransactions(limit: 5);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(walletProvider);
    if (state.walletPhase == WalletLoadPhase.unavailable &&
        state.projection == null) {
      return WalletUnavailableScreen(
        embedded: true,
        onRetry: () => ref.read(walletProvider.notifier).fetchBalance(),
      );
    }
    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        title: const Text('WALLET'),
        centerTitle: true,
        actions: [
          IconButton(
            tooltip: 'Wallet notifications',
            onPressed: null,
            icon: const Icon(LucideIcons.bell),
          ),
        ],
      ),
      body: SafeArea(
        top: false,
        child: RefreshIndicator(
          onRefresh: () async {
            await Future.wait([
              ref.read(walletProvider.notifier).fetchBalance(),
              ref.read(walletProvider.notifier).fetchTransactions(limit: 5),
            ]);
          },
          child: FlowPage(
            child:
                state.walletPhase == WalletLoadPhase.loading &&
                    state.projection == null
                ? const WalletSkeleton(rows: 5)
                : _WalletDashboardBody(state: state),
          ),
        ),
      ),
    );
  }
}

class _WalletDashboardBody extends StatelessWidget {
  const _WalletDashboardBody({required this.state});

  final WalletState state;

  @override
  Widget build(BuildContext context) {
    final projection = state.projection;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (projection?.isStale == true)
          Container(
            margin: const EdgeInsets.only(bottom: 10),
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(
              color: AppColors.warning.withValues(alpha: .1),
              border: Border.all(color: AppColors.warning),
              borderRadius: BorderRadius.circular(10),
            ),
            child: const Row(
              children: [
                Icon(LucideIcons.cloudOff, size: 17, color: AppColors.warning),
                SizedBox(width: 8),
                Expanded(
                  child: Text('Showing the last verified wallet state.'),
                ),
              ],
            ),
          ),
        FlowCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Available balance', style: AppTypography.bodySmall),
              const SizedBox(height: 7),
              WalletAmount(projection?.availableMinorUnits),
            ],
          ),
        ),
        const SizedBox(height: 10),
        Row(
          children: [
            WalletMetricCard(
              label: 'Locked in matches',
              value: projection?.lockedMinorUnits,
              icon: LucideIcons.lockKeyhole,
              onTap: projection?.lockedMinorUnits == null
                  ? null
                  : () => context.push('/wallet/locked'),
            ),
            const SizedBox(width: 10),
            WalletMetricCard(
              label: 'Pending',
              value: projection?.pendingMinorUnits,
              icon: LucideIcons.clock3,
            ),
          ],
        ),
        const SizedBox(height: 12),
        Row(
          children: [
            Expanded(
              child: FilledButton(
                onPressed: () => ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(
                    content: Text('Add money will be enabled in Deposit V2.'),
                  ),
                ),
                child: const Text('Add money'),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: OutlinedButton(
                onPressed: () => ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(
                    content: Text(
                      'Withdrawals will be enabled in Withdrawal V2.',
                    ),
                  ),
                ),
                child: const Text('Withdraw'),
              ),
            ),
          ],
        ),
        const SizedBox(height: 18),
        Row(
          children: [
            Expanded(
              child: Text('Recent transactions', style: AppTypography.heading3),
            ),
            TextButton(
              onPressed: () => context.push('/wallet/transactions'),
              child: const Text('View all'),
            ),
          ],
        ),
        const SizedBox(height: 8),
        if (state.transactionsPhase == WalletLoadPhase.loading)
          const WalletSkeleton(rows: 3)
        else if (state.transactions.isEmpty)
          _EmptyTransactions(
            compact: true,
            onRefresh: () => context.push('/wallet/transactions'),
          )
        else
          ...state.transactions
              .take(3)
              .map(
                (entry) => Padding(
                  padding: const EdgeInsets.only(bottom: 9),
                  child: WalletTransactionRow(
                    entry: entry,
                    onTap: () =>
                        context.push('/wallet/transaction', extra: entry),
                  ),
                ),
              ),
      ],
    );
  }
}

class TransactionHistoryScreen extends ConsumerStatefulWidget {
  const TransactionHistoryScreen({super.key, this.autoLoad = true});

  final bool autoLoad;

  @override
  ConsumerState<TransactionHistoryScreen> createState() =>
      _TransactionHistoryScreenState();
}

class _TransactionHistoryScreenState
    extends ConsumerState<TransactionHistoryScreen> {
  WalletFilter _filter = const WalletFilter();

  @override
  void initState() {
    super.initState();
    if (widget.autoLoad) {
      Future.microtask(
        () => ref.read(walletProvider.notifier).fetchTransactions(),
      );
    }
  }

  Future<void> _showFilters() async {
    final selected = await showModalBottomSheet<WalletFilter>(
      context: context,
      backgroundColor: AppColors.surface,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (_) => _TransactionFilterSheet(initial: _filter),
    );
    if (selected != null && mounted) setState(() => _filter = selected);
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(walletProvider);
    final entries = state.transactions.where(_filter.accepts).toList();
    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        title: const Text('TRANSACTION HISTORY'),
        actions: [
          IconButton(
            tooltip: 'Filter transactions',
            onPressed: _showFilters,
            icon: const Icon(LucideIcons.listFilter),
          ),
        ],
      ),
      body: SafeArea(
        top: false,
        child: FlowPage(
          child: state.transactionsPhase == WalletLoadPhase.loading
              ? const WalletSkeleton(rows: 6)
              : state.transactionsPhase == WalletLoadPhase.failure
              ? RecoverableState(
                  title: 'Transactions unavailable',
                  message:
                      state.error ?? 'We could not load your transactions.',
                  actionLabel: 'Retry',
                  onAction: () =>
                      ref.read(walletProvider.notifier).fetchTransactions(),
                  icon: LucideIcons.refreshCw,
                )
              : entries.isEmpty
              ? _EmptyTransactions(
                  onRefresh: () =>
                      ref.read(walletProvider.notifier).fetchTransactions(),
                )
              : Column(
                  children: [
                    ...entries.map(
                      (entry) => Padding(
                        padding: const EdgeInsets.only(bottom: 9),
                        child: WalletTransactionRow(
                          entry: entry,
                          onTap: () =>
                              context.push('/wallet/transaction', extra: entry),
                        ),
                      ),
                    ),
                    if (state.hasMore)
                      TextButton(
                        onPressed: state.isLoadingMore
                            ? null
                            : () => ref
                                  .read(walletProvider.notifier)
                                  .loadMoreTransactions(),
                        child: state.isLoadingMore
                            ? const SizedBox.square(
                                dimension: 20,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              )
                            : const Text('Load more'),
                      ),
                  ],
                ),
        ),
      ),
    );
  }
}

class WalletTransactionDetailScreen extends StatelessWidget {
  const WalletTransactionDetailScreen({required this.entry, super.key});

  final WalletEntry entry;

  String get _displayReference {
    final reference = entry.authoritativeReference;
    if (reference.length <= 20) return reference;
    return '${reference.substring(0, 8)}…${reference.substring(reference.length - 8)}';
  }

  String get _title => switch (entry.kind) {
    WalletEntryKind.deposit => 'DEPOSIT',
    WalletEntryKind.stake => 'MATCH STAKE',
    WalletEntryKind.payout => 'PAYOUT',
    WalletEntryKind.withdrawal => 'WITHDRAWAL',
    WalletEntryKind.refund => 'REFUND',
    WalletEntryKind.other => 'TRANSACTION',
  };

  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: AppColors.background,
    appBar: AppBar(title: const Text('TRANSACTION DETAILS')),
    body: SafeArea(
      top: false,
      child: FlowPage(
        scrollable: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const SizedBox(height: 24),
            Container(
              alignment: Alignment.center,
              child: const Icon(
                LucideIcons.circleCheckBig,
                size: 72,
                color: AppColors.primaryBright,
              ),
            ),
            const SizedBox(height: 16),
            Text(
              _title,
              textAlign: TextAlign.center,
              style: AppTypography.heading2,
            ),
            const SizedBox(height: 8),
            Text(
              Money(entry.amountMinorUnits.abs()).format(showKobo: true),
              textAlign: TextAlign.center,
              style: AppTypography.balance,
            ),
            const SizedBox(height: 24),
            FlowCard(
              child: Column(
                children: [
                  _DetailRow('Reference', _displayReference),
                  _DetailRow('Status', entry.status),
                  _DetailRow(
                    'Date',
                    entry.createdAt.toLocal().toString().split('.').first,
                  ),
                  if (entry.relatedMatchId != null)
                    _DetailRow('Match ID', entry.relatedMatchId!),
                  if (entry.feeMinorUnits != null)
                    _DetailRow(
                      'Processing fee',
                      Money(entry.feeMinorUnits!).format(),
                    ),
                  if (entry.balanceImpactMinorUnits != null)
                    _DetailRow(
                      'Balance impact',
                      Money(entry.balanceImpactMinorUnits!).format(),
                    ),
                ],
              ),
            ),
            const Spacer(),
            FilledButton(
              onPressed: () => context.go('/wallet'),
              child: const Text('View wallet'),
            ),
          ],
        ),
      ),
    ),
  );
}

class LockedFundsScreen extends ConsumerWidget {
  const LockedFundsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final projection = ref.watch(walletProvider).projection;
    final items = projection?.lockedFunds ?? const <LockedFundItem>[];
    final locked = projection?.lockedMinorUnits;
    final pending = projection?.pendingMinorUnits;
    final isDeferred = locked == null || pending == null;
    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(title: const Text('LOCKED FUNDS')),
      body: SafeArea(
        top: false,
        child: FlowPage(
          scrollable: false,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SizedBox(height: 18),
              const Icon(
                LucideIcons.lockKeyhole,
                size: 64,
                color: AppColors.valueAccent,
              ),
              const SizedBox(height: 12),
              WalletAmount(
                locked,
                style: AppTypography.balance.copyWith(
                  fontSize: 32,
                  fontWeight: FontWeight.w600,
                ),
              ),
              Text(
                isDeferred
                    ? 'Locked funds unavailable'
                    : 'Currently locked in matches',
                textAlign: TextAlign.center,
                style: AppTypography.bodyLarge,
              ),
              const SizedBox(height: 20),
              if (isDeferred)
                const FlowCard(
                  child: Text(
                    'Locked and pending balances are not available yet. No amount has been estimated.',
                    textAlign: TextAlign.center,
                  ),
                )
              else if (pending > 0)
                FlowCard(
                  child: Text(
                    'Pending withdrawal: ${Money(pending).format()}',
                    textAlign: TextAlign.center,
                  ),
                )
              else if (items.isEmpty)
                const FlowCard(
                  child: Text(
                    'The server has not provided a match-level locked-funds breakdown.',
                    textAlign: TextAlign.center,
                  ),
                )
              else
                ...items.map(
                  (item) => Padding(
                    padding: const EdgeInsets.only(bottom: 9),
                    child: FlowCard(
                      child: ListTile(
                        contentPadding: EdgeInsets.zero,
                        leading: const Icon(LucideIcons.shieldCheck),
                        title: Text(
                          item.opponentName ?? 'Match ${item.matchId}',
                        ),
                        subtitle: Text(item.status),
                        trailing: Text(Money(item.amountMinorUnits).format()),
                      ),
                    ),
                  ),
                ),
              const Spacer(),
              Text(
                'Funds are released only after server confirmation.',
                textAlign: TextAlign.center,
                style: AppTypography.bodySmall,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class WalletUnavailableScreen extends StatelessWidget {
  const WalletUnavailableScreen({
    super.key,
    this.embedded = false,
    this.onRetry,
  });

  final bool embedded;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final content = RecoverableState(
      title: 'Wallet unavailable',
      message: 'Balances could not be verified. Money actions are disabled.',
      actionLabel: 'Retry',
      onAction: onRetry ?? () {},
      icon: LucideIcons.walletCards,
    );
    if (embedded) {
      return Scaffold(
        backgroundColor: AppColors.background,
        appBar: AppBar(title: const Text('WALLET'), centerTitle: true),
        body: SafeArea(child: content),
      );
    }
    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(title: const Text('WALLET')),
      body: SafeArea(child: content),
    );
  }
}

class _EmptyTransactions extends StatelessWidget {
  const _EmptyTransactions({required this.onRefresh, this.compact = false});

  final VoidCallback onRefresh;
  final bool compact;

  @override
  Widget build(BuildContext context) => SizedBox(
    height: compact ? 210 : 620,
    child: RecoverableState(
      title: 'No transactions yet',
      message:
          'Deposits, stakes, payouts, withdrawals and refunds will appear here.',
      actionLabel: 'Refresh',
      onAction: onRefresh,
      icon: LucideIcons.walletMinimal,
    ),
  );
}

class _TransactionFilterSheet extends StatefulWidget {
  const _TransactionFilterSheet({required this.initial});

  final WalletFilter initial;

  @override
  State<_TransactionFilterSheet> createState() =>
      _TransactionFilterSheetState();
}

class _TransactionFilterSheetState extends State<_TransactionFilterSheet> {
  WalletEntryKind? _kind;
  String? _status;

  @override
  void initState() {
    super.initState();
    _kind = widget.initial.kind;
    _status = widget.initial.status;
  }

  @override
  Widget build(BuildContext context) => SafeArea(
    child: SingleChildScrollView(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('Filter transactions', style: AppTypography.heading3),
            const SizedBox(height: 14),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children:
                  [
                        const MapEntry<WalletEntryKind?, String>(null, 'All'),
                        ...WalletEntryKind.values.map(
                          (kind) => MapEntry<WalletEntryKind?, String>(
                            kind,
                            kind.name,
                          ),
                        ),
                      ]
                      .map(
                        (choice) => ChoiceChip(
                          label: Text(choice.value),
                          selected: _kind == choice.key,
                          onSelected: (_) => setState(() => _kind = choice.key),
                        ),
                      )
                      .toList(),
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              children: [null, 'SUCCESS', 'PENDING', 'FAILED']
                  .map(
                    (status) => ChoiceChip(
                      label: Text(status ?? 'Any status'),
                      selected: _status == status,
                      onSelected: (_) => setState(() => _status = status),
                    ),
                  )
                  .toList(),
            ),
            const SizedBox(height: 18),
            FilledButton(
              onPressed: () => Navigator.pop(
                context,
                WalletFilter(kind: _kind, status: _status),
              ),
              child: const Text('Apply filters'),
            ),
          ],
        ),
      ),
    ),
  );
}

class _DetailRow extends StatelessWidget {
  const _DetailRow(this.label, this.value);

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 10),
    child: Row(
      children: [
        Expanded(child: Text(label, style: AppTypography.bodySmall)),
        Flexible(
          child: Text(
            value,
            textAlign: TextAlign.end,
            style: AppTypography.labelBold,
          ),
        ),
      ],
    ),
  );
}
