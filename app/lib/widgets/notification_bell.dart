import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../providers/notification_provider.dart';
import '../theme/colors.dart';
import 'package:intl/intl.dart';

class NotificationBell extends ConsumerWidget {
  const NotificationBell({Key? key}) : super(key: key);

  void _showNotificationPanel(BuildContext context, WidgetRef ref, NotificationState state) {
    showModalBottomSheet(
      context: context,
      backgroundColor: AppColors.surface1,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (context) {
        return _NotificationPanel(state: state);
      },
    );
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(notificationProvider);

    return Stack(
      children: [
        IconButton(
          icon: const Icon(LucideIcons.bell, color: AppColors.textMain),
          onPressed: () => _showNotificationPanel(context, ref, state),
        ),
        if (state.unreadCount > 0)
          Positioned(
            right: 8,
            top: 8,
            child: Container(
              padding: const EdgeInsets.all(2),
              decoration: BoxDecoration(
                color: Colors.red,
                borderRadius: BorderRadius.circular(10),
              ),
              constraints: const BoxConstraints(
                minWidth: 16,
                minHeight: 16,
              ),
              child: Text(
                '${state.unreadCount > 9 ? '9+' : state.unreadCount}',
                style: const TextStyle(
                  color: Colors.white,
                  fontSize: 10,
                  fontWeight: FontWeight.bold,
                ),
                textAlign: TextAlign.center,
              ),
            ),
          ),
      ],
    );
  }
}

class _NotificationPanel extends ConsumerWidget {
  final NotificationState state;

  const _NotificationPanel({required this.state});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.all(16.0),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Text(
                'Notifications',
                style: TextStyle(
                  color: AppColors.textMain,
                  fontSize: 18,
                  fontWeight: FontWeight.bold,
                ),
              ),
              if (state.unreadCount > 0)
                TextButton(
                  onPressed: () {
                    ref.read(notificationProvider.notifier).markAllAsRead();
                  },
                  child: const Text('Mark all as read'),
                ),
            ],
          ),
        ),
        const Divider(color: AppColors.borderDim),
        Expanded(
          child: state.isLoading
              ? const Center(child: CircularProgressIndicator())
              : state.notifications.isEmpty
                  ? const Center(
                      child: Text(
                        'No notifications yet.',
                        style: TextStyle(color: AppColors.textMuted),
                      ),
                    )
                  : ListView.builder(
                      itemCount: state.notifications.length,
                      itemBuilder: (context, index) {
                        final notification = state.notifications[index];
                        return ListTile(
                          title: Text(
                            notification.title,
                            style: TextStyle(
                              color: notification.isRead
                                  ? AppColors.textMuted
                                  : AppColors.textMain,
                              fontWeight: notification.isRead
                                  ? FontWeight.normal
                                  : FontWeight.bold,
                            ),
                          ),
                          subtitle: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                notification.message,
                                style: const TextStyle(color: AppColors.textMuted),
                              ),
                              const SizedBox(height: 4),
                              Text(
                                DateFormat('MMM d, h:mm a').format(notification.createdAt.toLocal()),
                                style: const TextStyle(color: AppColors.textMuted, fontSize: 12),
                              ),
                            ],
                          ),
                          onTap: () {
                            if (!notification.isRead) {
                              ref.read(notificationProvider.notifier).markAsRead(notification.id);
                            }
                            if (notification.link != null && notification.link!.isNotEmpty) {
                              Navigator.pop(context); // Close panel
                              context.go(notification.link!);
                            }
                          },
                        );
                      },
                    ),
        ),
      ],
    );
  }
}
