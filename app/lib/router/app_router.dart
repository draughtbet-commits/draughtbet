import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../screens/tier_select_screen.dart';
import '../screens/match_screen.dart';

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
      GoRoute(
        path: '/home',
        builder: (context, state) => const Scaffold(
          body: Center(child: Text('Home Screen Stub')),
        ),
      ),
      GoRoute(
        path: '/tier-select',
        builder: (context, state) => const TierSelectScreen(),
      ),
      GoRoute(
        path: '/match/:id',
        builder: (context, state) {
          final matchId = state.pathParameters['id']!;
          return MatchScreen(matchId: matchId);
        },
      ),
      GoRoute(
        path: '/wallet',
        builder: (context, state) => const Scaffold(
          body: Center(child: Text('Wallet / Webview Stub')),
        ),
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
  );
});
