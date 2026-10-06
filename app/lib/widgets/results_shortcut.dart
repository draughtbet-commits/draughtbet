import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../theme/colors.dart';

class ResultsShortcut extends StatelessWidget {
  const ResultsShortcut({super.key});

  @override
  Widget build(BuildContext context) {
    return IconButton(
      icon: const Icon(LucideIcons.trophy, color: AppColors.textMain),
      tooltip: 'Match results',
      onPressed: () => context.go('/results'),
    );
  }
}