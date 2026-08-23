import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../screens/tier_select_screen.dart';
import '../screens/match_screen.dart';
import '../screens/wallet_screen.dart';
import '../screens/checkout_webview_screen.dart';
import '../widgets/main_layout.dart';

final appRouterProvider = Provider<GoRouter>((ref) {
  return GoRouter(
    initialLocation: '/login',
    routes: [
      GoRoute(
        path: '/login',
        builder: (context, state) => const Scaffold(
          body: Center(child: Text('Login Screen Stub')),
        ),
      ),
      GoRoute(
        path: '/register',
        builder: (context, state) => const Scaffold(
          body: Center(child: Text('Register Screen Stub')),
        ),
      ),
      ShellRoute(
        builder: (context, state, child) {
          return MainLayout(child: child);
        },
        routes: [
          GoRoute(
            path: '/home',
            builder: (context, state) => const TierSelectScreen(),
          ),
          GoRoute(
            path: '/wallet',
            builder: (context, state) => const WalletScreen(),
          ),
          GoRoute(
            path: '/results',
            builder: (context, state) => const Scaffold(
              body: Center(child: Text('Results Stub')),
            ),
          ),
          GoRoute(
            path: '/settings',
            builder: (context, state) => const Scaffold(
              body: Center(child: Text('Settings Stub')),
            ),
          ),
        ],
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
