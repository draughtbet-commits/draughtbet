import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../config/backend_contract.dart';
import '../models/dispute.dart';
import '../providers/auth_provider.dart';
import '../providers/player_discovery_provider.dart';
import '../services/api_client.dart';
import '../services/dispute_gateway.dart';
import '../theme/colors.dart';
import '../theme/typography.dart';

class ResultsScreen extends ConsumerStatefulWidget {
  const ResultsScreen({super.key});

  @override
  ConsumerState<ResultsScreen> createState() => _ResultsScreenState();
}

class _ResultsScreenState extends ConsumerState<ResultsScreen> {
  bool _isLoading = true;
  String? _error;
  List<dynamic> _matches = [];
  String? _currentUserId;
  bool _usingV2 = false;
  // V2 /me/matches carries player ids only, so opponent handles are resolved
  // through the public player directory. '' marks a lookup that failed so the
  // row does not refetch on every rebuild.
  final Map<String, String> _opponentNames = {};
  // Match id -> stored case ref for submissions, so a reported row becomes a
  // "View status" entry instead of a dead "Report match" tap.
  final Map<String, DisputeCaseRef> _reportedDisputes = {};

  @override
  void initState() {
    super.initState();
    _fetchHistory();
  }

  Future<void> _fetchHistory() async {
    try {
      setState(() {
        _isLoading = true;
        _error = null;
      });

      final contract = ref.read(backendContractProvider);
      _usingV2 = contract.isV2;
      if (!_usingV2) {
        // The legacy contract derives the result from the winner id, so the
        // identity is needed before the list renders. V2 carries an outcome on
        // every row and only needs the id to name the opponent, which is
        // resolved after the list is on screen.
        _currentUserId = await ref.read(secureStorageProvider).userId;
      }
      _opponentNames.clear();
      final dio = ref.read(apiClientProvider);
      final res = await dio.get(_usingV2 ? '/me/matches' : '/matches/history');

      if (res.statusCode == 200 && res.data is Map) {
        final matches = _usingV2
            ? (res.data['data'] as List?) ?? []
            : (res.data['matches'] as List?) ?? [];
        if (mounted) {
          setState(() {
            _matches = matches;
            _isLoading = false;
          });
          unawaited(_resolveOpponentNames());
          unawaited(_loadReportedDisputes());
        }
      } else {
        if (mounted) {
          setState(() {
            _error = 'Failed to load match history.';
            _isLoading = false;
          });
        }
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = 'Could not retrieve match history.';
          _isLoading = false;
        });
      }
    }
  }

  Future<void> _loadReportedDisputes() async {
    try {
      final refs = await ref.read(secureStorageProvider).loadDisputeRefs();
      if (!mounted || refs.isEmpty) return;
      // Prune refs whose case no longer exists server-side (e.g. the admin or
      // QA cleared it) so a dead "Reported · View status" row does not linger.
      // A network failure keeps the ref so a transient blip never erases a
      // submission the user still wants to follow up.
      final gateway = ref.read(disputeGatewayProvider);
      var pruned = false;
      final surviving = <DisputeCaseRef>[];
      for (final entry in refs) {
        if (entry.disputeId.isEmpty || entry.matchId.isEmpty) {
          pruned = true;
          continue;
        }
        if (await gateway.caseExists(
              matchId: entry.matchId,
              disputeId: entry.disputeId,
            ) ==
            false) {
          pruned = true;
          continue;
        }
        surviving.add(entry);
      }
      if (pruned) {
        await ref.read(secureStorageProvider).saveDisputeRefs(surviving);
      }
      if (!mounted) return;
      setState(() {
        _reportedDisputes
          ..clear()
          ..addEntries(surviving.map((entry) => MapEntry(entry.matchId, entry)));
      });
    } catch (_) {
      // A storage read must never block the results list from rendering.
    }
  }

  String _formatNaira(dynamic minorUnits) {
    final parsed = int.tryParse(minorUnits?.toString() ?? '');
    if (parsed == null) return 'Unavailable';
    final amt = parsed / 100;
    final format = NumberFormat.currency(symbol: '₦', decimalDigits: 0);
    return format.format(amt);
  }

  String? _opponentIdOf(Map<String, dynamic> match) {
    final me = _currentUserId;
    if (me == null || me.isEmpty) return null;
    final lightId = match['playerLightId']?.toString();
    final darkId = match['playerDarkId']?.toString();
    if (lightId == me) return darkId;
    if (darkId == me) return lightId;
    return null;
  }

  String _opponentLabel(String? opponentId) {
    final name = opponentId == null ? null : _opponentNames[opponentId];
    if (name == null || name.isEmpty) return 'Opponent unavailable';
    return name;
  }

  Future<void> _resolveOpponentNames() async {
    if (!_usingV2) return;
    if (_currentUserId == null || _currentUserId!.isEmpty) {
      try {
        _currentUserId = await ref.read(secureStorageProvider).userId;
      } catch (_) {
        return;
      }
    }
    if (_currentUserId == null || _currentUserId!.isEmpty) return;
    final missing = <String>{};
    for (final raw in _matches) {
      if (raw is! Map) continue;
      final id = _opponentIdOf(Map<String, dynamic>.from(raw));
      if (id != null && id.isNotEmpty && !_opponentNames.containsKey(id)) {
        missing.add(id);
      }
    }
    if (missing.isEmpty) return;

    final gateway = ref.read(playerGatewayProvider);
    final resolved = <String, String>{};
    for (final id in missing) {
      try {
        final player = await gateway.fetchProfile(id);
        resolved[id] = player?.name ?? '';
      } catch (_) {
        resolved[id] = '';
      }
    }
    if (!mounted || resolved.isEmpty) return;
    setState(() => _opponentNames.addAll(resolved));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.voidBg,
      appBar: AppBar(
        title: Text('Match Results', style: AppTypography.heading2),
        backgroundColor: AppColors.voidBg,
        elevation: 0,
        actions: [
          IconButton(
            icon: const Icon(
              LucideIcons.refreshCw,
              color: AppColors.textSecondary,
              size: 20,
            ),
            onPressed: _fetchHistory,
          ),
        ],
      ),
      body: _isLoading
          ? const Center(
              child: CircularProgressIndicator(color: AppColors.gold500),
            )
          : _error != null
          ? Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(
                    LucideIcons.alertCircle,
                    color: AppColors.danger,
                    size: 48,
                  ),
                  const SizedBox(height: 16),
                  Text(_error!, style: AppTypography.bodyLarge),
                  const SizedBox(height: 16),
                  ElevatedButton(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: AppColors.surface2,
                    ),
                    onPressed: _fetchHistory,
                    child: const Text(
                      'Retry',
                      style: TextStyle(color: AppColors.textPrimary),
                    ),
                  ),
                ],
              ),
            )
          : _matches.isEmpty
          ? Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(
                    LucideIcons.trophy,
                    color: AppColors.textMuted,
                    size: 48,
                  ),
                  const SizedBox(height: 16),
                  Text('No match history yet', style: AppTypography.heading3),
                  const SizedBox(height: 8),
                  Text(
                    'Play matches in the lobby to see your results here.',
                    style: AppTypography.bodySmall,
                  ),
                ],
              ),
            )
          : ListView.separated(
              padding: const EdgeInsets.all(16),
              itemCount: _matches.length,
              separatorBuilder: (context, index) => const SizedBox(height: 12),
              itemBuilder: (context, index) {
                final m = _matches[index] as Map<String, dynamic>;
                final winnerId = m['winnerId'] as String?;
                final tier = _usingV2
                    ? null
                    : (m['tier'] as String? ?? 'AMATEUR').toUpperCase();
                final outcome = m['outcome']?.toString().toUpperCase();
                final stake = _usingV2
                    ? (outcome == 'WON' ? m['payoutMinor'] : m['stakeMinor'])
                    : m['stakeMinorUnits'];
                final endedAtStr = m['endedAt'] as String?;
                final endedAt = DateTime.tryParse(endedAtStr ?? '');

                final bool isWinner = _usingV2
                    ? outcome == 'WON'
                    : winnerId != null &&
                          _currentUserId != null &&
                          winnerId == _currentUserId;
                final bool isDraw = _usingV2
                    ? outcome == 'DRAW'
                    : winnerId == null || winnerId.isEmpty;
                final bool isDefeat = _usingV2
                    ? outcome == 'LOST'
                    : !isWinner && !isDraw;

                final lightPlayer = m['playerLight'] as Map<String, dynamic>?;
                final darkPlayer = m['playerDark'] as Map<String, dynamic>?;

                final lightPlayerId = m['playerLightId'] as String?;
                final bool isLight =
                    lightPlayerId != null && lightPlayerId == _currentUserId;
                // S17: the history API exposes only the public handle — never the email.
                // V2 /me/matches carries ids only, so the handle is resolved
                // through the player directory (still a public handle).
                final String opponentName = _usingV2
                    ? _opponentLabel(_opponentIdOf(m))
                    : isLight
                    ? (darkPlayer?['username'] as String? ?? 'Opponent')
                    : (lightPlayer?['username'] as String? ?? 'Opponent');

                final Color statusColor;
                final String resultText;
                final IconData resultIcon;

                if (isWinner) {
                  statusColor = AppColors.gold500;
                  resultText = 'VICTORY';
                  resultIcon = LucideIcons.trophy;
                } else if (isDraw) {
                  statusColor = AppColors.textMuted;
                  resultText = 'DRAW';
                  resultIcon = LucideIcons.minus;
                } else if (isDefeat) {
                  statusColor = AppColors.danger;
                  resultText = 'DEFEAT';
                  resultIcon = LucideIcons.x;
                } else {
                  statusColor = AppColors.textMuted;
                  resultText = 'RESULT UNAVAILABLE';
                  resultIcon = LucideIcons.circleHelp;
                }

                final matchId =
                    m['id']?.toString() ?? m['matchId']?.toString() ?? '';
                final DisputeCaseRef? reported = _reportedDisputes[matchId];
                return Semantics(
                  button: true,
                  label: reported == null
                      ? 'Report match against $opponentName'
                      : 'View dispute status for match against $opponentName',
                  child: InkWell(
                    borderRadius: BorderRadius.circular(12),
                    onTap: matchId.isEmpty
                        ? null
                        : reported != null
                        ? () => context.push(
                            '/profile/dispute-status'
                            '?id=${reported.disputeId}&match=$matchId',
                          )
                        : () => context.push(
                            '/profile/report-match',
                            extra: DisputeMatchSummary(
                              matchId: matchId,
                              opponentName: opponentName,
                              playedAt: endedAt,
                            ),
                          ),
                    child: Container(
                      padding: const EdgeInsets.all(16),
                      decoration: BoxDecoration(
                        color: AppColors.surface1,
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(
                          color: isWinner
                              ? AppColors.gold500.withValues(alpha: 0.4)
                              : (isDraw || !isDefeat
                                    ? AppColors.borderDim
                                    : AppColors.danger.withValues(alpha: 0.3)),
                        ),
                      ),
                      child: Row(
                        children: [
                          // Result Icon Circle
                          CircleAvatar(
                            radius: 22,
                            backgroundColor: isWinner
                                ? AppColors.gold500.withValues(alpha: 0.15)
                                : (isDraw || !isDefeat
                                      ? AppColors.surface3
                                      : AppColors.danger.withValues(
                                          alpha: 0.15,
                                        )),
                            child: Icon(
                              resultIcon,
                              color: statusColor,
                              size: 20,
                            ),
                          ),
                          const SizedBox(width: 16),
                          // Match details
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Row(
                                  children: [
                                    Text(
                                      resultText,
                                      style: AppTypography.labelBold.copyWith(
                                        color: statusColor,
                                      ),
                                    ),
                                    const SizedBox(width: 8),
                                    if (tier != null) ...[
                                      const SizedBox(width: 8),
                                      Container(
                                        padding: const EdgeInsets.symmetric(
                                          horizontal: 6,
                                          vertical: 2,
                                        ),
                                        decoration: BoxDecoration(
                                          color: AppColors.surface3,
                                          borderRadius: BorderRadius.circular(
                                            4,
                                          ),
                                        ),
                                        child: Text(
                                          tier,
                                          style: AppTypography.bodySmall
                                              .copyWith(
                                                fontSize: 10,
                                                fontWeight: FontWeight.bold,
                                                color: AppColors.textSecondary,
                                              ),
                                        ),
                                      ),
                                    ],
                                  ],
                                ),
                                const SizedBox(height: 4),
                                Text(
                                  'vs $opponentName',
                                  style: AppTypography.bodyMedium,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  endedAt == null
                                      ? 'Date unavailable'
                                      : DateFormat(
                                          'MMM d, y • h:mm a',
                                        ).format(endedAt.toLocal()),
                                  style: AppTypography.bodySmall,
                                ),
                                if (reported != null) ...[
                                  const SizedBox(height: 2),
                                  Text(
                                    'Reported · View status',
                                    style: AppTypography.bodySmall.copyWith(
                                      fontSize: 11,
                                      color: AppColors.gold500,
                                    ),
                                  ),
                                ],
                              ],
                            ),
                          ),
                          // Stake Amount
                          Column(
                            crossAxisAlignment: CrossAxisAlignment.end,
                            children: [
                              Text(
                                _formatNaira(stake),
                                style: AppTypography.labelBold.copyWith(
                                  color: isWinner
                                      ? AppColors.gold500
                                      : AppColors.textPrimary,
                                  fontSize: 16,
                                ),
                              ),
                              const SizedBox(height: 2),
                              Text(
                                isWinner ? 'Payout' : 'Stake',
                                style: AppTypography.bodySmall.copyWith(
                                  fontSize: 11,
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(width: 5),
                          const Icon(
                            LucideIcons.chevronRight,
                            color: AppColors.textMuted,
                            size: 18,
                          ),
                        ],
                      ),
                    ),
                  ),
                );
              },
            ),
    );
  }
}
