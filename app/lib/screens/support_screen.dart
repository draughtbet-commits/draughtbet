import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../models/support_case.dart';
import '../providers/eligibility_provider.dart';
import '../providers/support_provider.dart';
import '../theme/colors.dart';
import '../theme/typography.dart';
import '../widgets/flow_widgets.dart';

/// Player-facing support: open a case and track what is already open.
///
/// A banned account reaches this too — that is deliberate. Restricting an
/// account without giving the player a way to appeal is a dead end, so the
/// restricted screen links straight here.
class SupportScreen extends ConsumerStatefulWidget {
  const SupportScreen({super.key, this.initialType});

  final SupportCaseType? initialType;

  @override
  ConsumerState<SupportScreen> createState() => _SupportScreenState();
}

class _SupportScreenState extends ConsumerState<SupportScreen> {
  late final SupportCaseType _type =
      widget.initialType ?? SupportCaseType.general;

  final _subject = TextEditingController();
  final _description = TextEditingController();
  String? _validation;

  @override
  void initState() {
    super.initState();
    // Pre-fill so the common case (account restriction) needs no typing.
    if (_type == SupportCaseType.account) {
      _subject.text = 'Account restricted — please review';
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(supportProvider.notifier).load();
    });
  }

  @override
  void dispose() {
    _subject.dispose();
    _description.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final subject = _subject.text.trim();
    if (subject.isEmpty) {
      setState(() => _validation = 'Add a short subject so we can route this.');
      return;
    }
    if (subject.length > 200) {
      setState(() => _validation = 'Subject must be 200 characters or fewer.');
      return;
    }
    setState(() => _validation = null);
    final ok = await ref
        .read(supportProvider.notifier)
        .openCase(
          type: _type,
          subject: subject,
          description: _description.text,
        );
    if (!ok || !mounted) return;
    final created = ref.read(supportProvider).openedCase;
    _subject.clear();
    _description.clear();
    FocusScope.of(context).unfocus();
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          created == null
              ? 'Case opened.'
              : 'Case opened — reference ${created.maskedReference}',
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(supportProvider);

    // A reinstatement resolves the player's appeal server-side, so the list on
    // screen is stale the moment it happens. Reload rather than leaving an
    // open case behind that nobody is going to answer.
    ref.listen<EligibilityState>(eligibilityProvider, (previous, next) {
      final wasBanned = previous?.verification?.isBanned ?? false;
      final isBanned = next.verification?.isBanned ?? false;
      if (wasBanned && !isBanned) {
        ref.read(supportProvider.notifier).load();
      }
    });

    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        title: Text('SUPPORT', style: AppTypography.heading3),
        backgroundColor: AppColors.background,
        elevation: 0,
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
          children: [
            Text('Open a case', style: AppTypography.heading3),
            const SizedBox(height: 6),
            Text(
              'Tell us what happened and a support agent will pick it up. '
              'Your reference is shown once the case is open.',
              style: AppTypography.bodyLarge.copyWith(
                color: AppColors.textSecondary,
              ),
            ),
            const SizedBox(height: 20),
            _Label(text: 'Category'),
            const SizedBox(height: 6),
            _ReadOnlyCategory(type: _type),
            const SizedBox(height: 16),
            _Label(text: 'Subject'),
            const SizedBox(height: 6),
            TextField(
              controller: _subject,
              maxLength: 200,
              style: AppTypography.bodyLarge,
              decoration: InputDecoration(
                counterText: '',
                filled: true,
                fillColor: AppColors.surfaceRaised,
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                  borderSide: const BorderSide(color: AppColors.border),
                ),
              ),
            ),
            const SizedBox(height: 16),
            _Label(text: 'Details (optional)'),
            const SizedBox(height: 6),
            TextField(
              controller: _description,
              maxLines: 5,
              style: AppTypography.bodyLarge,
              decoration: InputDecoration(
                filled: true,
                fillColor: AppColors.surfaceRaised,
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                  borderSide: const BorderSide(color: AppColors.border),
                ),
              ),
            ),
            if (_validation != null) ...[
              const SizedBox(height: 10),
              Text(
                _validation!,
                style: AppTypography.bodySmall.copyWith(
                  color: AppColors.danger,
                ),
              ),
            ],
            if (state.errorMessage != null) ...[
              const SizedBox(height: 10),
              Text(
                state.errorMessage!,
                style: AppTypography.bodySmall.copyWith(
                  color: AppColors.danger,
                ),
              ),
            ],
            const SizedBox(height: 18),
            PrimaryActionButton(
              label: 'Open case',
              loading: state.submitting,
              onPressed: state.submitting ? null : _submit,
            ),
            const SizedBox(height: 28),
            Row(
              children: [
                Text('Your cases', style: AppTypography.heading3),
                const Spacer(),
                TextButton(
                  onPressed: state.loading
                      ? null
                      : () => ref.read(supportProvider.notifier).load(),
                  child: const Text('Refresh'),
                ),
              ],
            ),
            const SizedBox(height: 8),
            if (state.loading && state.cases.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 24),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (state.cases.isEmpty)
              Text(
                'No support cases yet.',
                style: AppTypography.bodyLarge.copyWith(
                  color: AppColors.textSecondary,
                ),
              )
            else
              ...state.cases.map(
                (c) => Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: _CaseCard(supportCase: c),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _CaseCard extends StatelessWidget {
  const _CaseCard({required this.supportCase});

  final SupportCase supportCase;

  @override
  Widget build(BuildContext context) {
    return FlowCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  supportCase.subject,
                  style: AppTypography.bodyLarge,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              const SizedBox(width: 8),
              Text(
                supportCase.status.label,
                style: AppTypography.bodySmall.copyWith(
                  color: supportCase.status.isOpen
                      ? AppColors.valueAccent
                      : AppColors.textSecondary,
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            '${supportCase.type.label} · ${supportCase.maskedReference}',
            style: AppTypography.bodySmall.copyWith(
              color: AppColors.textSecondary,
            ),
          ),
        ],
      ),
    );
  }
}

class _ReadOnlyCategory extends StatelessWidget {
  const _ReadOnlyCategory({required this.type});

  final SupportCaseType type;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: AppColors.surfaceRaised,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.border),
      ),
      child: Row(
        children: [
          const Icon(
            LucideIcons.tag,
            size: 16,
            color: AppColors.textSecondary,
          ),
          const SizedBox(width: 10),
          Text(type.label, style: AppTypography.bodyLarge),
        ],
      ),
    );
  }
}

class _Label extends StatelessWidget {
  const _Label({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) => Text(
    text,
    style: AppTypography.bodySmall.copyWith(color: AppColors.textSecondary),
  );
}