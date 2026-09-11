import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../providers/auth_provider.dart';
import '../screens/login_screen.dart';
import '../screens/register_screen.dart';
import '../screens/landing_page.dart';
import '../screens/home_lobby_screen.dart';
import '../screens/match_screen.dart';
import '../screens/arena_screen.dart';
import '../screens/create_match_screen.dart';
import '../screens/match_confirmation_screen.dart';
import '../screens/matchmaking_screen.dart';
import '../screens/match_room_screen.dart';
import '../screens/match_result_screen.dart';
import '../models/match_flow.dart';
import '../screens/crown_screen.dart';
import '../screens/wallet_screen.dart';
import '../screens/checkout_webview_screen.dart';
import '../screens/settings_screen.dart';
import '../screens/results_screen.dart';
import '../widgets/main_layout.dart';

final appRouterProvider = Provider<GoRouter>((ref) {
  final refresh = ValueNotifier<bool>(false);
  ref.listen<AuthState>(
    authProvider,
    (previous, next) => refresh.value = !refresh.value,
  );
  ref.onDispose(refresh.dispose);

  return GoRouter(
    initialLocation: LandingPage.route,
    refreshListenable: refresh,
    redirect: (context, state) {
      final isLoggedIn = ref.read(authProvider).isAuthenticated;
      final location = state.matchedLocation;
      final isAuthRoute = location == '/login' || location == '/register';
      final isPublicRoute = location == LandingPage.route;

      // Authenticated users never see onboarding or the auth forms.
      if (isLoggedIn) return (isAuthRoute || isPublicRoute) ? '/home' : null;
      if (isPublicRoute) return null; // logged-out users start on the landing
      if (!isAuthRoute) return '/login';
      return null;
    },
    routes: [
      GoRoute(
        path: LandingPage.route,
        builder: (context, state) => const LandingPage(),
      ),
      GoRoute(path: '/login', builder: (context, state) => const LoginScreen()),
      GoRoute(
        path: '/register',
        builder: (context, state) => const RegisterScreen(),
      ),
      ShellRoute(
        builder: (context, state, child) {
          return MainLayout(child: child);
        },
        routes: [
          GoRoute(
            path: '/home',
            builder: (context, state) => const HomeLobbyScreen(),
          ),
          GoRoute(
            path: '/crown',
            builder: (context, state) => const CrownScreen(),
          ),
          GoRoute(
            path: '/wallet',
            builder: (context, state) => const WalletScreen(),
          ),
          GoRoute(
            path: '/arena',
            builder: (context, state) => const ArenaScreen(),
          ),
          GoRoute(
            path: '/results',
            builder: (context, state) => const ResultsScreen(),
          ),
          GoRoute(
            path: '/profile',
            builder: (context, state) => const SettingsScreen(),
          ),
        ],
      ),
      GoRoute(
        path: '/play/create',
        builder: (context, state) => const CreateMatchScreen(),
      ),
      GoRoute(
        path: '/play/confirm',
        builder: (context, state) => const MatchConfirmationScreen(),
      ),
      GoRoute(
        path: '/play/search',
        builder: (context, state) => const MatchmakingScreen(),
      ),
      GoRoute(
        path: '/play/room/:id',
        builder: (context, state) =>
            MatchRoomScreen(matchId: state.pathParameters['id']!),
      ),
      GoRoute(
        path: '/play/result',
        redirect: (context, state) =>
            state.extra is MatchResultViewData ? null : '/home',
        builder: (context, state) =>
            MatchResultScreen(result: state.extra! as MatchResultViewData),
      ),
      GoRoute(
        path: '/match/:id',
        builder: (context, state) {
          final matchId = state.pathParameters['id']!;
          return MatchScreen(matchId: matchId);
        },
      ),
      GoRoute(
        path: '/checkout',
        builder: (context, state) {
          final url = state.extra as String;
          return CheckoutWebviewScreen(authorizationUrl: url);
        },
      ),
    ],
  );
});
