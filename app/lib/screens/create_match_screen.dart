import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../models/match_flow.dart';
import '../models/wallet.dart';
import '../providers/match_flow_provider.dart';
import '../providers/profile_provider.dart';
import '../providers/wallet_provider.dart';
import '../theme/colors.dart';
import '../widgets/flow_widgets.dart';

class CreateMatchScreen extends ConsumerStatefulWidget {
  const CreateMatchScreen({super.key});

  @override
  ConsumerState<CreateMatchScreen> createState() => _CreateMatchScreenState();
}

class _CreateMatchScreenState extends ConsumerState<CreateMatchScreen> {
  // The picker is driven by the caller's tier range fetched from the server:
  // this screen creates an OPEN listing, so the create endpoint validates the
  // stake against the tier's call-out ceiling.
  int? _stake;
  // The gateway turns this into `timeControlSeconds` for the create endpoint by
  // reading the leading number, so it has to be a real control and not a label.
  static const _timeControl = '10 minutes';
  static const _gameType = 'Classic';
  static const _board = '10×10 (International)';
  // The create endpoint only accepts PUBLIC, PRIVATE or ANYONE.
  static const _visibility = 'Anyone';
  // A private listing is joined by a shareable code instead of the Arena queue.
  bool _privateRoom = false;

  @override
  void initState() {
    super.initState();
    if (ref.read(walletProvider).tierLimits == null) {
      Future.microtask(
        () => ref.read(walletProvider.notifier).fetchTierLimits(),
      );
    }
  }

  // Resolves the stake bounds from the server tier limits, falling back to the
  // per-tier presets (and finally the platform defaults) until they load.
  (int, int) _resolveLimits(TierLimits? limits) {
    if (limits != null) {
      final min = int.tryParse(limits.stakeMin) ?? 50000;
      final max = int.tryParse(limits.calloutMax) ?? 5000000;
      return (min, max);
    }
    final presets = stakePresetsForTier(
      ref.read(profileProvider).profile?.tier,
    );
    if (presets.isEmpty) return (50000, 5000000);
    return (
      presets.reduce((a, b) => a < b ? a : b),
      presets.reduce((a, b) => a > b ? a : b),
    );
  }

  int _clamp(int value, int min, int max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  void _review() {
    final (min, max) = _resolveLimits(ref.read(walletProvider).tierLimits);
    final stake = _clamp(_stake ?? min, min, max);
    final intent = MatchFlowIntent(
      kind: MatchEntryKind.created,
      terms: MatchTerms(
        stakeMinorUnits: stake,
        timeControl: _timeControl,
        gameType: _gameType,
        board: _board,
        visibility: _privateRoom ? 'Private Room' : _visibility,
        privateRoom: _privateRoom,
      ),
    );
    ref.read(matchFlowProvider.notifier).review(intent);
    context.go('/play/confirm');
  }

  Widget _fieldLabel(String label) => Padding(
    padding: const EdgeInsets.only(bottom: 6),
    child: Text(
      label,
      style: TextStyle(
        fontFamily: 'Inter',
        color: AppColors.textSecondary,
        fontSize: 11,
        fontWeight: FontWeight.w600,
      ),
    ),
  );

  @override
  Widget build(BuildContext context) {
    final (stakeMin, stakeMax) = _resolveLimits(
      ref.watch(walletProvider).tierLimits,
    );
    final stake = _clamp(_stake ?? stakeMin, stakeMin, stakeMax);
    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        leading: IconButton(
          tooltip: 'Back',
          onPressed: () => context.go('/home'),
          icon: const Icon(Icons.arrow_back_ios_new_rounded, size: 19),
        ),
        title: const Text('Create Match'),
      ),
      body: SafeArea(
        child: FlowPage(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Set your match preferences',
                style: TextStyle(
                  fontFamily: 'Inter',
                  fontSize: 12,
                  color: AppColors.textSecondary,
                ),
              ),
              const SizedBox(height: 18),
              _fieldLabel('Stake Amount'),
              Text(
                'Stake: ${Money(stake).format()}',
                style: TextStyle(
                  fontFamily: 'Inter',
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                  color: AppColors.textPrimary,
                ),
              ),
              Slider(
                value: stake.toDouble(),
                min: stakeMin.toDouble(),
                max: stakeMax.toDouble(),
                divisions: stakeMax > stakeMin
                    ? ((stakeMax - stakeMin) ~/ 50000).clamp(1, 600)
                    : 1,
                onChanged: (value) => setState(() => _stake = value.toInt()),
              ),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(
                    Money(stakeMin).format(),
                    style: TextStyle(
                      fontSize: 10,
                      color: AppColors.textSecondary,
                    ),
                  ),
                  Text(
                    Money(stakeMax).format(),
                    style: TextStyle(
                      fontSize: 10,
                      color: AppColors.textSecondary,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 13),
              _fieldLabel('Time Control'),
              const _ServerConfiguredField(value: _timeControl),
              const SizedBox(height: 13),
              _fieldLabel('Game Type'),
              const _ServerConfiguredField(value: _gameType),
              const SizedBox(height: 13),
              _fieldLabel('Board'),
              const _ServerConfiguredField(value: _board),
              const SizedBox(height: 13),
              _fieldLabel('Who can join?'),
              _ServerConfiguredField(
                value: _privateRoom ? 'Invite by code' : _visibility,
              ),
              const SizedBox(height: 10),
              Material(
                color: AppColors.transparent,
                child: SwitchListTile.adaptive(
                  contentPadding: EdgeInsets.zero,
                  value: _privateRoom,
                  onChanged: (value) => setState(() => _privateRoom = value),
                  title: Text(
                    'Private Room (Optional)',
                    style: TextStyle(
                      fontFamily: 'Inter',
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  subtitle: Text(
                    _privateRoom
                        ? 'Only players with your room code can join'
                        : 'Create a shareable code instead of listing publicly',
                    style: TextStyle(
                      fontFamily: 'Inter',
                      fontSize: 10,
                      color: AppColors.textSecondary,
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 8),
              FlowCard(
                padding: const EdgeInsets.symmetric(
                  horizontal: 14,
                  vertical: 10,
                ),
                child: Column(
                  children: [
                    _QuoteRow(
                      label: 'Your stake',
                      value: Money(stake).format(),
                    ),
                    const _QuoteRow(
                      label: 'Platform fee',
                      value: 'Server confirms',
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 16),
              PrimaryActionButton(label: 'Review Match', onPressed: _review),
            ],
          ),
        ),
      ),
    );
  }
}

class _ServerConfiguredField extends StatelessWidget {
  const _ServerConfiguredField({required this.value});

  final String value;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      readOnly: true,
      value: value,
      child: InputDecorator(
        decoration: const InputDecoration(
          suffixIcon: Icon(
            Icons.lock_outline_rounded,
            size: 18,
            color: AppColors.textSecondary,
          ),
        ),
        child: Text(
          value,
          style: const TextStyle(
            fontFamily: 'Inter',
            color: AppColors.textPrimary,
            fontSize: 16,
            fontWeight: FontWeight.w600,
          ),
        ),
      ),
    );
  }
}

class _QuoteRow extends StatelessWidget {
  const _QuoteRow({required this.label, required this.value});

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
            style: TextStyle(
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
