import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../providers/eligibility_provider.dart';
import '../services/socket_service.dart';
import '../theme/colors.dart';

/// Dismissible account-restriction banner.
///
/// A ban blocks money and play but never sign-in, so this is deliberately not a
/// blocking interstitial: the player can dismiss it and keep navigating, reach
/// support, and still read their balance. Dismissal is per session rather than
/// permanent so a lift of the ban re-surfaces the banner without a re-login.
class RestrictedBanner extends ConsumerStatefulWidget {
  const RestrictedBanner({super.key});

  @override
  ConsumerState<RestrictedBanner> createState() => _RestrictedBannerState();
}

class _RestrictedBannerState extends ConsumerState<RestrictedBanner> {
  bool _dismissed = false;
  bool _requested = false;
  StreamSubscription<bool>? _statusSub;
  StreamSubscription<SocketConnectionPhase>? _phaseSub;

  @override
  void initState() {
    super.initState();
    // The shell is mounted on every tab, but most routes never load the
    // eligibility provider themselves. Without this the banner would sit
    // hidden on Home/Wallet/Play and only appear once the player happened to
    // open a settings screen.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _requested) return;
      final phase = ref.read(eligibilityProvider).phase;
      if (phase == EligibilityLoadPhase.initial ||
          phase == EligibilityLoadPhase.error) {
        _requested = true;
        ref.read(eligibilityProvider.notifier).refreshCanonical();
      }
    });

    // A suspension or reinstatement is pushed by the admin action itself, so
    // the banner appears and clears while the app is open. Without this the
    // player keeps staring at a stale banner until they restart the app.
    _statusSub = socketService.onAccountStatus.listen(_onAccountStatus);

    // A suspension severs the account's sockets and the handshake refuses a
    // banned user, so the client cannot reconnect until the ban is lifted and
    // the push below would have nowhere to land. Re-reading the server on every
    // (re)connect is what actually clears the banner in that sequence.
    _phaseSub = socketService.onConnectionPhase.listen((phase) {
      if (phase == SocketConnectionPhase.connected) {
        ref.read(eligibilityProvider.notifier).refreshCanonical();
      }
    });
  }

  void _onAccountStatus(bool isBanned) {
    if (!mounted) return;
    ref.read(eligibilityProvider.notifier).applyPushedAccountStatus(isBanned);
    if (!isBanned && _dismissed) {
      // Lift the ban: drop the dismissed flag so a later suspension is
      // announced again rather than arriving silently.
      setState(() => _dismissed = false);
    }
  }

  @override
  void dispose() {
    _statusSub?.cancel();
    _phaseSub?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(eligibilityProvider);
    final isBanned = state.verification?.isBanned ?? false;
    if (!isBanned || _dismissed) return const SizedBox.shrink();

    return Material(
      color: AppColors.danger.withValues(alpha: 0.12),
      // One merged, explicitly labelled node: without this the banner renders
      // but never reaches the accessibility tree, so a screen-reader user is
      // never told the account is restricted.
      child: MergeSemantics(
        child: Semantics(
          container: true,
          liveRegion: true,
          label:
              'Account restricted. Deposits, withdrawals and play are paused. '
              'Tap for details.',
          child: ExcludeSemantics(
            // The app is edge-to-edge and this device reports a 136px display
            // cutout, so the banner must consume the top inset itself.
            child: SafeArea(
              bottom: false,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 10, 8, 10),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Icon(
                      LucideIcons.shieldAlert,
                      color: AppColors.danger,
                      size: 18,
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: GestureDetector(
                        onTap: () => context.go(
                          '/profile/settings/account-restricted',
                        ),
                        child: const Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              'Account restricted',
                              style: TextStyle(
                                color: AppColors.danger,
                                fontWeight: FontWeight.w600,
                                fontSize: 12,
                              ),
                            ),
                            SizedBox(height: 2),
                            Text(
                              'Deposits, withdrawals and play are paused. '
                              'Tap for details.',
                              style: TextStyle(
                                color: AppColors.textSecondary,
                                fontSize: 12,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                    IconButton(
                      tooltip: 'Dismiss',
                      icon: const Icon(
                        LucideIcons.x,
                        size: 16,
                        color: AppColors.textSecondary,
                      ),
                      onPressed: () => setState(() => _dismissed = true),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}