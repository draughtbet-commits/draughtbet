import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import 'package:google_fonts/google_fonts.dart';
import '../providers/match_provider.dart';
import '../providers/profile_provider.dart';
import '../services/api_client.dart';
import '../theme/colors.dart';
import '../theme/typography.dart';
import '../theme/tier_theme.dart';
import '../widgets/balance_card.dart';
import '../widgets/callout_card.dart';
import '../widgets/lobby_header.dart';
import '../widgets/notification_bell.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

class TierSelectScreen extends ConsumerStatefulWidget {
  const TierSelectScreen({Key? key}) : super(key: key);

  @override
  ConsumerState<TierSelectScreen> createState() => _TierSelectScreenState();
}

class _TierSelectScreenState extends ConsumerState<TierSelectScreen> {
  String? userTier;
  int stakeMin = 0;
  int stakeMax = 0;
  int calloutMax = 0;
  String? tierError;
  
  int? selectedMatchStake;
  int? selectedCalloutStake;
  String? _selectedStake;
  bool isLoadingLimits = true;

  String _formatNaira(int minorUnits) {
    final format = NumberFormat.currency(symbol: '₦', decimalDigits: 0);
    return format.format(minorUnits / 100);
  }

  @override
  void initState() {
    super.initState();
    _fetchTierLimits();
    ref.read(profileProvider.notifier).load();
  }

  Future<void> _fetchTierLimits() async {
    try {
      final dio = ref.read(apiClientProvider);
      final res = await dio.get('/wallet/tier-limits');
      
      if (res.statusCode == 200) {
        setState(() {
          userTier = res.data['tier'];
          stakeMin = int.tryParse(res.data['stakeMin'].toString()) ?? 0;
          stakeMax = int.tryParse(res.data['stakeMax'].toString()) ?? 0;
          calloutMax = int.tryParse(res.data['calloutMax'].toString()) ?? 0;
          tierError = null;
          isLoadingLimits = false;
        });

        if (userTier != 'AMATEUR') {
          ref.read(matchProvider.notifier).fetchOpenCallouts();
        }
      }
    } catch (e) {
      setState(() {
        tierError = 'Failed to load lobby. Tap to retry.';
        isLoadingLimits = false;
      });
    }
  }

  void _showCalloutDialog(BuildContext context) {
    showDialog(
      context: context,
      builder: (context) {
        int tempStake = selectedCalloutStake ?? stakeMin;
        return StatefulBuilder(
          builder: (context, setDialogState) {
            return AlertDialog(
              backgroundColor: AppColors.surface1,
              title: const Text('Create Call-out', style: TextStyle(color: AppColors.textMain)),
              content: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Text(
                    'Set your call-out stake. Valid up to your tier maximum.',
                    style: TextStyle(color: AppColors.textMuted),
                  ),
                  const SizedBox(height: 16),
                  Text(
                    'Stake: ${_formatNaira(tempStake)}',
                    style: const TextStyle(color: AppColors.textMain, fontSize: 18),
                  ),
                  Slider(
                    value: tempStake.toDouble(),
                    min: stakeMin.toDouble(),
                    max: calloutMax.toDouble(),
                    divisions: calloutMax > stakeMin ? 10 : 1,
                    activeColor: TierTheme.forTier(userTier!).primaryColor,
                    onChanged: (val) {
                      setDialogState(() {
                        tempStake = val.toInt();
                      });
                    },
                  ),
                ],
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('Cancel', style: TextStyle(color: AppColors.textMuted)),
                ),
                ElevatedButton(
                  style: ElevatedButton.styleFrom(
                    backgroundColor: TierTheme.forTier(userTier!).primaryColor,
                  ),
                  onPressed: () {
                    setState(() => selectedCalloutStake = tempStake);
                    ref.read(matchProvider.notifier).createCallout(userTier!, tempStake);
                    Navigator.pop(context);
                  },
                  child: const Text('Create Call-out', style: TextStyle(color: AppColors.textMain)),
                ),
              ],
            );
          },
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final matchState = ref.watch(matchProvider);

    // Hop to the active match once one is found.
    ref.listen(matchProvider, (previous, next) {
      if (previous?.currentMatchId == null && next.currentMatchId != null) {
        context.go('/match/${next.currentMatchId}');
      }
    });

    if (matchState.isFindingMatch) {
      return Scaffold(
        backgroundColor: AppColors.voidBg,
        body: Center(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const CircularProgressIndicator(),
              const SizedBox(height: 20),
              const Text('Searching for opponent...', style: TextStyle(color: AppColors.textMain)),
              const SizedBox(height: 20),
              ElevatedButton(
                style: ElevatedButton.styleFrom(backgroundColor: AppColors.surface3),
                onPressed: () {
                  if (userTier != null && selectedMatchStake != null) {
                    ref.read(matchProvider.notifier).leaveQueue(userTier!, selectedMatchStake!);
                  }
                },
                child: const Text('Cancel Search', style: TextStyle(color: AppColors.textMain)),
              )
            ],
          ),
        ),
      );
    }

    if (isLoadingLimits || (userTier == null && tierError == null)) {
      return const Scaffold(
        backgroundColor: AppColors.voidBg,
        body: Center(child: CircularProgressIndicator()),
      );
    }

    if (tierError != null) {
      return Scaffold(
        backgroundColor: AppColors.voidBg,
        body: Center(
          child: GestureDetector(
            onTap: () {
              setState(() {
                tierError = null;
                isLoadingLimits = true;
              });
              _fetchTierLimits();
            },
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(LucideIcons.alertTriangle, color: AppColors.danger, size: 48),
                const SizedBox(height: 16),
                Text(tierError!, style: AppTypography.bodyLarge),
              ],
            ),
          ),
        ),
      );
    }

    final theme = TierTheme.forTier(userTier!);
    final isAmateur = userTier == 'AMATEUR';

    return Scaffold(
      backgroundColor: AppColors.voidBg,
      appBar: AppBar(
        toolbarHeight: 64,
        backgroundColor: AppColors.voidBg,
        titleSpacing: 16,
        title: const LobbyHeader(),
        actions: const [
          NotificationBell(),
          SizedBox(width: 8),
        ],
      ),
      body: SafeArea(
        child: LayoutBuilder(
          builder: (context, constraints) {
            final contentMaxWidth =
                constraints.maxWidth > 640 ? 640.0 : constraints.maxWidth;
            return Center(
              child: ConstrainedBox(
                constraints: BoxConstraints(maxWidth: contentMaxWidth),
                child: CustomScrollView(
                  slivers: [
                    SliverPadding(
                      padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
                      sliver: SliverList(
                        delegate: SliverChildListDelegate([
                          // Balance + Add Money.
                          const BalanceCard(),
                          const SizedBox(height: 12),
                          // Jump-straight-into-a-match card.
                          Container(
                            padding: const EdgeInsets.symmetric(
                                horizontal: 16, vertical: 12),
                            decoration: BoxDecoration(
                              color: AppColors.brandDeep,
                              borderRadius: BorderRadius.circular(14),
                            ),
                            child: Row(
                              children: [
                                SvgPicture.asset(
                                  'assets/icons/find_match.svg',
                                  width: 28,
                                  height: 28,
                                ),
                                const SizedBox(width: 14),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.center,
                                    children: [
                                      Text(
                                        'FIND A MATCH',
                                        style: GoogleFonts.inter(
                                          fontSize: 18,
                                          fontWeight: FontWeight.w700,
                                          letterSpacing: 1.2,
                                          color: AppColors.textPrimary,
                                        ),
                                      ),
                                      const SizedBox(height: 2),
                                      Text(
                                        'Start a new match',
                                        style: GoogleFonts.sora(
                                          fontSize: 14,
                                          fontWeight: FontWeight.w500,
                                          color: AppColors.textSecondary,
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                                SvgPicture.asset(
                                  'assets/icons/find_match_right.svg',
                                  width: 24,
                                  height: 24,
                                ),
                              ],
                            ),
                          ),
                          const SizedBox(height: 24),
                          Text(
                            'Quick Match',
                            style: GoogleFonts.sora(
                              fontSize: 20,
                              fontWeight: FontWeight.w700,
                              color: AppColors.textPrimary,
                            ),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            'Choose your stake',
                            style: GoogleFonts.inter(
                              fontSize: 13,
                              color: AppColors.textMuted,
                            ),
                          ),
                          const SizedBox(height: 14),
                          Row(
                            children: [
                              Expanded(
                                  child: _StakeCard(
                                amount: '500',
                                selected: _selectedStake == '500',
                                onTap: () => setState(
                                    () => _selectedStake = '500'),
                              )),
                              const SizedBox(width: 8),
                              Expanded(
                                  child: _StakeCard(
                                amount: '1k',
                                selected: _selectedStake == '1k',
                                onTap: () =>
                                    setState(() => _selectedStake = '1k'),
                              )),
                              const SizedBox(width: 8),
                              Expanded(
                                  child: _StakeCard(
                                amount: '2k',
                                selected: _selectedStake == '2k',
                                onTap: () =>
                                    setState(() => _selectedStake = '2k'),
                              )),
                              const SizedBox(width: 8),
                              Expanded(
                                  child: _StakeCard(
                                amount: '5k',
                                selected: _selectedStake == '5k',
                                onTap: () =>
                                    setState(() => _selectedStake = '5k'),
                              )),
                            ],
                          ),
                          const SizedBox(height: 12),
                          Row(
                            mainAxisAlignment:
                                MainAxisAlignment.spaceBetween,
                            children: [
                              Row(
                                children: [
                                  Text(
                                    'or filter',
                                    style: GoogleFonts.inter(
                                      fontSize: 13,
                                      color: AppColors.textPrimary,
                                    ),
                                  ),
                                  const SizedBox(width: 4),
                                  Text(
                                    '>',
                                    style: GoogleFonts.inter(
                                      fontSize: 13,
                                      fontWeight: FontWeight.w700,
                                      color: AppColors.brand,
                                    ),
                                  ),
                                  const SizedBox(width: 2),
                                  Text(
                                    'Classic',
                                    style: GoogleFonts.inter(
                                      fontSize: 13,
                                      fontWeight: FontWeight.w600,
                                      color: AppColors.brand,
                                    ),
                                  ),
                                ],
                              ),
                              GestureDetector(
                                onTap: () {},
                                child: Container(
                                  padding: const EdgeInsets.symmetric(
                                      horizontal: 16, vertical: 10),
                                  decoration: BoxDecoration(
                                    color: AppColors.brandDeep,
                                    borderRadius: BorderRadius.circular(12),
                                  ),
                                  child: Text(
                                    'Find Opponent',
                                    style: GoogleFonts.inter(
                                      fontSize: 14,
                                      fontWeight: FontWeight.w600,
                                      color: AppColors.textPrimary,
                                    ),
                                  ),
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 20),
                        ]),
                      ),
                    ),
                    const SliverPadding(padding: EdgeInsets.only(top: 24)),
                    // Call-outs for everyone above Amateur.
                    if (!isAmateur) ...[
                      SliverPadding(
                        padding: const EdgeInsets.symmetric(horizontal: 16),
                        sliver: SliverToBoxAdapter(
                          child: Row(
                            mainAxisAlignment:
                                MainAxisAlignment.spaceBetween,
                            children: [
                              Flexible(
                                child: Text(
                                  'Open Call-outs',
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(
                                      color: AppColors.textMain,
                                      fontSize: 20,
                                      fontWeight: FontWeight.bold),
                                ),
                              ),
                              TextButton.icon(
                                onPressed: () =>
                                    _showCalloutDialog(context),
                                icon: Icon(LucideIcons.plus,
                                    color: theme.primaryColor, size: 16),
                                label: Text('Create Call-out',
                                    style: TextStyle(
                                        color: theme.primaryColor)),
                              ),
                            ],
                          ),
                        ),
                      ),
                      const SliverPadding(padding: EdgeInsets.only(top: 8)),
                      SliverPadding(
                        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
                        sliver: matchState.openCallouts.isEmpty
                            ? SliverToBoxAdapter(
                                child: Padding(
                                  padding: const EdgeInsets.symmetric(
                                      vertical: 32),
                                  child: Center(
                                    child: Text(
                                      'No open call-outs in your tier.',
                                      textAlign: TextAlign.center,
                                      style: const TextStyle(
                                          color: AppColors.textMuted),
                                    ),
                                  ),
                                ),
                              )
                            : SliverList.builder(
                                itemCount: matchState.openCallouts.length,
                                itemBuilder: (context, index) {
                                  final callout =
                                      matchState.openCallouts[index];
                                  // Only show ones that haven't expired yet.
                                  if (callout.expiresAt
                                      .isBefore(DateTime.now())) {
                                    return const SizedBox.shrink();
                                  }
                                  return CalloutCard(
                                    callout: callout,
                                    tierCalloutMax: calloutMax,
                                    onAccept: () {
                                      ref
                                          .read(matchProvider.notifier)
                                          .acceptCallout(callout.id);
                                    },
                                  );
                                },
                              ),
                      ),
                    ],
                    if (isAmateur)
                      SliverFillRemaining(
                        hasScrollBody: false,
                        child: Padding(
                          padding: const EdgeInsets.all(24),
                          child: Center(
                            child: Text(
                              'Call-outs are only available for Master and Pro tiers.',
                              textAlign: TextAlign.center,
                              style: const TextStyle(
                                  color: AppColors.textMuted),
                            ),
                          ),
                        ),
                      ),
                    const SliverPadding(padding: EdgeInsets.only(bottom: 24)),
                  ],
                ),
              ),
            );
          },
        ),
      ),
    );
  }
}

class _StakeCard extends StatelessWidget {
  const _StakeCard({
    required this.amount,
    required this.selected,
    required this.onTap,
  });

  final String amount;
  final bool selected;
  final VoidCallback onTap;

  static const Color _black = AppColors.voidBg;

  @override
  Widget build(BuildContext context) {
    final color = selected ? _black : AppColors.textPrimary;
    return GestureDetector(
      onTap: onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 200),
        padding: const EdgeInsets.symmetric(vertical: 10),
        decoration: BoxDecoration(
          color: selected ? AppColors.brand : _black,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(
            color: selected ? AppColors.brand : AppColors.hairline,
            width: 1,
          ),
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.baseline,
          textBaseline: TextBaseline.alphabetic,
          children: [
            Text(
              '₦',
              style: GoogleFonts.inter(
                fontSize: 12,
                fontWeight: FontWeight.w700,
                color: color,
              ),
            ),
            const SizedBox(width: 1),
            Text(
              amount,
              style: GoogleFonts.inter(
                fontSize: 15,
                fontWeight: FontWeight.w700,
                color: color,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
