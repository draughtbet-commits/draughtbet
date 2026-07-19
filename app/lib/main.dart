import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'router/app_router.dart';

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
      title: 'Draughts Arena',
      themeMode: ThemeMode.dark, // Enforce Dark Mode First
      darkTheme: ThemeData(
        brightness: Brightness.dark,
        scaffoldBackgroundColor: const Color(0xFF0B0D10), // 'void' background
        primaryColor: const Color(0xFFE7B24A), // Gold motif
        colorScheme: const ColorScheme.dark(
          primary: Color(0xFFE7B24A),
          surface: Color(0xFF161920),
          background: Color(0xFF0B0D10),
        ),
        textTheme: TextTheme(
          displayLarge: GoogleFonts.fraunces(fontSize: 32, fontWeight: FontWeight.bold),
          bodyLarge: GoogleFonts.manrope(fontSize: 16),
          bodyMedium: GoogleFonts.manrope(fontSize: 14),
        ),
      ),
      routerConfig: router,
    );
  }
}
