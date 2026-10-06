import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/dispute.dart';
import '../services/dispute_gateway.dart';
import '../services/secure_storage.dart';
import 'auth_provider.dart';

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
  DisputeNotifier(
    this._gateway, {
    SecureStorageService? storage,
    DisputeState initial = const DisputeState(),
  }) : _storage = storage,
       super(initial);

  final DisputeGateway _gateway;
  final SecureStorageService? _storage;

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
      final storage = _storage;
      if (storage != null) {
        unawaited(_remember(storage, dispute));
      }
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

  Future<bool> refreshStatus(
    String? disputeId, {
    String? matchId,
  }) async {
    if (state.busy) return false;
    final id = disputeId ?? state.dispute?.id;
    var resolvedMatchId = matchId ?? state.dispute?.matchId;
    // Reopening the status screen (e.g. from a match result card) has no
    // in-memory case, so look the match up from the stored submission ref.
    if ((resolvedMatchId == null || resolvedMatchId.isEmpty) &&
        id != null &&
        id.isNotEmpty &&
        _storage != null) {
      try {
        final refs = await _storage.loadDisputeRefs();
        for (final entry in refs) {
          if (entry.disputeId == id) {
            resolvedMatchId = entry.matchId;
            break;
          }
        }
      } catch (_) {
        // A storage read failure must not make the refresh appear to crash.
      }
    }
    if (id == null ||
        id.isEmpty ||
        resolvedMatchId == null ||
        resolvedMatchId.isEmpty ||
        !_gateway.statusContractAvailable) {
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
      final dispute = await _gateway.fetchStatus(
        matchId: resolvedMatchId,
        disputeId: id,
      );
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

  Future<void> _remember(
    SecureStorageService storage,
    DisputeCaseData dispute,
  ) async {
    try {
      await storage.storeDisputeRef(
        DisputeCaseRef(matchId: dispute.matchId, disputeId: dispute.id),
      );
    } catch (_) {
      // Storage must never make a confirmed submission look failed.
    }
  }
}

final disputeProvider = StateNotifierProvider<DisputeNotifier, DisputeState>(
  (ref) => DisputeNotifier(
    ref.watch(disputeGatewayProvider),
    storage: ref.watch(secureStorageProvider),
  ),
);
