import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../models/match_flow.dart';
import '../providers/match_flow_provider.dart';
import '../providers/match_provider.dart';
import '../providers/profile_provider.dart';
import '../theme/colors.dart';
import '../widgets/flow_widgets.dart';

class MatchmakingScreen extends ConsumerStatefulWidget {
  const MatchmakingScreen({super.key});

  @override
  ConsumerState<MatchmakingScreen> createState() => _MatchmakingScreenState();
}

class _MatchmakingScreenState extends ConsumerState<MatchmakingScreen> {
  Timer? _ticker;
  int _dot = 0;

  @override
  void initState() {
    super.initState();
    _ticker = Timer.periodic(const Duration(milliseconds: 420), (_) {
      if (mounted) setState(() => _dot = (_dot + 1) % 3);
    });
  }

  @override
  void dispose() {
    _ticker?.cancel();
    super.dispose();
  }

  Future<void> _cancel() async {
    final ok = await ref.read(matchFlowProvider.notifier).cancelSearch();
    if (mounted && ok) context.go('/home');
  }

  Future<void> _retrySearch() async {
    ref.read(matchFlowProvider.notifier).resetAction();
    await ref.read(matchFlowProvider.notifier).confirm();
  }

  @override
  Widget build(BuildContext context) {
    final flow = ref.watch(matchFlowProvider);
    final profile = ref.watch(profileProvider).profile;
    final intent = flow.currentIntent;
    final found =
        flow.searchPhase == SearchPhase.found || flow.currentMatchId != null;
    final pendingCancel = flow.searchPhase == SearchPhase.cancelling;
    final timedOut = flow.searchPhase == SearchPhase.timeout;
    final degraded = flow.searchPhase == SearchPhase.degraded;
    final cancelled = flow.searchPhase == SearchPhase.cancelled;
    final title = found
        ? 'Opponent found'
        : timedOut
        ? 'No opponent found'
        : degraded
        ? 'Connection needs attention'
        : cancelled
        ? 'Search cancelled'
        : 'Finding your opponent...';
    final subtitle = found
        ? 'Review the room before the match starts.'
        : timedOut
        ? 'No eligible player joined this search. You can safely try again.'
        : degraded
        ? 'The server has not confirmed cancellation yet.'
        : cancelled
        ? 'Your cancellation was confirmed by the server.'
        : intent?.kind == MatchEntryKind.created
        ? 'Your match is open for an eligible opponent.'
        : 'This won’t take long.';

    ref.listen(matchProvider, (previous, next) {
      final id = next.currentMatchId;
      if (id != null && previous?.currentMatchId != id) {
        ref.read(matchFlowProvider.notifier).matchFound(id);
      }
    });

    if (intent == null) {
      return Scaffold(
        body: RecoverableState(
          title: 'Search details unavailable',
          message: 'Choose a quick match or create a match first.',
          actionLabel: 'Back to Home',
          onAction: () => context.go('/home'),
        ),
      );
    }

    final canCancel = intent.kind == MatchEntryKind.quick;
    final compact = MediaQuery.sizeOf(context).height < 700;
    return PopScope(
      canPop: found,
      child: Scaffold(
        backgroundColor: AppColors.background,
        body: SafeArea(
          child: FlowPage(
            scrollable: compact,
            child: Column(
              children: [
                if (compact) const SizedBox(height: 8) else const Spacer(),
                if (timedOut || degraded || cancelled) ...[
                  Icon(
                    timedOut
                        ? LucideIcons.searchX
                        : degraded
                        ? LucideIcons.wifiOff
                        : LucideIcons.circleCheck,
                    color: timedOut || degraded
                        ? AppColors.valueAccent
                        : AppColors.primaryBright,
                    size: 38,
                  ),
                  const SizedBox(height: 14),
                ],
                Text(
                  title,
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    fontFamily: 'Sora',
                    fontSize: 21,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                  subtitle,
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    fontFamily: 'Inter',
                    color: AppColors.textSecondary,
                    fontSize: 12,
                  ),
                ),
                SizedBox(height: compact ? 18 : 42),
                Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    GameAvatar(
                      avatarId: profile?.avatar ?? 'avatar_01',
                      size: compact ? 58 : 74,
                      label: profile?.displayName ?? 'You',
                    ),
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 20),
                      child: Row(
                        children: List.generate(3, (index) {
                          final active = found || index == _dot;
                          return AnimatedContainer(
                            duration: const Duration(milliseconds: 180),
                            width: active ? 9 : 6,
                            height: active ? 9 : 6,
                            margin: const EdgeInsets.symmetric(horizontal: 4),
                            decoration: BoxDecoration(
                              shape: BoxShape.circle,
                              color: active
                                  ? AppColors.primaryBright
                                  : AppColors.border,
                            ),
                          );
                        }),
                      ),
                    ),
                    AnimatedSwitcher(
                      duration: const Duration(milliseconds: 300),
                      child: found
                          ? GameAvatar(
                              key: const ValueKey('found'),
                              avatarId:
                                  intent.opponent?.avatarId ?? 'avatar_04',
                              size: compact ? 58 : 74,
                              accent: AppColors.valueAccent,
                              label: intent.opponent?.name ?? 'Opponent',
                            )
                          : Container(
                              key: const ValueKey('waiting'),
                              width: compact ? 58 : 74,
                              height: compact ? 58 : 74,
                              decoration: BoxDecoration(
                                shape: BoxShape.circle,
                                color: AppColors.surfaceRaised,
                                border: Border.all(
                                  color: AppColors.textSecondary,
                                ),
                              ),
                              child: const Icon(
                                LucideIcons.userRound,
                                color: AppColors.textSecondary,
                                size: 34,
                              ),
                            ),
                    ),
                  ],
                ),
                SizedBox(height: compact ? 18 : 44),
                MatchTermsCard(terms: intent.terms),
                if (flow.message != null) ...[
                  const SizedBox(height: 12),
                  Text(
                    flow.message!,
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontFamily: 'Inter',
                      color: AppColors.danger,
                      fontSize: 12,
                    ),
                  ),
                ],
                if (compact) const SizedBox(height: 12) else const Spacer(),
                if (found)
                  PrimaryActionButton(
                    label: 'Continue to Match Room',
                    onPressed: flow.currentMatchId == null
                        ? null
                        : () => context.go('/play/room/${flow.currentMatchId}'),
                  )
                else if (timedOut)
                  Column(
                    children: [
                      PrimaryActionButton(
                        label: 'Try Again',
                        icon: LucideIcons.refreshCw,
                        onPressed: _retrySearch,
                      ),
                      const SizedBox(height: 8),
                      SecondaryActionButton(
                        label: 'Back to Home',
                        onPressed: () => context.go('/home'),
                      ),
                    ],
                  )
                else if (degraded)
                  SecondaryActionButton(
                    label: 'Retry cancellation',
                    icon: LucideIcons.refreshCw,
                    onPressed: _cancel,
                  )
                else if (cancelled)
                  PrimaryActionButton(
                    label: 'Back to Home',
                    onPressed: () => context.go('/home'),
                  )
                else if (canCancel)
                  SecondaryActionButton(
                    label: pendingCancel
                        ? 'Cancelling Search'
                        : 'Cancel Search',
                    loading: pendingCancel,
                    onPressed: _cancel,
                  )
                else
                  SecondaryActionButton(
                    label: 'Return Home (match stays open)',
                    onPressed: () => context.go('/home'),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
