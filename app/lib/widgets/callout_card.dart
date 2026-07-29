import 'dart:async';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../models/callout.dart';
import '../theme/colors.dart';
import '../theme/tier_theme.dart';

class CalloutCard extends StatefulWidget {
  final Callout callout;
  final int tierCalloutMax;
  final VoidCallback onAccept;

  const CalloutCard({
    Key? key,
    required this.callout,
    required this.tierCalloutMax,
    required this.onAccept,
  }) : super(key: key);

  @override
  State<CalloutCard> createState() => _CalloutCardState();
}

class _CalloutCardState extends State<CalloutCard> {
  late Timer _timer;
  Duration _timeLeft = Duration.zero;

  @override
  void initState() {
    super.initState();
    _updateTimeLeft();
    _timer = Timer.periodic(const Duration(seconds: 1), (_) => _updateTimeLeft());
  }

  @override
  void dispose() {
    _timer.cancel();
    super.dispose();
  }

  void _updateTimeLeft() {
    if (!mounted) return;
    final now = DateTime.now();
    setState(() {
      _timeLeft = widget.callout.expiresAt.difference(now);
    });
  }

  String _formatTimeLeft() {
    if (_timeLeft.isNegative) return 'Expired';
    final minutes = _timeLeft.inMinutes;
    final seconds = _timeLeft.inSeconds % 60;
    return 'Expires in ${minutes}m ${seconds}s';
  }

  String _getInitials(String name) {
    if (name.isEmpty) return '?';
    final parts = name.trim().split(' ');
    if (parts.length > 1) {
      return '${parts[0][0]}${parts[1][0]}'.toUpperCase();
    }
    return name.substring(0, name.length > 1 ? 2 : 1).toUpperCase();
  }

  @override
  Widget build(BuildContext context) {
    final isUrgent = _timeLeft <= const Duration(minutes: 2) && !_timeLeft.isNegative;
    final isFeatured = widget.callout.stakeMinorUnits >= widget.tierCalloutMax;
    final showGoldMotif = isUrgent || isFeatured;

    final theme = TierTheme.forTier(widget.callout.tier);
    final numberFormat = NumberFormat.currency(symbol: '₦', decimalDigits: 0);
    final formattedStake = numberFormat.format(widget.callout.stakeMinorUnits / 100);

    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      decoration: BoxDecoration(
        color: AppColors.surface1,
        borderRadius: BorderRadius.circular(12),
        border: showGoldMotif
            ? Border(
                top: BorderSide(color: AppColors.proGold, width: 2),
                right: BorderSide(color: AppColors.proGold, width: 2),
              )
            : null,
      ),
      child: Stack(
        children: [
          Padding(
            padding: const EdgeInsets.all(16.0),
            child: Row(
              children: [
                // Initials Circle
                Container(
                  width: 36,
                  height: 36,
                  decoration: BoxDecoration(
                    color: AppColors.surface3,
                    shape: BoxShape.circle,
                    border: Border.all(color: theme.primaryColor, width: 2),
                  ),
                  alignment: Alignment.center,
                  child: Text(
                    _getInitials(widget.callout.challengerName),
                    style: const TextStyle(
                      color: AppColors.textMain,
                      fontWeight: FontWeight.bold,
                      fontSize: 14,
                    ),
                  ),
                ),
                const SizedBox(width: 16),
                // Stake & Expiry
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        formattedStake,
                        style: const TextStyle(
                          fontFamily: 'JetBrains Mono',
                          color: AppColors.textMain,
                          fontSize: 18,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        _formatTimeLeft(),
                        style: const TextStyle(
                          color: AppColors.textMuted,
                          fontSize: 12, // Caption
                        ),
                      ),
                    ],
                  ),
                ),
                // Accept Button
                ElevatedButton(
                  onPressed: _timeLeft.isNegative ? null : widget.onAccept,
                  style: ElevatedButton.styleFrom(
                    backgroundColor: theme.primaryColor,
                    foregroundColor: Colors.white,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(8),
                    ),
                  ),
                  child: const Text('Accept Call-out'),
                ),
              ],
            ),
          ),
          if (showGoldMotif)
            Positioned(
              top: 0,
              right: 0,
              child: Container(
                width: 16,
                height: 16,
                decoration: const BoxDecoration(
                  color: AppColors.proGold,
                  borderRadius: BorderRadius.only(
                    topRight: Radius.circular(12),
                    bottomLeft: Radius.circular(12),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
