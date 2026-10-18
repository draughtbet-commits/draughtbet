import '../models/match_flow.dart';

/// The pre-play screen that corresponds to a lifecycle phase.
///
/// Shared by the Home active-match card and the room screen's Enter Match so
/// both resolve a match the same way. A match is only routed to the board when
/// the server says it is actually `IN_PLAY`: entering a funded-but-not-started
/// match lands on a board that does not exist yet, which can only render as
/// "Reconnecting" forever.
String lifecyclePhaseRoute(MatchLifecycleSnapshot snapshot) {
  final matchId = snapshot.matchId;
  return switch (snapshot.phase) {
    MatchLifecyclePhase.inPlay =>
      matchId == null || matchId.isEmpty ? '/home' : '/match/$matchId',
    MatchLifecyclePhase.readyCheck => '/play/ready',
    MatchLifecyclePhase.privateRoom => '/play/private-room',
    MatchLifecyclePhase.waitingOpponentReady => '/play/waiting-ready',
    MatchLifecyclePhase.waitingOpponentStake => '/play/waiting-stake',
    MatchLifecyclePhase.readyTimeout => '/play/ready-timeout',
    MatchLifecyclePhase.opponentDisconnected => '/play/disconnected-before-start',
    MatchLifecyclePhase.challengeSent ||
    MatchLifecyclePhase.incomingChallenge ||
    MatchLifecyclePhase.challengeExpired =>
      '/play/challenge',
    MatchLifecyclePhase.unavailable => '/arena',
    _ => matchId == null || matchId.isEmpty ? '/home' : '/match/$matchId',
  };
}

/// Whether [route] is the board rather than one of the pre-play lifecycle
/// screens. Callers that must seat the player before navigating use this to
/// avoid re-joining a match they are already in.
bool isBoardRoute(String route) => route.startsWith('/match/');