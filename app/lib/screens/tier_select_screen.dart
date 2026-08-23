import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'package:intl/intl.dart';
import '../providers/match_provider.dart';
import '../theme/colors.dart';
import '../theme/tier_theme.dart';
import '../widgets/callout_card.dart';
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
  
  int? selectedMatchStake;
  int? selectedCalloutStake;
  bool isLoadingLimits = true;

  String _formatNaira(int minorUnits) {
    final format = NumberFormat.currency(symbol: '₦', decimalDigits: 0);
    return format.format(minorUnits / 100);
  }

  @override
  void initState() {
    super.initState();
    _fetchTierLimits();
  }

  Future<void> _fetchTierLimits() async {
    try {
      final storage = const FlutterSecureStorage();
      final token = await storage.read(key: 'jwt');
      final backendUrl = dotenv.env['BACKEND_URL'] ?? 'http://localhost:3000';
      final dio = Dio();
      
      final res = await dio.get(
        '$backendUrl/wallet/tier-limits',
        options: Options(headers: {'Authorization': 'Bearer $token'}),
      );
      
      if (res.statusCode == 200) {
        setState(() {
          userTier = res.data['tier'];
          stakeMin = int.tryParse(res.data['stakeMin'].toString()) ?? 0;
          stakeMax = int.tryParse(res.data['stakeMax'].toString()) ?? 0;
          calloutMax = int.tryParse(res.data['calloutMax'].toString()) ?? 0;
          
          selectedMatchStake = stakeMax;
          selectedCalloutStake = stakeMin;
          isLoadingLimits = false;
        });

        if (userTier != 'AMATEUR') {
          ref.read(matchProvider.notifier).fetchOpenCallouts();
        }
      }
    } catch (e) {
      print('Failed to fetch tier limits: $e');
      setState(() => isLoadingLimits = false);
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

    // Watch for match found and redirect
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

    if (isLoadingLimits || userTier == null) {
      return const Scaffold(
        backgroundColor: AppColors.voidBg,
        body: Center(child: CircularProgressIndicator()),
      );
    }

    final theme = TierTheme.forTier(userTier!);
    final isAmateur = userTier == 'AMATEUR';

    return Scaffold(
      backgroundColor: AppColors.voidBg,
      appBar: AppBar(
        title: const Text('Lobby'), 
        backgroundColor: AppColors.voidBg,
        actions: const [
          NotificationBell(),
          SizedBox(width: 8),
        ],
      ),
      body: Padding(
        padding: const EdgeInsets.all(16.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Standard Matchmaking Section
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: AppColors.surface1,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    '${theme.displayName} Tier',
                    style: TextStyle(color: theme.primaryColor, fontSize: 24, fontWeight: FontWeight.bold),
                  ),
                  const SizedBox(height: 8),
                  Text('Stake: ${_formatNaira(selectedMatchStake ?? stakeMin)}', style: const TextStyle(color: AppColors.textMuted)),
                  Slider(
                    value: (selectedMatchStake ?? stakeMin).toDouble(),
                    min: stakeMin.toDouble(),
                    max: stakeMax.toDouble(),
                    divisions: stakeMax > stakeMin ? 10 : 1,
                    activeColor: theme.primaryColor,
                    onChanged: (val) {
                      setState(() {
                        selectedMatchStake = val.toInt();
                      });
                    },
                  ),
                  const SizedBox(height: 16),
                  ElevatedButton(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: theme.primaryColor,
                      padding: const EdgeInsets.symmetric(vertical: 16),
                    ),
                    onPressed: () {
                      if (selectedMatchStake != null) {
                        ref.read(matchProvider.notifier).joinQueue(userTier!, selectedMatchStake!);
                      }
                    },
                    child: Text('Find ${theme.displayName} Match', style: const TextStyle(color: AppColors.textMain, fontSize: 16)),
                  ),
                ],
              ),
            ),
            
            const SizedBox(height: 24),
            
            // Callouts Section
            if (!isAmateur) ...[
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  const Text(
                    'Open Call-outs',
                    style: TextStyle(color: AppColors.textMain, fontSize: 20, fontWeight: FontWeight.bold),
                  ),
                  TextButton.icon(
                    onPressed: () => _showCalloutDialog(context),
                    icon: Icon(LucideIcons.plus, color: theme.primaryColor),
                    label: Text('Create Call-out', style: TextStyle(color: theme.primaryColor)),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Expanded(
                child: matchState.openCallouts.isEmpty
                    ? const Center(
                        child: Text(
                          'No open call-outs in your tier.',
                          style: TextStyle(color: AppColors.textMuted),
                        ),
                      )
                    : ListView.builder(
                        itemCount: matchState.openCallouts.length,
                        itemBuilder: (context, index) {
                          final callout = matchState.openCallouts[index];
                          // Do not show callouts that are already expired in the list
                          if (callout.expiresAt.isBefore(DateTime.now())) {
                            return const SizedBox.shrink();
                          }
                          return CalloutCard(
                            callout: callout,
                            tierCalloutMax: calloutMax,
                            onAccept: () {
                              ref.read(matchProvider.notifier).acceptCallout(callout.id);
                            },
                          );
                        },
                      ),
              ),
            ],
            if (isAmateur)
              const Expanded(
                child: Center(
                  child: Text(
                    'Call-outs are only available for Master and Pro tiers.',
                    style: TextStyle(color: AppColors.textMuted),
                  ),
                ),
              )
          ],
        ),
      ),
    );
  }
}
