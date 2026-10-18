import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../providers/match_flow_provider.dart';
import '../providers/match_provider.dart';
import '../router/lifecycle_routes.dart';
import '../theme/colors.dart';

/// Prompts for a private-room code and seats the caller against its listing.
///
/// Shared by the Home lobby's "Join with code" action and the Arena FAB so both
/// entry points validate the code, surface failures and route to the correct
/// lifecycle screen identically.
Future<void> showJoinWithCodeDialog(
  BuildContext context,
  WidgetRef ref,
) async {
  final controller = TextEditingController();
  final code = await showDialog<String>(
    context: context,
    builder: (dialogContext) => AlertDialog(
      backgroundColor: AppColors.surface,
      title: const Text('Join a private room'),
      content: TextField(
        controller: controller,
        autofocus: true,
        textCapitalization: TextCapitalization.characters,
        textInputAction: TextInputAction.done,
        decoration: const InputDecoration(hintText: 'Room code'),
        onSubmitted: (value) => Navigator.of(dialogContext).pop(value),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(dialogContext).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () => Navigator.of(dialogContext).pop(controller.text),
          child: const Text('Join'),
        ),
      ],
    ),
  );
  controller.dispose();
  if (!context.mounted || code == null || code.trim().isEmpty) return;
  final notifier = ref.read(matchFlowProvider.notifier);
  final snapshot = await notifier.joinPrivateRoom(code.trim());
  if (!context.mounted) return;
  if (snapshot == null) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          ref.read(matchFlowProvider).message ??
              'That room code could not be found.',
        ),
      ),
    );
    return;
  }
  final route = lifecyclePhaseRoute(snapshot);
  if (isBoardRoute(route)) {
    ref.read(matchProvider.notifier).joinMatch(snapshot.matchId!);
    context.go(route);
    return;
  }
  context.go(route, extra: snapshot);
}
