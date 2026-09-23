import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../models/match_flow.dart';
import '../providers/match_flow_provider.dart';
import '../theme/colors.dart';
import '../theme/typography.dart';
import '../widgets/flow_widgets.dart';

class OpenMatchDetailsScreen extends ConsumerWidget {
  const OpenMatchDetailsScreen({required this.match, super.key});

  final OpenMatch match;

  @override
  Widget build(BuildContext context, WidgetRef ref) => _LifecycleScaffold(
    title: 'OPEN MATCH',
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('Hosted by ${match.host.name}', style: AppTypography.bodyLarge),
        const SizedBox(height: 14),
        FlowCard(
          child: Row(
            children: [
              GameAvatar(
                avatarId: match.host.avatarId,
                size: 64,
                label: match.host.name,
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(match.host.name, style: AppTypography.heading3),
                    Text(
                      match.host.rank ?? 'Verified player',
                      style: AppTypography.bodySmall.copyWith(
                        color: AppColors.primaryBright,
                      ),
                    ),
                    if (match.host.rating != null)
                      Text(
                        '★ ${match.host.rating}',
                        style: AppTypography.bodySmall,
                      ),
                  ],
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        MatchTermsCard(terms: match.terms),
        const Spacer(),
        PrimaryActionButton(
          label: 'Join match',
          onPressed: match.isStale
              ? null
              : () {
                  ref
                      .read(matchFlowProvider.notifier)
                      .review(
                        MatchFlowIntent(
                          kind: MatchEntryKind.openMatch,
                          terms: match.terms,
                          openMatchId: match.id,
                          opponent: match.host,
                        ),
                      );
                  context.push('/play/confirm');
                },
        ),
      ],
    ),
  );
}

class MatchUnavailableScreen extends StatelessWidget {
  const MatchUnavailableScreen({super.key, this.alreadyFilled = false});

  final bool alreadyFilled;

  @override
  Widget build(BuildContext context) => _StatusScreen(
    icon: LucideIcons.crown,
    iconColor: AppColors.valueAccent,
    title: 'Match unavailable',
    message: alreadyFilled
        ? 'This match was already filled by another player. No stake lock was confirmed.'
        : 'This match is no longer available. The host may have cancelled it.',
    primaryLabel: 'Browse Open Matches',
    onPrimary: () => context.go('/arena'),
    secondaryLabel: 'Try again',
    onSecondary: () => context.go('/arena'),
  );
}

class InsufficientBalanceScreen extends StatelessWidget {
  const InsufficientBalanceScreen({required this.snapshot, super.key});

  final MatchLifecycleSnapshot snapshot;

  @override
  Widget build(BuildContext context) => _BlockingScreen(
    icon: LucideIcons.walletCards,
    illustrationAsset: 'assets/images/match_insufficient_wallet.png',
    illustrationLabel: 'Wallet with coins',
    title: 'Insufficient balance',
    message:
        'You do not have enough verified available balance to join this match.',
    rows: [
      MapEntry(
        'Required stake',
        Money(snapshot.terms.stakeMinorUnits).format(),
      ),
      MapEntry(
        'Available balance',
        snapshot.availableBalanceMinorUnits == null
            ? 'Unavailable'
            : Money(snapshot.availableBalanceMinorUnits!).format(),
      ),
    ],
    primaryLabel: 'Back to Home',
    onPrimary: () => context.go('/home'),
  );
}

class StakeEligibilityBlockedScreen extends StatelessWidget {
  const StakeEligibilityBlockedScreen({required this.snapshot, super.key});

  final MatchLifecycleSnapshot snapshot;

  @override
  Widget build(BuildContext context) => _BlockingScreen(
    icon: LucideIcons.shieldAlert,
    illustrationAsset: 'assets/images/match_stake_limit.png',
    illustrationLabel: 'Protected stake lock',
    title: 'Stake limit',
    message:
        snapshot.reason ??
        'You cannot join this match with your current server limits.',
    rows: [
      MapEntry(
        'Required stake',
        Money(snapshot.terms.stakeMinorUnits).format(),
      ),
      MapEntry(
        'Your limit per match',
        snapshot.limitMinorUnits == null
            ? 'Unavailable'
            : Money(snapshot.limitMinorUnits!).format(),
      ),
    ],
    primaryLabel: 'Browse Arena',
    onPrimary: () => context.go('/arena'),
  );
}

class LockingStakeScreen extends StatelessWidget {
  const LockingStakeScreen({required this.snapshot, super.key});

  final MatchLifecycleSnapshot snapshot;

  @override
  Widget build(BuildContext context) => _LifecycleScaffold(
    title: 'LOCKING STAKE',
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Spacer(),
        const Icon(
          LucideIcons.lockKeyhole,
          size: 72,
          color: AppColors.primaryBright,
        ),
        const SizedBox(height: 20),
        Text(
          'Locking Stake',
          textAlign: TextAlign.center,
          style: AppTypography.heading2,
        ),
        const SizedBox(height: 8),
        Text(
          'Please wait while the server secures your stake.',
          textAlign: TextAlign.center,
          style: AppTypography.bodyLarge,
        ),
        const SizedBox(height: 28),
        const LinearProgressIndicator(minHeight: 7),
        const SizedBox(height: 18),
        MatchTermsCard(terms: snapshot.terms),
        const Spacer(),
        Text(
          'Do not close this screen. A timeout does not mean the request failed.',
          textAlign: TextAlign.center,
          style: AppTypography.bodySmall,
        ),
      ],
    ),
  );
}

class WaitingOpponentStakeScreen extends StatelessWidget {
  const WaitingOpponentStakeScreen({required this.snapshot, super.key});

  final MatchLifecycleSnapshot snapshot;

  @override
  Widget build(BuildContext context) => _PlayersStatusScreen(
    snapshot: snapshot,
    title: 'WAITING FOR OPPONENT',
    message: 'Waiting for your opponent to lock their stake.',
    playerStatus: 'Locked',
    opponentStatus: 'Waiting…',
  );
}

class ReadyCheckScreen extends StatefulWidget {
  const ReadyCheckScreen({required this.snapshot, super.key, this.onReady});

  final MatchLifecycleSnapshot snapshot;
  final Future<void> Function()? onReady;

  @override
  State<ReadyCheckScreen> createState() => _ReadyCheckScreenState();
}

class _ReadyCheckScreenState extends State<ReadyCheckScreen> {
  bool _submitting = false;

  Future<void> _ready() async {
    if (_submitting || widget.onReady == null) return;
    setState(() => _submitting = true);
    try {
      await widget.onReady!();
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) => _PlayersStatusScreen(
    snapshot: widget.snapshot,
    title: 'READY CHECK',
    message: 'Both stakes are confirmed. Get ready.',
    playerStatus: widget.snapshot.playerReady == AuthoritativeProgress.confirmed
        ? 'Ready'
        : 'Not ready',
    opponentStatus:
        widget.snapshot.opponentReady == AuthoritativeProgress.confirmed
        ? 'Ready'
        : 'Waiting…',
    action: PrimaryActionButton(
      label: _submitting ? 'Confirming readiness' : 'I am ready',
      loading: _submitting,
      onPressed: widget.onReady == null ? null : _ready,
    ),
  );
}

class WaitingOpponentReadyScreen extends StatelessWidget {
  const WaitingOpponentReadyScreen({required this.snapshot, super.key});

  final MatchLifecycleSnapshot snapshot;

  @override
  Widget build(BuildContext context) => _PlayersStatusScreen(
    snapshot: snapshot,
    title: 'WAITING FOR OPPONENT',
    message: 'You are ready. Waiting for the server to confirm your opponent.',
    playerStatus: 'Ready',
    opponentStatus: 'Waiting…',
    action: SecondaryActionButton(
      label: 'Leave room',
      onPressed: () => context.go('/home'),
    ),
  );
}

class ReadyTimeoutScreen extends StatelessWidget {
  const ReadyTimeoutScreen({required this.snapshot, super.key});

  final MatchLifecycleSnapshot snapshot;

  @override
  Widget build(BuildContext context) {
    final releaseConfirmed =
        snapshot.release == AuthoritativeProgress.confirmed;
    return _StatusScreen(
      icon: LucideIcons.timerOff,
      iconColor: AppColors.danger,
      title: 'Ready timeout',
      message: releaseConfirmed
          ? 'The match was cancelled. The server confirmed your stake release.'
          : 'The match was cancelled. Stake release is still processing; your balance has not been changed locally.',
      primaryLabel: 'Back to Home',
      onPrimary: () => context.go('/home'),
      secondaryLabel: 'Browse Open Matches',
      onSecondary: () => context.go('/arena'),
    );
  }
}

class OpponentDisconnectedBeforeStartScreen extends StatelessWidget {
  const OpponentDisconnectedBeforeStartScreen({
    required this.snapshot,
    super.key,
  });

  final MatchLifecycleSnapshot snapshot;

  @override
  Widget build(BuildContext context) => _StatusScreen(
    icon: LucideIcons.wifiOff,
    iconColor: AppColors.danger,
    illustrationAsset: 'assets/images/match_opponent_disconnected.png',
    illustrationLabel: 'Disconnected opponent',
    title: 'Opponent disconnected',
    message: snapshot.release == AuthoritativeProgress.confirmed
        ? 'The match did not start. The server confirmed that locked funds were released.'
        : 'The match did not start. Fund release is awaiting server confirmation.',
    primaryLabel: 'Continue',
    onPrimary: () => context.go('/home'),
  );
}

class PrivateRoomCodeScreen extends StatelessWidget {
  const PrivateRoomCodeScreen({required this.snapshot, super.key});

  final MatchLifecycleSnapshot snapshot;

  @override
  Widget build(BuildContext context) => _LifecycleScaffold(
    title: 'PRIVATE ROOM',
    child: Column(
      children: [
        const Spacer(),
        const Icon(
          LucideIcons.keyRound,
          size: 64,
          color: AppColors.valueAccent,
        ),
        const SizedBox(height: 18),
        Text('Share this room code', style: AppTypography.heading2),
        const SizedBox(height: 18),
        FlowCard(
          child: Text(
            snapshot.roomCode ?? 'Awaiting server code',
            textAlign: TextAlign.center,
            style: AppTypography.heading1.copyWith(letterSpacing: 5),
          ),
        ),
        const SizedBox(height: 12),
        Text(
          'Only the server can create or validate a private room.',
          textAlign: TextAlign.center,
          style: AppTypography.bodySmall,
        ),
        const Spacer(),
        SecondaryActionButton(
          label: 'Back to Home',
          onPressed: () => context.go('/home'),
        ),
      ],
    ),
  );
}

class ChallengeStatusScreen extends StatefulWidget {
  const ChallengeStatusScreen({
    required this.snapshot,
    super.key,
    this.onAccept,
    this.onDecline,
  });

  final MatchLifecycleSnapshot snapshot;
  final Future<void> Function()? onAccept;
  final Future<void> Function()? onDecline;

  @override
  State<ChallengeStatusScreen> createState() => _ChallengeStatusScreenState();
}

class _ChallengeStatusScreenState extends State<ChallengeStatusScreen> {
  bool _submitting = false;

  Future<void> _run(Future<void> Function()? action) async {
    if (_submitting || action == null) return;
    setState(() => _submitting = true);
    try {
      await action();
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final phase = widget.snapshot.phase;
    final expired = phase == MatchLifecyclePhase.challengeExpired;
    final incoming = phase == MatchLifecyclePhase.incomingChallenge;
    return _LifecycleScaffold(
      title: expired
          ? 'CHALLENGE EXPIRED'
          : incoming
          ? 'INCOMING CHALLENGE'
          : 'CHALLENGE SENT',
      child: Column(
        children: [
          const Spacer(),
          GameAvatar(
            avatarId: widget.snapshot.opponent?.avatarId ?? 'avatar_04',
            size: 84,
            label: widget.snapshot.opponent?.name ?? 'Opponent',
          ),
          const SizedBox(height: 14),
          Text(
            widget.snapshot.opponent?.name ?? 'Opponent',
            style: AppTypography.heading2,
          ),
          const SizedBox(height: 8),
          Text(
            expired
                ? 'This challenge is no longer available. No stake lock was confirmed.'
                : incoming
                ? 'has challenged you to a match.'
                : 'Waiting for the other player to respond.',
            textAlign: TextAlign.center,
            style: AppTypography.bodyLarge,
          ),
          const SizedBox(height: 18),
          MatchTermsCard(terms: widget.snapshot.terms),
          const Spacer(),
          if (expired)
            PrimaryActionButton(
              label: 'Back to Arena',
              onPressed: () => context.go('/arena'),
            )
          else if (incoming) ...[
            PrimaryActionButton(
              label: 'Accept',
              loading: _submitting,
              onPressed: widget.onAccept == null
                  ? null
                  : () => _run(widget.onAccept),
            ),
            const SizedBox(height: 8),
            SecondaryActionButton(
              label: 'Decline',
              onPressed: widget.onDecline == null
                  ? null
                  : () => _run(widget.onDecline),
            ),
          ] else
            SecondaryActionButton(
              label: 'Cancel challenge',
              loading: _submitting,
              onPressed: widget.onDecline == null
                  ? null
                  : () => _run(widget.onDecline),
            ),
        ],
      ),
    );
  }
}

class _LifecycleScaffold extends StatelessWidget {
  const _LifecycleScaffold({required this.title, required this.child});

  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: AppColors.background,
    appBar: AppBar(title: Text(title), centerTitle: true),
    body: SafeArea(
      top: false,
      child: FlowPage(scrollable: false, child: child),
    ),
  );
}

class _StatusScreen extends StatelessWidget {
  const _StatusScreen({
    required this.icon,
    required this.iconColor,
    required this.title,
    required this.message,
    required this.primaryLabel,
    required this.onPrimary,
    this.secondaryLabel,
    this.onSecondary,
    this.illustrationAsset,
    this.illustrationLabel,
  });

  final IconData icon;
  final Color iconColor;
  final String title;
  final String message;
  final String primaryLabel;
  final VoidCallback onPrimary;
  final String? secondaryLabel;
  final VoidCallback? onSecondary;
  final String? illustrationAsset;
  final String? illustrationLabel;

  @override
  Widget build(BuildContext context) => _LifecycleScaffold(
    title: '',
    child: Column(
      children: [
        const Spacer(),
        if (illustrationAsset == null)
          Icon(icon, size: 82, color: iconColor)
        else
          Semantics(
            label: illustrationLabel,
            image: true,
            child: Image.asset(
              illustrationAsset!,
              height: 154,
              fit: BoxFit.contain,
              excludeFromSemantics: true,
            ),
          ),
        const SizedBox(height: 20),
        Text(
          title.toUpperCase(),
          textAlign: TextAlign.center,
          style: AppTypography.heading2,
        ),
        const SizedBox(height: 10),
        Text(
          message,
          textAlign: TextAlign.center,
          style: AppTypography.bodyLarge,
        ),
        const Spacer(),
        PrimaryActionButton(label: primaryLabel, onPressed: onPrimary),
        if (secondaryLabel != null) ...[
          const SizedBox(height: 8),
          SecondaryActionButton(label: secondaryLabel!, onPressed: onSecondary),
        ],
      ],
    ),
  );
}

class _BlockingScreen extends StatelessWidget {
  const _BlockingScreen({
    required this.icon,
    required this.title,
    required this.message,
    required this.rows,
    required this.primaryLabel,
    required this.onPrimary,
    this.illustrationAsset,
    this.illustrationLabel,
  });

  final IconData icon;
  final String title;
  final String message;
  final List<MapEntry<String, String>> rows;
  final String primaryLabel;
  final VoidCallback onPrimary;
  final String? illustrationAsset;
  final String? illustrationLabel;

  @override
  Widget build(BuildContext context) => _LifecycleScaffold(
    title: '',
    child: Column(
      children: [
        const Spacer(),
        if (illustrationAsset == null)
          Icon(icon, size: 72, color: AppColors.danger)
        else
          Semantics(
            label: illustrationLabel,
            image: true,
            child: Image.asset(
              illustrationAsset!,
              height: 138,
              fit: BoxFit.contain,
              excludeFromSemantics: true,
            ),
          ),
        const SizedBox(height: 18),
        Text(title.toUpperCase(), style: AppTypography.heading2),
        const SizedBox(height: 8),
        Text(
          message,
          textAlign: TextAlign.center,
          style: AppTypography.bodyLarge,
        ),
        const SizedBox(height: 20),
        FlowCard(
          child: Column(
            children: rows
                .map(
                  (row) => Padding(
                    padding: const EdgeInsets.symmetric(vertical: 8),
                    child: Row(
                      children: [
                        Expanded(
                          child: Text(row.key, style: AppTypography.bodySmall),
                        ),
                        Text(row.value, style: AppTypography.labelBold),
                      ],
                    ),
                  ),
                )
                .toList(),
          ),
        ),
        const Spacer(),
        PrimaryActionButton(label: primaryLabel, onPressed: onPrimary),
      ],
    ),
  );
}

class _PlayersStatusScreen extends StatelessWidget {
  const _PlayersStatusScreen({
    required this.snapshot,
    required this.title,
    required this.message,
    required this.playerStatus,
    required this.opponentStatus,
    this.action,
  });

  final MatchLifecycleSnapshot snapshot;
  final String title;
  final String message;
  final String playerStatus;
  final String opponentStatus;
  final Widget? action;

  @override
  Widget build(BuildContext context) => _LifecycleScaffold(
    title: snapshot.matchId == null ? title : 'MATCH #${snapshot.matchId}',
    child: Column(
      children: [
        const Spacer(),
        Text(title, textAlign: TextAlign.center, style: AppTypography.heading2),
        const SizedBox(height: 8),
        Text(
          message,
          textAlign: TextAlign.center,
          style: AppTypography.bodyLarge,
        ),
        const SizedBox(height: 26),
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceAround,
          children: [
            _PlayerState(
              name: 'You',
              avatarId: 'avatar_01',
              status: playerStatus,
            ),
            Text(
              'VS',
              style: AppTypography.heading2.copyWith(
                color: AppColors.valueAccent,
              ),
            ),
            _PlayerState(
              name: snapshot.opponent?.name ?? 'Opponent',
              avatarId: snapshot.opponent?.avatarId ?? 'avatar_04',
              status: opponentStatus,
            ),
          ],
        ),
        const SizedBox(height: 24),
        MatchTermsCard(terms: snapshot.terms),
        const Spacer(),
        ?action,
      ],
    ),
  );
}

class _PlayerState extends StatelessWidget {
  const _PlayerState({
    required this.name,
    required this.avatarId,
    required this.status,
  });

  final String name;
  final String avatarId;
  final String status;

  @override
  Widget build(BuildContext context) => SizedBox(
    width: 110,
    child: Column(
      children: [
        GameAvatar(avatarId: avatarId, size: 68, label: name),
        const SizedBox(height: 8),
        Text(name, maxLines: 1, overflow: TextOverflow.ellipsis),
        Text(
          status,
          style: AppTypography.bodySmall.copyWith(
            color: status == 'Ready' || status == 'Locked'
                ? AppColors.primaryBright
                : AppColors.textSecondary,
          ),
        ),
      ],
    ),
  );
}
