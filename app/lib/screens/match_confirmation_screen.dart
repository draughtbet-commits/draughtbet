import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../models/match_flow.dart';
import '../providers/match_flow_provider.dart';
import '../providers/profile_provider.dart';
import '../theme/colors.dart';
import '../widgets/flow_widgets.dart';

class MatchConfirmationScreen extends ConsumerWidget {
  const MatchConfirmationScreen({super.key});

  Future<void> _confirm(BuildContext context, WidgetRef ref) async {
    final id = await ref.read(matchFlowProvider.notifier).confirm();
    if (!context.mounted) return;
    final state = ref.read(matchFlowProvider);
    if (state.actionPhase != MatchActionPhase.succeeded) return;
    final intent = state.currentIntent;
    if (intent?.kind == MatchEntryKind.openMatch && id != null) {
      context.go('/play/room/$id');
    } else {
      context.go('/play/search');
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final flow = ref.watch(matchFlowProvider);
    final profile = ref.watch(profileProvider).profile;
    final intent = flow.currentIntent;
    if (intent == null) {
      return Scaffold(
        body: RecoverableState(
          title: 'Match terms unavailable',
          message: 'Return to the Arena and choose a match again.',
          actionLabel: 'Back to Arena',
          onAction: () => context.go('/arena'),
        ),
      );
    }
    final opponent = intent.opponent;
    final pending = flow.actionPhase == MatchActionPhase.submitting;
    final createsListing = intent.kind == MatchEntryKind.created;

    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        leading: IconButton(
          tooltip: 'Back',
          onPressed: pending ? null : () => context.pop(),
          icon: const Icon(Icons.arrow_back_ios_new_rounded, size: 19),
        ),
        title: const Text('Match Confirmation'),
      ),
      body: SafeArea(
        child: FlowPage(
          child: Column(
            children: [
              const SizedBox(height: 4),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceAround,
                children: [
                  _PlayerIdentity(
                    player: MatchPlayer(
                      id: profile?.id ?? 'self',
                      name: profile?.displayName ?? 'You',
                      avatarId: profile?.avatar ?? 'avatar_01',
                      rank: profile?.tier,
                    ),
                    label: 'YOU',
                    accent: AppColors.primaryBright,
                  ),
                  Text(
                    'VS',
                    style: TextStyle(
                      fontFamily: 'Sora',
                      color: AppColors.valueAccent,
                      fontSize: 18,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  _PlayerIdentity(
                    player:
                        opponent ??
                        const MatchPlayer(id: '', name: 'Open Opponent'),
                    label: opponent?.name ?? 'OPEN',
                    accent: AppColors.valueAccent,
                    placeholder: opponent == null,
                  ),
                ],
              ),
              const SizedBox(height: 22),
              MatchTermsCard(terms: intent.terms),
              const SizedBox(height: 12),
              FlowCard(
                color: AppColors.primaryAction.withValues(alpha: .08),
                borderColor: AppColors.primaryAction.withValues(alpha: .38),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Icon(
                      LucideIcons.shieldCheck,
                      color: AppColors.primaryBright,
                      size: 20,
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        intent.terms.serverQuoted
                            ? 'These terms came from the server. Confirm once to reserve your stake.'
                            : createsListing
                            ? 'Your stake is locked only after an opponent accepts under the current server contract.'
                            : 'The server confirms the final fee and payout while accepting this match.',
                        style: TextStyle(
                          fontFamily: 'Inter',
                          color: AppColors.textSecondary,
                          fontSize: 11,
                          height: 1.4,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              if (flow.message != null) ...[
                const SizedBox(height: 10),
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
              const SizedBox(height: 16),
              PrimaryActionButton(
                label: createsListing
                    ? 'Confirm & Create Match'
                    : 'Confirm & Lock Stake',
                icon: LucideIcons.lockKeyhole,
                loading: pending,
                onPressed: () => _confirm(context, ref),
              ),
              const SizedBox(height: 10),
              Text(
                'A pending request cannot be submitted twice.',
                style: TextStyle(
                  fontFamily: 'Inter',
                  color: AppColors.textSecondary,
                  fontSize: 10,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PlayerIdentity extends StatelessWidget {
  const _PlayerIdentity({
    required this.player,
    required this.label,
    required this.accent,
    this.placeholder = false,
  });

  final MatchPlayer player;
  final String label;
  final Color accent;
  final bool placeholder;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 112,
      child: Column(
        children: [
          if (placeholder)
            Container(
              width: 66,
              height: 66,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: AppColors.surfaceRaised,
                border: Border.all(color: accent, width: 2),
              ),
              child: const Icon(
                LucideIcons.userRound,
                color: AppColors.textSecondary,
              ),
            )
          else
            GameAvatar(
              avatarId: player.avatarId,
              size: 66,
              accent: accent,
              label: player.name,
            ),
          const SizedBox(height: 8),
          Text(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontFamily: 'Sora',
              fontSize: 12,
              fontWeight: FontWeight.w700,
            ),
          ),
          if (player.rank != null) ...[
            const SizedBox(height: 3),
            Text(
              player.rank!,
              style: TextStyle(
                fontFamily: 'Inter',
                color: accent,
                fontSize: 10,
              ),
            ),
          ],
          if (player.rating != null)
            Text(
              '★ ${player.rating}',
              style: TextStyle(
                fontFamily: 'Inter',
                color: AppColors.valueAccent,
                fontSize: 10,
              ),
            ),
        ],
      ),
    );
  }
}
