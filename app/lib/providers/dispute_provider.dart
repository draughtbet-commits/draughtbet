import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/dispute.dart';
import '../services/dispute_gateway.dart';

enum DisputeLoadPhase {
  initial,
  drafting,
  submitting,
  refreshing,
  ready,
  unavailable,
  error,
}

class DisputeState {
  const DisputeState({
    this.phase = DisputeLoadPhase.initial,
    this.match,
    this.reason,
    this.details = '',
    this.dispute,
    this.message,
  });

  final DisputeLoadPhase phase;
  final DisputeMatchSummary? match;
  final DisputeReason? reason;
  final String details;
  final DisputeCaseData? dispute;
  final String? message;

  bool get busy =>
      phase == DisputeLoadPhase.submitting ||
      phase == DisputeLoadPhase.refreshing;

  DisputeState copyWith({
    DisputeLoadPhase? phase,
    DisputeMatchSummary? match,
    DisputeReason? reason,
    String? details,
    DisputeCaseData? dispute,
    String? message,
    bool clearMessage = false,
  }) => DisputeState(
    phase: phase ?? this.phase,
    match: match ?? this.match,
    reason: reason ?? this.reason,
    details: details ?? this.details,
    dispute: dispute ?? this.dispute,
    message: clearMessage ? null : message ?? this.message,
  );
}

class DisputeNotifier extends StateNotifier<DisputeState> {
  DisputeNotifier(this._gateway, {DisputeState initial = const DisputeState()})
    : super(initial);

  final DisputeGateway _gateway;

  void start(DisputeMatchSummary match) {
    state = DisputeState(phase: DisputeLoadPhase.drafting, match: match);
  }

  void selectReason(DisputeReason reason, {String details = ''}) {
    state = state.copyWith(
      phase: DisputeLoadPhase.drafting,
      reason: reason,
      details: details.trim(),
      clearMessage: true,
    );
  }

  void updateDetails(String details) {
    state = state.copyWith(details: details.trim(), clearMessage: true);
  }

  Future<bool> submit() async {
    if (state.busy) return false;
    final match = state.match;
    final reason = state.reason;
    if (match == null || reason == null) {
      state = state.copyWith(
        phase: DisputeLoadPhase.error,
        message: 'Choose a match and reason before submitting.',
      );
      return false;
    }
    if (!_gateway.playerContractAvailable) {
      state = state.copyWith(
        phase: DisputeLoadPhase.unavailable,
        message:
            'Match reporting is temporarily unavailable. No dispute was submitted.',
      );
      return false;
    }
    state = state.copyWith(
      phase: DisputeLoadPhase.submitting,
      clearMessage: true,
    );
    try {
      final dispute = await _gateway.submit(
        match: match,
        reason: reason,
        details: state.details,
      );
      if (dispute == null || dispute.matchId != match.matchId) {
        state = state.copyWith(
          phase: DisputeLoadPhase.unavailable,
          message:
              'The server did not confirm this dispute. Do not submit it again yet.',
        );
        return false;
      }
      state = state.copyWith(
        phase: DisputeLoadPhase.ready,
        dispute: dispute,
        clearMessage: true,
      );
      return true;
    } on DisputeContractError catch (error) {
      // The gateway already turned the server's rejection into a message
      // that is safe to show, so surface it instead of a generic failure.
      state = state.copyWith(
        phase: DisputeLoadPhase.error,
        message: error.message,
      );
      return false;
    } catch (_) {
      state = state.copyWith(
        phase: DisputeLoadPhase.error,
        message: 'The report could not be submitted. Try again.',
      );
      return false;
    }
  }

  Future<bool> refreshStatus([String? disputeId]) async {
    if (state.busy) return false;
    final id = disputeId ?? state.dispute?.id;
    if (id == null || id.isEmpty || !_gateway.statusContractAvailable) {
      state = state.copyWith(
        phase: DisputeLoadPhase.unavailable,
        message: 'Dispute status is temporarily unavailable.',
      );
      return false;
    }
    state = state.copyWith(
      phase: DisputeLoadPhase.refreshing,
      clearMessage: true,
    );
    try {
      final dispute = await _gateway.fetchStatus(id);
      if (dispute == null || dispute.id != id) {
        state = state.copyWith(
          phase: DisputeLoadPhase.unavailable,
          message: 'The server did not return a valid dispute status.',
        );
        return false;
      }
      state = state.copyWith(
        phase: DisputeLoadPhase.ready,
        dispute: dispute,
        clearMessage: true,
      );
      return true;
    } catch (_) {
      state = state.copyWith(
        phase: DisputeLoadPhase.error,
        message: 'Dispute status could not be refreshed.',
      );
      return false;
    }
  }

  void clear() => state = const DisputeState();
}

final disputeProvider = StateNotifierProvider<DisputeNotifier, DisputeState>(
  (ref) => DisputeNotifier(ref.watch(disputeGatewayProvider)),
);
