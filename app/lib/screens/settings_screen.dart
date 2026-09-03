import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:package_info_plus/package_info_plus.dart';
import '../providers/auth_provider.dart';
import '../services/api_client.dart';
import '../services/secure_storage.dart';
import '../theme/colors.dart';
import '../theme/typography.dart';

class SettingsScreen extends ConsumerStatefulWidget {
  const SettingsScreen({Key? key}) : super(key: key);

  @override
  ConsumerState<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends ConsumerState<SettingsScreen> {
  final SecureStorageService _storage = SecureStorageService();
  String _version = '';
  bool _pushEnabled = true;
  bool _soundEnabled = true;
  bool _loadedPrefs = false;

  // Account info
  String? _email;
  String? _tier;

  @override
  void initState() {
    super.initState();
    _loadPrefs();
    _loadVersion();
    _loadProfile();
  }

  Future<void> _loadPrefs() async {
    try {
      final push = await _storage.read(key: 'pref_push_notifications');
      final sound = await _storage.read(key: 'pref_sound');
      if (!mounted) return;
      setState(() {
        _pushEnabled = push == null ? true : push == 'true';
        _soundEnabled = sound == null ? true : sound == 'true';
        _loadedPrefs = true;
      });
    } catch (_) {
      if (mounted) setState(() => _loadedPrefs = true);
    }
  }

  Future<void> _loadVersion() async {
    final info = await PackageInfo.fromPlatform();
    if (mounted) setState(() => _version = '${info.version} (${info.buildNumber})');
  }

  Future<void> _loadProfile() async {
    try {
      final token = await _storage.accessToken;
      if (token == null) return;
      final dio = ref.read(apiClientProvider);
      final res = await dio.get('/auth/me');
      if (res.statusCode == 200 && res.data is Map && mounted) {
        final data = Map<String, dynamic>.from(res.data);
        setState(() {
          _email = data['email'] as String?;
          _tier = data['tier'] as String?;
        });
      }
    } catch (_) {
      // Keep account section minimal if the call fails.
    }
  }

  Future<void> _togglePush(bool value) async {
    setState(() => _pushEnabled = value);
    await _storage.write(key: 'pref_push_notifications', value: value.toString());
  }

  Future<void> _toggleSound(bool value) async {
    setState(() => _soundEnabled = value);
    await _storage.write(key: 'pref_sound', value: value.toString());
  }

  String get _tierLabel => switch (_tier) {
        'MASTER' => 'Master',
        'PRO' => 'Pro',
        _ => 'Amateur',
      };

  Color get _tierColor => switch (_tier) {
        'MASTER' => AppColors.tierMaster,
        'PRO' => AppColors.tierPro,
        _ => AppColors.tierAmateur,
      };

  Future<void> _confirmLogout() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: AppColors.surface1,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        title: const Text(
          'Log out?',
          style: TextStyle(color: AppColors.textPrimary),
        ),
        content: const Text(
          'You will need to sign in again to play for money.',
          style: TextStyle(color: AppColors.textSecondary),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel', style: TextStyle(color: AppColors.textSecondary)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Log out', style: TextStyle(color: AppColors.danger)),
          ),
        ],
      ),
    );
    if (confirmed == true) {
      await ref.read(authProvider.notifier).logout();
      if (mounted) context.go('/login');
    }
  }

  void _showLegalDoc(String title, String body) {
    showModalBottomSheet(
      context: context,
      backgroundColor: AppColors.surface1,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (context) => DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.85,
        maxChildSize: 0.95,
        builder: (context, scrollController) => Column(
          children: [
            Padding(
              padding: const EdgeInsets.all(16),
              child: Row(
                children: [
                  Text(title, style: AppTypography.heading3),
                  const Spacer(),
                  IconButton(
                    onPressed: () => Navigator.pop(context),
                    icon: const Icon(LucideIcons.x, color: AppColors.textMuted),
                  ),
                ],
              ),
            ),
            const Divider(color: AppColors.borderDim),
            Expanded(
              child: Scrollbar(
                controller: scrollController,
                child: SingleChildScrollView(
                  controller: scrollController,
                  padding: const EdgeInsets.fromLTRB(24, 16, 24, 32),
                  child: Text(body, style: AppTypography.bodyLarge),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _sectionLabel(String label) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 24, 4, 8),
      child: Text(label, style: AppTypography.labelMuted),
    );
  }

  Widget _tile({
    required IconData icon,
    required String title,
    String? subtitle,
    Widget? trailing,
    VoidCallback? onTap,
    Color iconColor = AppColors.textSecondary,
  }) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(12),
      child: Ink(
        color: AppColors.surface1,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
        child: Row(
          children: [
            Icon(icon, color: iconColor, size: 22),
            const SizedBox(width: 16),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: AppTypography.bodyLarge),
                  if (subtitle != null) ...[
                    const SizedBox(height: 2),
                    Text(subtitle, style: AppTypography.bodySmall),
                  ],
                ],
              ),
            ),
            if (trailing != null) trailing,
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.voidBg,
      appBar: AppBar(
        title: const Text('Settings'),
        backgroundColor: AppColors.voidBg,
        elevation: 0,
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          children: [
            Text('Account', style: AppTypography.heading3),
            const SizedBox(height: 12),
            _tile(
              icon: LucideIcons.user,
              title: _email ?? 'Signed in',
              subtitle: 'Email',
              trailing: Text(
                _tierLabel,
                style: AppTypography.labelBold.copyWith(color: _tierColor),
              ),
            ),
            _sectionLabel('Notifications'),
            if (_loadedPrefs) ...[
              _tile(
                icon: LucideIcons.bell,
                title: 'Push notifications',
                subtitle: 'Match, wallet and result alerts',
                trailing: Switch(
                  value: _pushEnabled,
                  onChanged: _togglePush,
                  activeThumbColor: AppColors.gold500,
                  inactiveThumbColor: AppColors.textMuted,
                  inactiveTrackColor: AppColors.surface3,
                ),
              ),
              const SizedBox(height: 8),
              _tile(
                icon: LucideIcons.volume2,
                title: 'Sound',
                subtitle: 'Play sounds for alerts',
                trailing: Switch(
                  value: _soundEnabled,
                  onChanged: _toggleSound,
                  activeThumbColor: AppColors.gold500,
                  inactiveThumbColor: AppColors.textMuted,
                  inactiveTrackColor: AppColors.surface3,
                ),
              ),
            ],
            _sectionLabel('Legal'),
            _tile(
              icon: LucideIcons.scrollText,
              title: 'Terms of Service',
              trailing: const Icon(LucideIcons.chevronRight, color: AppColors.textMuted),
              onTap: () => _showLegalDoc('Terms of Service', _termsBody),
            ),
            const SizedBox(height: 8),
            _tile(
              icon: LucideIcons.shieldCheck,
              title: 'Privacy Policy',
              trailing: const Icon(LucideIcons.chevronRight, color: AppColors.textMuted),
              onTap: () => _showLegalDoc('Privacy Policy', _privacyBody),
            ),
            _sectionLabel('About'),
            _tile(
              icon: LucideIcons.info,
              title: 'Version',
              subtitle: _version.isEmpty ? 'Loading…' : _version,
            ),
            const SizedBox(height: 32),
            InkWell(
              onTap: _confirmLogout,
              borderRadius: BorderRadius.circular(12),
              child: Ink(
                color: AppColors.surface1,
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
                child: Row(
                  children: [
                    const Icon(LucideIcons.logOut, color: AppColors.danger, size: 22),
                    const SizedBox(width: 16),
                    Text('Log out', style: AppTypography.bodyLarge.copyWith(color: AppColors.danger)),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 32),
          ],
        ),
      ),
    );
  }
}

// Legal copy — placeholder prose to be finalized by the client before submission.
const _termsBody = '''
Terms of Service

Draught Bet is a skill-based game. Results are determined by player decisions, not chance.

1. Eligibility
You must be at least 18 years old and resident in a jurisdiction where real-money skill gaming is permitted.

2. Fair Play
All moves are server-verified. Attempting to manipulate match outcomes is prohibited and will result in forfeiture of balance and account suspension.

3. Payments
Deposits and withdrawals are processed through licensed payment gateways. Withdrawals are subject to review and may require verification.

4. Termination
We may suspend accounts that violate these terms. You may request account closure at any time.

Placeholder copy — final legal review required.
''';

const _privacyBody = '''
Privacy Policy

Draught Bet collects only the information needed to operate the service securely: account credentials (used solely for authentication), device identifiers for fraud protection, and transaction records required by law.

Personal data is encrypted in transit and at rest. We do not sell personal data.

You may request a copy or deletion of your data by contacting support.

Placeholder copy — final legal review required.
''';