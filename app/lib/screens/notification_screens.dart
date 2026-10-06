import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../models/app_notification.dart';
import '../providers/notification_provider.dart';
import '../services/secure_storage.dart';
import '../theme/colors.dart';
import '../theme/typography.dart';
import '../widgets/flow_widgets.dart';

enum NotificationFilter { all, matches, disputes, system }

class NotificationsScreen extends ConsumerStatefulWidget {
  const NotificationsScreen({super.key});

  @override
  ConsumerState<NotificationsScreen> createState() =>
      _NotificationsScreenState();
}

class _NotificationsScreenState extends ConsumerState<NotificationsScreen> {
  NotificationFilter _filter = NotificationFilter.all;

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(notificationProvider);
    final filtered = state.notifications.where(_matchesFilter).toList();
    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        backgroundColor: AppColors.background,
        leading: const _NotificationBackButton(),
        title: const Text('NOTIFICATIONS'),
        actions: [
          if (state.unreadCount > 0)
            TextButton(
              key: const Key('mark-all-read'),
              onPressed: state.phase == NotificationLoadPhase.refreshing
                  ? null
                  : () =>
                        ref.read(notificationProvider.notifier).markAllAsRead(),
              child: const Text('Mark all read'),
            ),
        ],
      ),
      body: SafeArea(
        top: false,
        child: RefreshIndicator(
          onRefresh: () => ref.read(notificationProvider.notifier).refresh(),
          color: AppColors.primaryBright,
          backgroundColor: AppColors.surfaceRaised,
          child: CustomScrollView(
            physics: const AlwaysScrollableScrollPhysics(),
            slivers: [
              if (state.notifications.isNotEmpty)
                SliverToBoxAdapter(
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
                    child: _FilterBar(
                      selected: _filter,
                      onSelected: (filter) => setState(() => _filter = filter),
                    ),
                  ),
                ),
              if (state.message != null && state.notifications.isNotEmpty)
                SliverToBoxAdapter(
                  child: _InlineMessage(
                    message: state.message!,
                    onRetry: () =>
                        ref.read(notificationProvider.notifier).refresh(),
                  ),
                ),
              ..._content(state, filtered),
            ],
          ),
        ),
      ),
    );
  }

  bool _matchesFilter(AppNotification notification) => switch (_filter) {
    NotificationFilter.all => true,
    NotificationFilter.matches =>
      notification.category == NotificationCategory.matches,
    NotificationFilter.disputes =>
      notification.category == NotificationCategory.disputes,
    NotificationFilter.system =>
      notification.category == NotificationCategory.system,
  };

  List<Widget> _content(
    NotificationState state,
    List<AppNotification> filtered,
  ) {
    if (state.isLoading && state.notifications.isEmpty) {
      return const [
        SliverPadding(
          padding: EdgeInsets.symmetric(horizontal: 16),
          sliver: SliverToBoxAdapter(child: _NotificationLoadingState()),
        ),
      ];
    }
    if (state.phase == NotificationLoadPhase.error &&
        state.notifications.isEmpty) {
      return [
        SliverFillRemaining(
          hasScrollBody: false,
          child: _NotificationErrorState(
            message: state.message ?? 'Notifications are unavailable.',
            onRetry: () => ref.read(notificationProvider.notifier).refresh(),
          ),
        ),
      ];
    }
    if (state.notifications.isEmpty) {
      return const [
        SliverFillRemaining(hasScrollBody: false, child: _EmptyNotifications()),
      ];
    }
    if (filtered.isEmpty) {
      return [
        const SliverFillRemaining(
          hasScrollBody: false,
          child: _FilteredEmptyState(),
        ),
      ];
    }
    return [
      SliverPadding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
        sliver: SliverList.separated(
          itemCount: filtered.length + (state.hasMore ? 1 : 0),
          separatorBuilder: (_, _) => const SizedBox(height: 8),
          itemBuilder: (context, index) {
            if (index == filtered.length) {
              return TextButton(
                onPressed: () =>
                    ref.read(notificationProvider.notifier).loadMore(),
                child: const Text('Load earlier notifications'),
              );
            }
            final notification = filtered[index];
            return _NotificationTile(
              notification: notification,
              onTap: () {
                ref
                    .read(notificationProvider.notifier)
                    .markAsRead(notification.id);
                context.push(
                  '/profile/notification-details',
                  extra: notification,
                );
              },
            );
          },
        ),
      ),
    ];
  }
}

class NotificationDetailsScreen extends ConsumerWidget {
  const NotificationDetailsScreen({required this.notification, super.key});

  final AppNotification notification;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        backgroundColor: AppColors.background,
        leading: const _NotificationBackButton(),
        title: const Text('NOTIFICATION DETAILS'),
      ),
      body: SafeArea(
        top: false,
        child: _NotificationPage(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SizedBox(height: 18),
              Center(
                child: _NotificationIcon(
                  notification: notification,
                  size: 78,
                  iconSize: 34,
                ),
              ),
              const SizedBox(height: 20),
              Text(
                notification.title,
                textAlign: TextAlign.center,
                style: AppTypography.heading2,
              ),
              const SizedBox(height: 8),
              Text(
                _detailTime(notification.createdAt),
                textAlign: TextAlign.center,
                style: AppTypography.bodySmall,
              ),
              const SizedBox(height: 24),
              FlowCard(
                child: Text(
                  notification.message,
                  style: AppTypography.bodyLarge.copyWith(height: 1.5),
                ),
              ),
              const SizedBox(height: 14),
              const FlowCard(
                borderColor: AppColors.primaryAction,
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(
                      LucideIcons.shieldCheck,
                      color: AppColors.primaryBright,
                    ),
                    SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        'This update is based on the latest server-confirmed account state.',
                        style: AppTypography.bodySmall,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 24),
              if (notification.hasSafeLink)
                PrimaryActionButton(
                  label: 'Open related item',
                  icon: LucideIcons.externalLink,
                  onPressed: () => context.push(notification.link!),
                ),
              if (notification.hasSafeLink) const SizedBox(height: 8),
              SecondaryActionButton(
                label: 'Back to notifications',
                onPressed: () => context.pop(),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class NotificationPreferencesScreen extends StatefulWidget {
  const NotificationPreferencesScreen({super.key, this.storage});

  final SecureStorageService? storage;

  @override
  State<NotificationPreferencesScreen> createState() =>
      _NotificationPreferencesScreenState();
}

class _NotificationPreferencesScreenState
    extends State<NotificationPreferencesScreen> {
  late final SecureStorageService _storage =
      widget.storage ?? SecureStorageService();
  bool _loading = true;
  bool _saving = false;
  bool _matchUpdates = true;
  bool _disputeUpdates = true;
  bool _promotions = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final values = await Future.wait([
        _storage.read(key: 'pref_notification_matches'),
        _storage.read(key: 'pref_notification_disputes'),
        _storage.read(key: 'pref_notification_promotions'),
      ]);
      if (!mounted) return;
      setState(() {
        _matchUpdates = values[0] != 'false';
        _disputeUpdates = values[1] != 'false';
        _promotions = values[2] == 'true';
      });
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _save() async {
    if (_saving) return;
    setState(() => _saving = true);
    try {
      await Future.wait([
        _storage.write(
          key: 'pref_notification_matches',
          value: _matchUpdates.toString(),
        ),
        _storage.write(
          key: 'pref_notification_disputes',
          value: _disputeUpdates.toString(),
        ),
        _storage.write(
          key: 'pref_notification_promotions',
          value: _promotions.toString(),
        ),
      ]);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Notification preferences saved.')),
      );
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        backgroundColor: AppColors.background,
        leading: const _NotificationBackButton(),
        title: const Text('NOTIFICATION PREFERENCES'),
      ),
      body: SafeArea(
        top: false,
        child: _NotificationPage(
          child: _loading
              ? const Center(child: CircularProgressIndicator())
              : Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(
                      'Choose which optional updates you receive on this device.',
                      style: AppTypography.bodyLarge.copyWith(
                        color: AppColors.textSecondary,
                      ),
                    ),
                    const SizedBox(height: 18),
                    _PreferenceTile(
                      icon: LucideIcons.swords,
                      title: 'Match updates',
                      subtitle: 'Turns, match reminders and call-outs',
                      value: _matchUpdates,
                      onChanged: (value) =>
                          setState(() => _matchUpdates = value),
                    ),
                    const SizedBox(height: 10),
                    _PreferenceTile(
                      icon: LucideIcons.flag,
                      title: 'Disputes and support',
                      subtitle: 'Reports, reviews and support replies',
                      value: _disputeUpdates,
                      onChanged: (value) =>
                          setState(() => _disputeUpdates = value),
                    ),
                    const SizedBox(height: 10),
                    _PreferenceTile(
                      icon: LucideIcons.megaphone,
                      title: 'Promotions',
                      subtitle: 'Optional news and promotional updates',
                      value: _promotions,
                      onChanged: (value) => setState(() => _promotions = value),
                    ),
                    const SizedBox(height: 10),
                    const _PreferenceTile(
                      icon: LucideIcons.shieldCheck,
                      title: 'Money and security updates',
                      subtitle:
                          'Deposits, withdrawals, settlements and account security',
                      value: true,
                      enabled: false,
                    ),
                    const SizedBox(height: 14),
                    Text(
                      'Critical money and security updates cannot be disabled.',
                      style: AppTypography.bodySmall,
                    ),
                    const SizedBox(height: 26),
                    PrimaryActionButton(
                      key: const Key('save-notification-preferences'),
                      label: 'Save preferences',
                      loading: _saving,
                      onPressed: _saving ? null : _save,
                    ),
                  ],
                ),
        ),
      ),
    );
  }
}

class _FilterBar extends StatelessWidget {
  const _FilterBar({required this.selected, required this.onSelected});

  final NotificationFilter selected;
  final ValueChanged<NotificationFilter> onSelected;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        for (final filter in NotificationFilter.values) ...[
          Expanded(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 3),
              child: _FilterChip(
                label: switch (filter) {
                  NotificationFilter.all => 'All',
                  NotificationFilter.matches => 'Matches',
                  NotificationFilter.disputes => 'Disputes',
                  NotificationFilter.system => 'System',
                },
                selected: selected == filter,
                onTap: () => onSelected(filter),
              ),
            ),
          ),
        ],
      ],
    );
  }
}

class _NotificationBackButton extends StatelessWidget {
  const _NotificationBackButton();

  @override
  Widget build(BuildContext context) {
    return IconButton(
      tooltip: 'Back',
      onPressed: () {
        if (Navigator.of(context).canPop()) {
          context.pop();
        } else {
          context.go('/profile');
        }
      },
      icon: const Icon(LucideIcons.chevronLeft),
    );
  }
}

class _NotificationPage extends StatelessWidget {
  const _NotificationPage({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) => SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
        child: Center(
          child: ConstrainedBox(
            constraints: BoxConstraints(
              maxWidth: 560,
              minHeight: constraints.maxHeight - 32,
            ),
            child: child,
          ),
        ),
      ),
    );
  }
}

class _FilterChip extends StatelessWidget {
  const _FilterChip({
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      selected: selected,
      button: true,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(8),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 150),
          padding: const EdgeInsets.symmetric(vertical: 9),
          decoration: BoxDecoration(
            color: selected ? AppColors.primaryAction : AppColors.surface,
            borderRadius: BorderRadius.circular(8),
            border: Border.all(
              color: selected ? AppColors.primaryBright : AppColors.border,
            ),
          ),
          child: Text(
            label,
            textAlign: TextAlign.center,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: AppTypography.bodySmall.copyWith(
              color: selected ? AppColors.textPrimary : AppColors.textSecondary,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
      ),
    );
  }
}

class _NotificationTile extends StatelessWidget {
  const _NotificationTile({required this.notification, required this.onTap});

  final AppNotification notification;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label:
          '${notification.isRead ? 'Read' : 'Unread'} notification: ${notification.title}',
      child: Material(
        color: notification.isRead
            ? AppColors.surface
            : AppColors.surfaceRaised,
        borderRadius: BorderRadius.circular(12),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(12),
          child: Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: AppColors.border),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _NotificationIcon(notification: notification),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: Text(
                              notification.title,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: AppTypography.labelBold,
                            ),
                          ),
                          const SizedBox(width: 8),
                          Text(
                            _relativeTime(notification.createdAt),
                            style: AppTypography.bodySmall.copyWith(
                              fontSize: 11,
                            ),
                          ),
                          if (!notification.isRead) ...[
                            const SizedBox(width: 7),
                            const DecoratedBox(
                              decoration: BoxDecoration(
                                color: AppColors.primaryBright,
                                shape: BoxShape.circle,
                              ),
                              child: SizedBox.square(dimension: 7),
                            ),
                          ],
                        ],
                      ),
                      const SizedBox(height: 3),
                      Text(
                        notification.message,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: AppTypography.bodySmall,
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 4),
                const Icon(
                  LucideIcons.chevronRight,
                  size: 18,
                  color: AppColors.textMuted,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _NotificationIcon extends StatelessWidget {
  const _NotificationIcon({
    required this.notification,
    this.size = 44,
    this.iconSize = 21,
  });

  final AppNotification notification;
  final double size;
  final double iconSize;

  @override
  Widget build(BuildContext context) {
    final (icon, color) = _notificationVisual(notification.type);
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: color.withValues(alpha: 0.12),
        border: Border.all(color: color.withValues(alpha: 0.45)),
      ),
      child: Icon(icon, color: color, size: iconSize),
    );
  }
}

class _EmptyNotifications extends StatelessWidget {
  const _EmptyNotifications();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(32, 34, 32, 24),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Container(
            width: 112,
            height: 112,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: AppColors.surface,
              border: Border.all(color: AppColors.border),
              boxShadow: const [
                BoxShadow(color: AppColors.primaryGlow, blurRadius: 28),
              ],
            ),
            child: const Stack(
              alignment: Alignment.center,
              children: [
                Icon(
                  LucideIcons.bell,
                  size: 52,
                  color: AppColors.textSecondary,
                ),
                Positioned(
                  right: 20,
                  bottom: 20,
                  child: Icon(
                    LucideIcons.clock3,
                    size: 26,
                    color: AppColors.primaryBright,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 26),
          Text('YOU’RE ALL CAUGHT UP', style: AppTypography.heading3),
          const SizedBox(height: 8),
          Text(
            'We’ll let you know about match updates, payments and important account activity.',
            textAlign: TextAlign.center,
            style: AppTypography.bodyLarge.copyWith(
              color: AppColors.textSecondary,
            ),
          ),
          const SizedBox(height: 26),
          PrimaryActionButton(
            label: 'Browse Arena',
            onPressed: () => context.go('/arena'),
          ),
        ],
      ),
    );
  }
}

class _FilteredEmptyState extends StatelessWidget {
  const _FilteredEmptyState();

  @override
  Widget build(BuildContext context) {
    return const Center(
      child: Padding(
        padding: EdgeInsets.all(32),
        child: Text(
          'No notifications in this category.',
          textAlign: TextAlign.center,
          style: AppTypography.bodyLarge,
        ),
      ),
    );
  }
}

class _NotificationLoadingState extends StatelessWidget {
  const _NotificationLoadingState();

  @override
  Widget build(BuildContext context) {
    return Column(
      children: List.generate(
        5,
        (index) => Container(
          height: 78,
          margin: const EdgeInsets.only(bottom: 8),
          decoration: BoxDecoration(
            color: AppColors.surface,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: AppColors.border),
          ),
        ),
      ),
    );
  }
}

class _NotificationErrorState extends StatelessWidget {
  const _NotificationErrorState({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(32),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Icon(
            LucideIcons.circleAlert,
            color: AppColors.danger,
            size: 64,
          ),
          const SizedBox(height: 18),
          Text('NOTIFICATIONS UNAVAILABLE', style: AppTypography.heading3),
          const SizedBox(height: 8),
          Text(
            message,
            textAlign: TextAlign.center,
            style: AppTypography.bodyLarge.copyWith(
              color: AppColors.textSecondary,
            ),
          ),
          const SizedBox(height: 24),
          PrimaryActionButton(label: 'Retry', onPressed: onRetry),
        ],
      ),
    );
  }
}

class _InlineMessage extends StatelessWidget {
  const _InlineMessage({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 10),
      child: FlowCard(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        borderColor: AppColors.warning,
        child: Row(
          children: [
            const Icon(
              LucideIcons.triangleAlert,
              size: 18,
              color: AppColors.warning,
            ),
            const SizedBox(width: 9),
            Expanded(child: Text(message, style: AppTypography.bodySmall)),
            TextButton(onPressed: onRetry, child: const Text('Retry')),
          ],
        ),
      ),
    );
  }
}

class _PreferenceTile extends StatelessWidget {
  const _PreferenceTile({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.value,
    this.onChanged,
    this.enabled = true,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final bool value;
  final ValueChanged<bool>? onChanged;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    return FlowCard(
      child: Row(
        children: [
          Icon(
            icon,
            color: enabled ? AppColors.primaryBright : AppColors.valueAccent,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: AppTypography.labelBold),
                const SizedBox(height: 2),
                Text(subtitle, style: AppTypography.bodySmall),
              ],
            ),
          ),
          Switch(
            value: value,
            onChanged: enabled ? onChanged : null,
            activeThumbColor: AppColors.primaryBright,
          ),
        ],
      ),
    );
  }
}

(IconData, Color) _notificationVisual(String type) {
  final value = type.toUpperCase();
  if (value.contains('WIN') || value.contains('SETTLED')) {
    return (LucideIcons.trophy, AppColors.valueAccent);
  }
  if (value.contains('CALLOUT') || value.contains('MATCH')) {
    return (LucideIcons.swords, AppColors.primaryBright);
  }
  if (value.contains('DEPOSIT') || value.contains('WITHDRAW')) {
    return (LucideIcons.wallet, AppColors.primaryBright);
  }
  if (value.contains('DISPUTE') || value.contains('REPORT')) {
    return (LucideIcons.flag, AppColors.valueAccent);
  }
  if (value.contains('PROMO')) {
    return (LucideIcons.megaphone, AppColors.danger);
  }
  if (value.contains('SECURITY')) {
    return (LucideIcons.shieldCheck, AppColors.primaryBright);
  }
  return (LucideIcons.bell, AppColors.info);
}

String _relativeTime(DateTime value) {
  final difference = DateTime.now().toUtc().difference(value.toUtc());
  if (difference.isNegative || difference.inMinutes < 1) return 'Now';
  if (difference.inMinutes < 60) return '${difference.inMinutes}m ago';
  if (difference.inHours < 24) return '${difference.inHours}h ago';
  if (difference.inDays < 7) return '${difference.inDays}d ago';
  return DateFormat('MMM d').format(value.toLocal());
}

String _detailTime(DateTime value) =>
    DateFormat('MMM d, yyyy • h:mm a').format(value.toLocal());
