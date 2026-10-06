import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../models/dispute.dart';
import '../providers/dispute_provider.dart';
import '../theme/colors.dart';
import '../theme/typography.dart';
import '../widgets/flow_widgets.dart';

class ReportMatchScreen extends ConsumerStatefulWidget {
  const ReportMatchScreen({this.match, super.key});

  final DisputeMatchSummary? match;

  @override
  ConsumerState<ReportMatchScreen> createState() => _ReportMatchScreenState();
}

class _ReportMatchScreenState extends ConsumerState<ReportMatchScreen> {
  bool _requestDispute = false;

  @override
  void initState() {
    super.initState();
    if (widget.match != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) ref.read(disputeProvider.notifier).start(widget.match!);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final match = widget.match ?? ref.watch(disputeProvider).match;
    return _DisputeScaffold(
      title: 'REPORT MATCH',
      child: match == null
          ? const _MissingMatchState()
          : Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  'Report or dispute a match result if you believe something went wrong.',
                  style: AppTypography.bodyLarge,
                ),
                const SizedBox(height: 18),
                _MatchSummaryCard(match: match),
                const SizedBox(height: 22),
                Text(
                  'What would you like to do?',
                  style: AppTypography.heading3,
                ),
                const SizedBox(height: 10),
                _ChoiceCard(
                  selected: !_requestDispute,
                  title: 'Report match',
                  subtitle:
                      'Report inappropriate behaviour, cheating or unfair play.',
                  onTap: () => setState(() => _requestDispute = false),
                ),
                const SizedBox(height: 10),
                _ChoiceCard(
                  selected: _requestDispute,
                  title: 'Request a dispute',
                  subtitle:
                      'Ask support to review the server-recorded match result.',
                  onTap: () => setState(() => _requestDispute = true),
                ),
                const SizedBox(height: 26),
                PrimaryActionButton(
                  label: _requestDispute ? 'Continue to dispute' : 'Continue',
                  icon: LucideIcons.flag,
                  onPressed: () => context.push('/profile/dispute-reason'),
                ),
                const SizedBox(height: 8),
                TextButton(
                  onPressed: () => context.pop(),
                  child: const Text('Cancel'),
                ),
              ],
            ),
    );
  }
}

class DisputeReasonScreen extends ConsumerStatefulWidget {
  const DisputeReasonScreen({super.key});

  @override
  ConsumerState<DisputeReasonScreen> createState() =>
      _DisputeReasonScreenState();
}

class _DisputeReasonScreenState extends ConsumerState<DisputeReasonScreen> {
  DisputeReason? _reason;
  final _detailsController = TextEditingController();
  String? _validation;

  @override
  void dispose() {
    _detailsController.dispose();
    super.dispose();
  }

  void _continue() {
    if (_reason == null) {
      setState(() => _validation = 'Choose a reason to continue.');
      return;
    }
    ref
        .read(disputeProvider.notifier)
        .selectReason(_reason!, details: _detailsController.text);
    context.push('/profile/add-evidence');
  }

  @override
  Widget build(BuildContext context) {
    final match = ref.watch(disputeProvider).match;
    return _DisputeScaffold(
      title: 'WHY ARE YOU REPORTING?',
      child: match == null
          ? const _MissingMatchState()
          : Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  'Help us understand what happened.',
                  style: AppTypography.bodyLarge.copyWith(
                    color: AppColors.textSecondary,
                  ),
                ),
                const SizedBox(height: 16),
                for (final reason in DisputeReason.values) ...[
                  _ChoiceCard(
                    selected: _reason == reason,
                    title: reason.label,
                    subtitle: reason.description,
                    onTap: () => setState(() {
                      _reason = reason;
                      _validation = null;
                    }),
                  ),
                  const SizedBox(height: 8),
                ],
                const SizedBox(height: 8),
                Text(
                  'Additional details (optional)',
                  style: AppTypography.labelBold,
                ),
                const SizedBox(height: 8),
                TextField(
                  key: const Key('dispute-details-field'),
                  controller: _detailsController,
                  minLines: 3,
                  maxLines: 5,
                  maxLength: 500,
                  decoration: const InputDecoration(
                    hintText:
                        'Describe what happened without sharing private information.',
                    alignLabelWithHint: true,
                  ),
                ),
                if (_validation != null) ...[
                  const SizedBox(height: 4),
                  Text(
                    _validation!,
                    style: AppTypography.bodySmall.copyWith(
                      color: AppColors.danger,
                    ),
                  ),
                ],
                const SizedBox(height: 18),
                PrimaryActionButton(label: 'Continue', onPressed: _continue),
                const SizedBox(height: 8),
                TextButton(
                  onPressed: () => context.pop(),
                  child: const Text('Cancel'),
                ),
              ],
            ),
    );
  }
}

class AddEvidenceScreen extends ConsumerStatefulWidget {
  const AddEvidenceScreen({super.key});

  @override
  ConsumerState<AddEvidenceScreen> createState() => _AddEvidenceScreenState();
}

class _AddEvidenceScreenState extends ConsumerState<AddEvidenceScreen> {
  final _controller = TextEditingController();

  @override
  void initState() {
    super.initState();
    _controller.text = ref.read(disputeProvider).details;
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    ref.read(disputeProvider.notifier).updateDetails(_controller.text);
    final submitted = await ref.read(disputeProvider.notifier).submit();
    if (!mounted || !submitted) return;
    context.go('/profile/dispute-submitted');
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(disputeProvider);
    if (state.match == null || state.reason == null) {
      return const _DisputeScaffold(
        title: 'ADD EVIDENCE',
        child: _MissingMatchState(),
      );
    }
    return _DisputeScaffold(
      title: 'ADD EVIDENCE',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            'Add concise details that can help support review the match.',
            style: AppTypography.bodyLarge.copyWith(
              color: AppColors.textSecondary,
            ),
          ),
          const SizedBox(height: 16),
          FlowCard(
            child: Row(
              children: [
                const Icon(LucideIcons.flag, color: AppColors.primaryBright),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(state.reason!.label, style: AppTypography.labelBold),
                      const SizedBox(height: 2),
                      Text(
                        'Match ${_shortReference(state.match!.matchId)}',
                        style: AppTypography.bodySmall,
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 18),
          Text('What happened?', style: AppTypography.labelBold),
          const SizedBox(height: 8),
          TextField(
            key: const Key('evidence-details-field'),
            controller: _controller,
            minLines: 5,
            maxLines: 8,
            maxLength: 1000,
            decoration: const InputDecoration(
              hintText: 'Share only information relevant to this match.',
              alignLabelWithHint: true,
            ),
          ),
          const SizedBox(height: 12),
          const FlowCard(
            borderColor: AppColors.valueAccent,
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(LucideIcons.paperclip, color: AppColors.valueAccent),
                SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Secure attachments unavailable',
                        style: AppTypography.labelBold,
                      ),
                      SizedBox(height: 3),
                      Text(
                        'Screenshots will be enabled when the player evidence-upload contract is available.',
                        style: AppTypography.bodySmall,
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          if (state.message != null) ...[
            const SizedBox(height: 12),
            _InlineMessage(
              message: state.message!,
              danger: state.phase == DisputeLoadPhase.error,
            ),
          ],
          const SizedBox(height: 22),
          PrimaryActionButton(
            label: 'Submit dispute',
            icon: LucideIcons.send,
            loading: state.phase == DisputeLoadPhase.submitting,
            onPressed: state.busy ? null : _submit,
          ),
          const SizedBox(height: 8),
          TextButton(
            onPressed: state.busy ? null : () => context.pop(),
            child: const Text('Back'),
          ),
        ],
      ),
    );
  }
}

class DisputeSubmittedScreen extends ConsumerWidget {
  const DisputeSubmittedScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final dispute = ref.watch(disputeProvider).dispute;
    return _DisputeScaffold(
      title: '',
      child: dispute == null
          ? const _UnavailableDisputeState(
              message: 'No server-confirmed dispute is available.',
            )
          : Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const SizedBox(height: 26),
                const Center(
                  child: _StatusHero(
                    icon: LucideIcons.send,
                    color: AppColors.primaryBright,
                  ),
                ),
                const SizedBox(height: 24),
                Text(
                  'DISPUTE SUBMITTED',
                  textAlign: TextAlign.center,
                  style: AppTypography.heading2,
                ),
                const SizedBox(height: 8),
                Text(
                  'Your report has been submitted and is under review.',
                  textAlign: TextAlign.center,
                  style: AppTypography.bodyLarge.copyWith(
                    color: AppColors.textSecondary,
                  ),
                ),
                const SizedBox(height: 24),
                FlowCard(
                  child: Column(
                    children: [
                      _DetailRow(
                        label: 'Report ID',
                        value: dispute.maskedReference,
                      ),
                      _DetailRow(
                        label: 'Match ID',
                        value: _shortReference(dispute.matchId),
                      ),
                      _DetailRow(
                        label: 'Submitted',
                        value: DateFormat(
                          'MMM d, y, HH:mm',
                        ).format(dispute.createdAt.toLocal()),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 14),
                const _InlineMessage(
                  message:
                      'Our team will review the server record and notify you of the outcome.',
                ),
                const SizedBox(height: 28),
                PrimaryActionButton(
                  label: 'View dispute status',
                  onPressed: () => context.go('/profile/dispute-status'),
                ),
                const SizedBox(height: 8),
                TextButton(
                  onPressed: () {
                    ref.read(disputeProvider.notifier).clear();
                    context.go('/results');
                  },
                  child: const Text('Done'),
                ),
              ],
            ),
    );
  }
}

class DisputeStatusScreen extends ConsumerStatefulWidget {
  const DisputeStatusScreen({
    this.disputeId,
    this.matchId,
    this.autoRefresh = true,
    super.key,
  });

  final String? disputeId;
  final String? matchId;
  final bool autoRefresh;

  @override
  ConsumerState<DisputeStatusScreen> createState() =>
      _DisputeStatusScreenState();
}

class _DisputeStatusScreenState extends ConsumerState<DisputeStatusScreen> {
  @override
  void initState() {
    super.initState();
    if (widget.autoRefresh) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) {
          ref
              .read(disputeProvider.notifier)
              .refreshStatus(widget.disputeId, matchId: widget.matchId);
        }
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(disputeProvider);
    final dispute = state.dispute;
    if (dispute == null) {
      return _DisputeScaffold(
        title: 'DISPUTE STATUS',
        child: _UnavailableDisputeState(
          loading: state.phase == DisputeLoadPhase.refreshing,
          message: state.message ?? 'Dispute status is not available.',
          onRetry: () => ref
              .read(disputeProvider.notifier)
              .refreshStatus(widget.disputeId, matchId: widget.matchId),
        ),
      );
    }
    final visual = _statusVisual(dispute.status);
    final timeline = dispute.timeline.isEmpty
        ? _defaultTimeline(dispute)
        : dispute.timeline;
    return _DisputeScaffold(
      title: 'DISPUTE STATUS',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          FlowCard(
            borderColor: visual.color,
            color: visual.color.withValues(alpha: .12),
            child: Row(
              children: [
                Icon(visual.icon, color: visual.color, size: 36),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        visual.title,
                        style: AppTypography.heading3.copyWith(
                          color: visual.color,
                        ),
                      ),
                      const SizedBox(height: 3),
                      Text(visual.subtitle, style: AppTypography.bodySmall),
                    ],
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 14),
          FlowCard(
            child: Column(
              children: [
                _DetailRow(label: 'Report ID', value: dispute.maskedReference),
                _DetailRow(
                  label: 'Match ID',
                  value: _shortReference(dispute.matchId),
                ),
                _DetailRow(label: 'Reason', value: dispute.reason),
                _DetailRow(label: 'Status', value: visual.title),
                _DetailRow(
                  label: 'Last update',
                  value: DateFormat(
                    'MMM d, y, HH:mm',
                  ).format(dispute.updatedAt.toLocal()),
                ),
              ],
            ),
          ),
          if (dispute.resolution?.trim().isNotEmpty == true) ...[
            const SizedBox(height: 12),
            FlowCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Resolution', style: AppTypography.labelBold),
                  const SizedBox(height: 5),
                  Text(dispute.resolution!, style: AppTypography.bodySmall),
                ],
              ),
            ),
          ],
          const SizedBox(height: 18),
          for (var index = 0; index < timeline.length; index++)
            _TimelineTile(
              item: timeline[index],
              last: index == timeline.length - 1,
            ),
          if (state.message != null) ...[
            const SizedBox(height: 12),
            _InlineMessage(
              message: state.message!,
              danger: state.phase == DisputeLoadPhase.error,
            ),
          ],
          const SizedBox(height: 22),
          PrimaryActionButton(
            label: 'Refresh status',
            icon: LucideIcons.refreshCw,
            loading: state.phase == DisputeLoadPhase.refreshing,
            onPressed: state.busy
                ? null
                : () => ref
                      .read(disputeProvider.notifier)
                      .refreshStatus(dispute.id, matchId: dispute.matchId),
          ),
          const SizedBox(height: 8),
          SecondaryActionButton(
            label: 'Back to matches',
            onPressed: () => context.go('/results'),
          ),
        ],
      ),
    );
  }
}

class _DisputeScaffold extends StatelessWidget {
  const _DisputeScaffold({required this.title, required this.child});

  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: AppColors.background,
    appBar: title.isEmpty
        ? null
        : AppBar(
            backgroundColor: AppColors.background,
            title: Text(title),
            centerTitle: true,
          ),
    body: SafeArea(
      top: title.isEmpty,
      child: FlowPage(child: child),
    ),
  );
}

class _MatchSummaryCard extends StatelessWidget {
  const _MatchSummaryCard({required this.match});

  final DisputeMatchSummary match;

  @override
  Widget build(BuildContext context) => FlowCard(
    child: Column(
      children: [
        Row(
          children: [
            const GameAvatar(avatarId: 'avatar_01', size: 52, label: 'You'),
            Expanded(
              child: Text(
                'VS',
                textAlign: TextAlign.center,
                style: AppTypography.heading3.copyWith(
                  color: AppColors.valueAccent,
                ),
              ),
            ),
            GameAvatar(
              avatarId: match.opponentAvatarId,
              size: 52,
              label: match.opponentName,
              accent: AppColors.valueAccent,
            ),
          ],
        ),
        const SizedBox(height: 10),
        Row(
          children: [
            Expanded(
              child: Text(
                'You',
                textAlign: TextAlign.center,
                style: AppTypography.labelBold,
              ),
            ),
            Expanded(
              child: Text(
                match.opponentName,
                textAlign: TextAlign.center,
                style: AppTypography.labelBold,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ],
        ),
        const Divider(height: 22),
        _DetailRow(label: 'Match ID', value: _shortReference(match.matchId)),
        if (match.playedAt != null)
          _DetailRow(
            label: 'Played',
            value: DateFormat(
              'MMM d, y, HH:mm',
            ).format(match.playedAt!.toLocal()),
          ),
      ],
    ),
  );
}

class _ChoiceCard extends StatelessWidget {
  const _ChoiceCard({
    required this.selected,
    required this.title,
    required this.subtitle,
    required this.onTap,
  });

  final bool selected;
  final String title;
  final String subtitle;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    selected: selected,
    label: '$title. $subtitle',
    child: InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(12),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 140),
        padding: const EdgeInsets.all(13),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(
            color: selected ? AppColors.primaryBright : AppColors.border,
          ),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 20,
              height: 20,
              margin: const EdgeInsets.only(top: 1),
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                border: Border.all(
                  color: selected
                      ? AppColors.primaryBright
                      : AppColors.textSecondary,
                  width: 2,
                ),
              ),
              child: selected
                  ? const Center(
                      child: CircleAvatar(
                        radius: 5,
                        backgroundColor: AppColors.primaryBright,
                      ),
                    )
                  : null,
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
          ],
        ),
      ),
    ),
  );
}

class _DetailRow extends StatelessWidget {
  const _DetailRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 5),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(child: Text(label, style: AppTypography.bodySmall)),
        const SizedBox(width: 12),
        Flexible(
          child: Text(
            value,
            textAlign: TextAlign.end,
            style: AppTypography.labelBold.copyWith(fontSize: 13),
          ),
        ),
      ],
    ),
  );
}

class _TimelineTile extends StatelessWidget {
  const _TimelineTile({required this.item, required this.last});

  final DisputeTimelineItem item;
  final bool last;

  @override
  Widget build(BuildContext context) => IntrinsicHeight(
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SizedBox(
          width: 30,
          child: Column(
            children: [
              Icon(
                item.complete ? LucideIcons.circleCheck : LucideIcons.circle,
                color: item.complete
                    ? AppColors.primaryBright
                    : AppColors.textSecondary,
                size: 19,
              ),
              if (!last)
                Expanded(
                  child: Container(
                    width: 1,
                    color: item.complete
                        ? AppColors.primaryBright
                        : AppColors.border,
                  ),
                ),
            ],
          ),
        ),
        const SizedBox(width: 9),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.only(bottom: 18),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(item.label, style: AppTypography.labelBold),
                const SizedBox(height: 2),
                Text(
                  item.detail ??
                      DateFormat('MMM d, y, HH:mm').format(item.at.toLocal()),
                  style: AppTypography.bodySmall,
                ),
              ],
            ),
          ),
        ),
      ],
    ),
  );
}

class _InlineMessage extends StatelessWidget {
  const _InlineMessage({required this.message, this.danger = false});

  final String message;
  final bool danger;

  @override
  Widget build(BuildContext context) => FlowCard(
    borderColor: danger ? AppColors.danger : AppColors.primaryBright,
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(
          danger ? LucideIcons.triangleAlert : LucideIcons.info,
          color: danger ? AppColors.danger : AppColors.primaryBright,
        ),
        const SizedBox(width: 11),
        Expanded(child: Text(message, style: AppTypography.bodySmall)),
      ],
    ),
  );
}

class _StatusHero extends StatelessWidget {
  const _StatusHero({required this.icon, required this.color});

  final IconData icon;
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
    width: 112,
    height: 112,
    decoration: BoxDecoration(
      shape: BoxShape.circle,
      color: color.withValues(alpha: .16),
      border: Border.all(color: color, width: 3),
      boxShadow: [
        BoxShadow(color: color.withValues(alpha: .2), blurRadius: 28),
      ],
    ),
    child: Icon(icon, color: color, size: 58),
  );
}

class _MissingMatchState extends StatelessWidget {
  const _MissingMatchState();

  @override
  Widget build(BuildContext context) => const _UnavailableDisputeState(
    message: 'Choose a completed match before starting a report or dispute.',
  );
}

class _UnavailableDisputeState extends StatelessWidget {
  const _UnavailableDisputeState({
    required this.message,
    this.loading = false,
    this.onRetry,
  });

  final String message;
  final bool loading;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 72),
    child: Column(
      children: [
        if (loading)
          const CircularProgressIndicator(color: AppColors.primaryBright)
        else
          const Icon(
            LucideIcons.shieldAlert,
            color: AppColors.valueAccent,
            size: 58,
          ),
        const SizedBox(height: 18),
        Text(
          loading ? 'CHECKING STATUS' : 'STATUS UNAVAILABLE',
          textAlign: TextAlign.center,
          style: AppTypography.heading3,
        ),
        const SizedBox(height: 8),
        Text(
          message,
          textAlign: TextAlign.center,
          style: AppTypography.bodyLarge.copyWith(
            color: AppColors.textSecondary,
          ),
        ),
        if (!loading && onRetry != null) ...[
          const SizedBox(height: 22),
          PrimaryActionButton(
            label: 'Try again',
            icon: LucideIcons.refreshCw,
            onPressed: onRetry,
          ),
        ],
      ],
    ),
  );
}

class _StatusVisual {
  const _StatusVisual({
    required this.title,
    required this.subtitle,
    required this.icon,
    required this.color,
  });

  final String title;
  final String subtitle;
  final IconData icon;
  final Color color;
}

_StatusVisual _statusVisual(DisputeStatus status) => switch (status) {
  DisputeStatus.open => const _StatusVisual(
    title: 'Submitted',
    subtitle: 'Your report is waiting for review.',
    icon: LucideIcons.clock3,
    color: AppColors.primaryBright,
  ),
  DisputeStatus.underReview => const _StatusVisual(
    title: 'Under review',
    subtitle: 'We are reviewing your report.',
    icon: LucideIcons.hourglass,
    color: AppColors.valueAccent,
  ),
  DisputeStatus.resolved => const _StatusVisual(
    title: 'Resolved',
    subtitle: 'A server-confirmed decision is available.',
    icon: LucideIcons.circleCheck,
    color: AppColors.primaryBright,
  ),
  DisputeStatus.dismissed => const _StatusVisual(
    title: 'Dismissed',
    subtitle: 'The report was reviewed and closed.',
    icon: LucideIcons.circleX,
    color: AppColors.textSecondary,
  ),
  DisputeStatus.unavailable => const _StatusVisual(
    title: 'Status unavailable',
    subtitle: 'The server did not return a valid status.',
    icon: LucideIcons.shieldAlert,
    color: AppColors.danger,
  ),
};

List<DisputeTimelineItem> _defaultTimeline(DisputeCaseData dispute) {
  final reviewing = dispute.status != DisputeStatus.open;
  final decided =
      dispute.status == DisputeStatus.resolved ||
      dispute.status == DisputeStatus.dismissed;
  return [
    DisputeTimelineItem(
      label: 'Report submitted',
      at: dispute.createdAt,
      complete: true,
    ),
    DisputeTimelineItem(
      label: reviewing ? 'Under review' : 'Review pending',
      at: dispute.updatedAt,
      detail: reviewing
          ? 'The support team is reviewing the server record.'
          : 'You will be notified when review begins.',
      complete: reviewing,
    ),
    DisputeTimelineItem(
      label: decided ? 'Decision recorded' : 'Decision pending',
      at: dispute.updatedAt,
      detail: decided
          ? 'The server has recorded the review outcome.'
          : 'You will be notified when a decision is available.',
      complete: decided,
    ),
  ];
}

String _shortReference(String value) {
  if (value.length <= 12) return '#$value';
  return '#${value.substring(0, 6)}…${value.substring(value.length - 4)}';
}
