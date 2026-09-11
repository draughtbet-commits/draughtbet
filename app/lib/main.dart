import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'router/app_router.dart';
import 'theme/app_theme.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Load environment variables (will fail if .env is missing, which is expected before setup)
  try {
    await dotenv.load(fileName: ".env");
  } catch (e) {
    debugPrint("No .env file found. Proceeding with default config.");
  }

  runApp(const ProviderScope(child: DraughtsArenaApp()));
}

class DraughtsArenaApp extends ConsumerWidget {
  const DraughtsArenaApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final router = ref.watch(appRouterProvider);

    return MaterialApp.router(
      title: 'Draught Bet',
      themeMode: ThemeMode.dark, // Enforce Dark Mode First
      darkTheme: AppTheme.dark,
      routerConfig: router,
    );
  }
}
