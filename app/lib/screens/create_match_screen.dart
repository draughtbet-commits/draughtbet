import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../models/match_flow.dart';
import '../providers/match_flow_provider.dart';
import '../providers/profile_provider.dart';
import '../theme/colors.dart';
import '../widgets/flow_widgets.dart';

class CreateMatchScreen extends ConsumerStatefulWidget {
  const CreateMatchScreen({super.key});

  @override
  ConsumerState<CreateMatchScreen> createState() => _CreateMatchScreenState();
}

class _CreateMatchScreenState extends ConsumerState<CreateMatchScreen> {
  int _stake = 200000;
  String _timeControl = '10 minutes';
  String _gameType = 'Classic';
  String _board = '10×10 (International)';
  String _visibility = 'Anyone';
  bool _privateRoom = false;
  String? _error;

  void _review() {
    final balance = ref.read(profileProvider).profile?.walletBalanceMinorUnits;
    if (_stake < 50000) {
      setState(() => _error = 'Choose a stake of at least ₦500.');
      return;
    }
    if (balance != null && balance < _stake) {
      setState(() => _error = 'Available balance is below this stake.');
      return;
    }
    final intent = MatchFlowIntent(
      kind: MatchEntryKind.created,
      terms: MatchTerms(
        stakeMinorUnits: _stake,
        timeControl: _timeControl,
        gameType: _gameType,
        board: _board,
        visibility: _visibility,
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
              DropdownButtonFormField<int>(
                isExpanded: true,
                initialValue: _stake,
                items: const [50000, 100000, 200000, 500000]
                    .map(
                      (value) => DropdownMenuItem(
                        value: value,
                        child: Text(Money(value).format()),
                      ),
                    )
                    .toList(),
                onChanged: (value) => setState(() => _stake = value ?? _stake),
              ),
              const SizedBox(height: 13),
              _fieldLabel('Time Control'),
              DropdownButtonFormField<String>(
                isExpanded: true,
                initialValue: _timeControl,
                items: const ['5 minutes', '10 minutes', '15 minutes']
                    .map(
                      (value) =>
                          DropdownMenuItem(value: value, child: Text(value)),
                    )
                    .toList(),
                onChanged: (value) =>
                    setState(() => _timeControl = value ?? _timeControl),
              ),
              const SizedBox(height: 13),
              _fieldLabel('Game Type'),
              DropdownButtonFormField<String>(
                isExpanded: true,
                initialValue: _gameType,
                items: const ['Classic', 'Rated']
                    .map(
                      (value) =>
                          DropdownMenuItem(value: value, child: Text(value)),
                    )
                    .toList(),
                onChanged: (value) =>
                    setState(() => _gameType = value ?? _gameType),
              ),
              const SizedBox(height: 13),
              _fieldLabel('Board'),
              DropdownButtonFormField<String>(
                isExpanded: true,
                initialValue: _board,
                items: const ['10×10 (International)']
                    .map(
                      (value) =>
                          DropdownMenuItem(value: value, child: Text(value)),
                    )
                    .toList(),
                onChanged: (value) => setState(() => _board = value ?? _board),
              ),
              const SizedBox(height: 13),
              _fieldLabel('Who can join?'),
              DropdownButtonFormField<String>(
                isExpanded: true,
                initialValue: _visibility,
                items: const ['Anyone', 'Same tier']
                    .map(
                      (value) =>
                          DropdownMenuItem(value: value, child: Text(value)),
                    )
                    .toList(),
                onChanged: (value) =>
                    setState(() => _visibility = value ?? _visibility),
              ),
              const SizedBox(height: 10),
              Material(
                color: Colors.transparent,
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
                    'Generate a private room code',
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
                      value: Money(_stake).format(),
                    ),
                    const _QuoteRow(
                      label: 'Platform fee',
                      value: 'Server confirms',
                    ),
                  ],
                ),
              ),
              if (_error != null) ...[
                const SizedBox(height: 10),
                Text(
                  _error!,
                  style: TextStyle(
                    fontFamily: 'Inter',
                    color: AppColors.danger,
                    fontSize: 12,
                  ),
                ),
              ],
              const SizedBox(height: 16),
              PrimaryActionButton(label: 'Review Match', onPressed: _review),
            ],
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
