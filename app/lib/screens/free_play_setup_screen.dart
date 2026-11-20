import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../models/match_flow.dart';
import '../providers/match_flow_provider.dart';
import '../theme/colors.dart';
import '../widgets/flow_widgets.dart';

/// One solo game against the server bot. Nothing here costs money or rating, so
/// the screen only picks the side to play, the bot's strength and the clock, and
/// hands off to the board once the server seats the bot.
class FreePlaySetupScreen extends ConsumerStatefulWidget {
  const FreePlaySetupScreen({super.key});

  @override
  ConsumerState<FreePlaySetupScreen> createState() =>
      _FreePlaySetupScreenState();
}

class _FreePlaySetupScreenState extends ConsumerState<FreePlaySetupScreen> {
  // The server seats the human on the chosen side and the bot opposite.
  String _side = 'WHITE';
  int _botLevel = 2;
  int _clockSeconds = 600;

  static const _levels = <int, String>{
    1: 'Beginner',
    2: 'Casual',
    3: 'Club',
    4: 'Master',
  };

  static const _clocks = <int, String>{
    300: '5 min',
    600: '10 min',
    900: '15 min',
  };

  Future<void> _start() async {
    final created = await ref
        .read(matchFlowProvider.notifier)
        .createFreePlay(
          side: _side,
          botLevel: _botLevel,
          timeControlSeconds: _clockSeconds,
        );
    if (!mounted) return;
    if (created == null) return;
    context.go('/match/${created.matchId}');
  }

  @override
  Widget build(BuildContext context) {
    final flow = ref.watch(matchFlowProvider);
    final submitting = flow.actionPhase == MatchActionPhase.submitting;

    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        leading: IconButton(
          tooltip: 'Back',
          onPressed: () => context.go('/home'),
          icon: const Icon(Icons.arrow_back_ios_new_rounded, size: 19),
        ),
        title: const Text('Free Play'),
      ),
      body: SafeArea(
        child: FlowPage(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Practise against the computer — no stake, no rating.',
                style: TextStyle(
                  fontFamily: 'Inter',
                  fontSize: 12,
                  color: AppColors.textSecondary,
                ),
              ),
              const SizedBox(height: 18),
              _label('Play as'),
              _ChoiceRow(
                options: const {
                  'WHITE': 'White',
                  'BLACK': 'Black',
                },
                selected: _side,
                onSelected: (value) => setState(() => _side = value),
              ),
              const SizedBox(height: 18),
              _label('Difficulty'),
              _ChoiceRow(
                options: _levels.map(
                  (key, value) => MapEntry(key.toString(), value),
                ),
                selected: _botLevel.toString(),
                onSelected: (value) =>
                    setState(() => _botLevel = int.parse(value)),
              ),
              const SizedBox(height: 18),
              _label('Time control'),
              _ChoiceRow(
                options: _clocks.map(
                  (key, value) => MapEntry(key.toString(), value),
                ),
                selected: _clockSeconds.toString(),
                onSelected: (value) =>
                    setState(() => _clockSeconds = int.parse(value)),
              ),
              const SizedBox(height: 18),
              FlowCard(
                padding: const EdgeInsets.symmetric(
                  horizontal: 14,
                  vertical: 10,
                ),
                child: Column(
                  children: [
                    const _InfoRow(
                      label: 'Opponent',
                      value: 'Computer',
                    ),
                    _InfoRow(
                      label: 'You play',
                      value: _side == 'WHITE' ? 'White' : 'Black',
                    ),
                    _InfoRow(
                      label: 'Stake',
                      value: Money(0).format(),
                    ),
                    const _InfoRow(label: 'Rating', value: 'Unaffected'),
                  ],
                ),
              ),
              const SizedBox(height: 16),
              PrimaryActionButton(
                label: 'Start Game',
                icon: LucideIcons.play,
                loading: submitting,
                onPressed: submitting ? null : _start,
              ),
              if (flow.message != null) ...[
                const SizedBox(height: 8),
                Text(
                  flow.message!,
                  style: TextStyle(
                    fontFamily: 'Inter',
                    color: AppColors.danger,
                    fontSize: 12,
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _label(String value) => Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Text(
      value,
      style: TextStyle(
        fontFamily: 'Inter',
        color: AppColors.textSecondary,
        fontSize: 11,
        fontWeight: FontWeight.w600,
      ),
    ),
  );
}

/// A wrap of selectable chips driven by an ordered value → label map. Values
/// are strings so the same widget serves the side, level and clock pickers.
class _ChoiceRow extends StatelessWidget {
  const _ChoiceRow({
    required this.options,
    required this.selected,
    required this.onSelected,
  });

  final Map<String, String> options;
  final String selected;
  final ValueChanged<String> onSelected;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: options.entries.map((entry) {
        final active = entry.key == selected;
        return Semantics(
          button: true,
          selected: active,
          label: entry.value,
          child: ChoiceChip(
            label: Text(entry.value),
            selected: active,
            onSelected: (_) => onSelected(entry.key),
            labelStyle: TextStyle(
              fontFamily: 'Inter',
              fontSize: 12,
              fontWeight: FontWeight.w600,
              color: active ? AppColors.textPrimary : AppColors.textSecondary,
            ),
            selectedColor: AppColors.primaryAction,
            backgroundColor: AppColors.surface,
            side: BorderSide(
              color: active
                  ? AppColors.primaryBright
                  : AppColors.border,
            ),
          ),
        );
      }).toList(growable: false),
    );
  }
}

class _InfoRow extends StatelessWidget {
  const _InfoRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          Expanded(
            child: Text(
              label,
              style: TextStyle(
                fontFamily: 'Inter',
                color: AppColors.textSecondary,
                fontSize: 11,
              ),
            ),
          ),
          Text(
            value,
            style: const TextStyle(
              fontFamily: 'Inter',
              fontSize: 11,
              fontWeight: FontWeight.w700,
            ),
          ),
        ],
      ),
    );
  }
}
