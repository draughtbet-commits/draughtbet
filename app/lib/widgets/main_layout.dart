import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../theme/colors.dart';

class MainLayout extends StatefulWidget {
  final Widget child;

  const MainLayout({super.key, required this.child});

  @override
  State<MainLayout> createState() => _MainLayoutState();
}

class _MainLayoutState extends State<MainLayout> {
  int _calculateSelectedIndex(BuildContext context) {
    final String location = GoRouterState.of(context).matchedLocation;
    if (location.startsWith('/home')) return 0;
    if (location.startsWith('/arena')) return 1;
    if (location.startsWith('/crown')) return 2;
    if (location.startsWith('/wallet')) return 3;
    if (location.startsWith('/profile')) return 4;
    return 0;
  }

  void _onItemTapped(int index, BuildContext context) {
    switch (index) {
      case 0:
        context.go('/home');
        break;
      case 1:
        context.go('/arena');
        break;
      case 2:
        context.go('/crown');
        break;
      case 3:
        context.go('/wallet');
        break;
      case 4:
        context.go('/profile');
        break;
    }
  }

  @override
  Widget build(BuildContext context) {
    final int currentIndex = _calculateSelectedIndex(context);

    return Scaffold(
      backgroundColor: AppColors.voidBg,
      body: widget.child,
      bottomNavigationBar: ClipRect(
        child: Transform.scale(
          scaleY: 0.85,
          alignment: Alignment.bottomCenter,
          child: BottomNavigationBar(
            backgroundColor: AppColors.surface1,
        currentIndex: currentIndex,
        onTap: (index) => _onItemTapped(index, context),
        type: BottomNavigationBarType.fixed,
        selectedItemColor: AppColors.brand,
        unselectedItemColor: AppColors.textMuted,
        items: const [
          BottomNavigationBarItem(
            icon: Icon(LucideIcons.home),
            label: 'Home',
          ),
          BottomNavigationBarItem(
            icon: Icon(LucideIcons.swords),
            label: 'Arena',
          ),
          const BottomNavigationBarItem(
            icon: _CrownIcon(),
            label: '',
          ),
          BottomNavigationBarItem(
            icon: Icon(LucideIcons.wallet),
            label: 'Wallet',
          ),
          BottomNavigationBarItem(
            icon: Icon(LucideIcons.user),
            label: 'Profile',
          ),
        ],
          ),
        ),
      ),
    );
  }
}

class _CrownIcon extends StatelessWidget {
  const _CrownIcon();

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 64,
      height: 64,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: AppColors.voidBg,
        border: Border.all(color: AppColors.brand, width: 3),
        boxShadow: [
          BoxShadow(
            color: AppColors.brand.withValues(alpha: 0.35),
            blurRadius: 6,
          ),
        ],
      ),
      child: const Icon(LucideIcons.crown, size: 36, color: AppColors.textPrimary),
    );
  }
}
