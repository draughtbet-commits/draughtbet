import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/backend_contract.dart';
import '../models/eligibility.dart';
import '../services/eligibility_gateway.dart';

enum EligibilityLoadPhase { initial, loading, ready, unavailable, error }

class EligibilityState {
  const EligibilityState({
    this.phase = EligibilityLoadPhase.initial,
    this.verification,
    this.saferPlay,
    this.decision,
    this.message,
    this.submitting = false,
  });

  final EligibilityLoadPhase phase;
  final VerificationSnapshot? verification;
  final SaferPlayProfile? saferPlay;
  final EligibilityDecision? decision;
  final String? message;
  final bool submitting;

  EligibilityState copyWith({
    EligibilityLoadPhase? phase,
    VerificationSnapshot? verification,
    SaferPlayProfile? saferPlay,
    EligibilityDecision? decision,
    String? message,
    bool? submitting,
    bool clearDecision = false,
    bool clearMessage = false,
  }) => EligibilityState(
    phase: phase ?? this.phase,
    verification: verification ?? this.verification,
    saferPlay: saferPlay ?? this.saferPlay,
    decision: clearDecision ? null : decision ?? this.decision,
    message: clearMessage ? null : message ?? this.message,
    submitting: submitting ?? this.submitting,
  );
}

class EligibilityNotifier extends StateNotifier<EligibilityState> {
  EligibilityNotifier(
    this._gateway, {
    EligibilityState initialState = const EligibilityState(),
    void Function(bool isBanned)? onAccountStatus,
    Duration reconcileInterval = const Duration(seconds: 30),
  }) : _onAccountStatus = onAccountStatus,
       _reconcileInterval = reconcileInterval,
       super(initialState);

  final EligibilityGateway _gateway;
  final Duration _reconcileInterval;
  Timer? _reconcileTimer;

  /// Begins periodically re-reading the server-owned restriction flag.
  ///
  /// The socket cannot be trusted to carry this change: a suspension severs
  /// the connection and the handshake then refuses the banned account, so
  /// there may be no live channel at all until the ban is lifted. Reconciling
  /// from the owner of the state -- rather than from a screen -- also means a
  /// reinstatement lands no matter which route the player happens to be on.
  void startReconciling() {
    if (_reconcileTimer != null) return;
    _reconcileTimer = Timer.periodic(_reconcileInterval, (_) {
      if (!mounted) return;
      unawaited(refreshCanonical());
    });
  }

  /// Lets the shell clear a dismissed restriction the moment an admin
  /// reinstates the account, so lifting a ban does not need a reinstall or a
  /// manual refresh to become visible.
  final void Function(bool isBanned)? _onAccountStatus;

  /// Applies a pushed account-status change without a round trip.
  ///
  /// The server is authoritative here: it pushed the new flag over the socket
  /// in the same action that wrote it. Returns whether the visible state
  /// changed, so the caller can decide to re-announce or clear.
  bool applyPushedAccountStatus(bool isBanned) {
    final current = state.verification?.isBanned ?? false;
    if (current == isBanned) return false;
    // Keep every other field: a push carries only the flag, and dropping the
    // KYC status here would make the banner's own refresh look like a
    // verification reset.
    final verification = state.verification?.copyWith(isBanned: isBanned);
    state = state.copyWith(
      phase: state.phase == EligibilityLoadPhase.initial
          ? EligibilityLoadPhase.ready
          : state.phase,
      verification: verification ??
          VerificationSnapshot(
            status: VerificationStatus.notRequired,
            isBanned: isBanned,
          ),
    );
    _onAccountStatus?.call(isBanned);
    return true;
  }

  Future<bool> refreshCanonical() async {
    if (state.phase == EligibilityLoadPhase.loading) return false;
    state = state.copyWith(
      phase: EligibilityLoadPhase.loading,
      clearMessage: true,
    );
    try {
      final values = await Future.wait<dynamic>([
        _gateway.fetchVerificationStatus(),
        _gateway.fetchSaferPlayProfile(),
      ]);
      final verification = values[0] as VerificationSnapshot?;
      final profile = values[1] as SaferPlayProfile?;
      if (verification == null || profile == null) {
        state = state.copyWith(
          phase: EligibilityLoadPhase.unavailable,
          message: 'Account controls are temporarily unavailable.',
        );
        return false;
      }
      state = state.copyWith(
        phase: EligibilityLoadPhase.ready,
        verification: verification,
        saferPlay: profile,
        clearMessage: true,
      );
      return true;
    } on DioException catch (error) {
      state = state.copyWith(
        phase: EligibilityLoadPhase.error,
        message:
            apiErrorMessage(error.response?.data) ??
            'We could not refresh account controls. Try again.',
      );
      return false;
    } catch (_) {
      state = state.copyWith(
        phase: EligibilityLoadPhase.error,
        message: 'We could not refresh account controls. Try again.',
      );
      return false;
    }
  }

  Future<VerificationStatus> startVerification(
    VerificationCheckType type,
  ) async {
    if (state.submitting) {
      return state.verification?.status ?? VerificationStatus.unavailable;
    }
    state = state.copyWith(submitting: true, clearMessage: true);
    try {
      final snapshot = await _gateway.startVerification(type);
      if (snapshot == null) {
        state = state.copyWith(
          submitting: false,
          phase: EligibilityLoadPhase.unavailable,
          message: 'Verification status could not be confirmed.',
        );
        return VerificationStatus.unavailable;
      }
      state = state.copyWith(
        submitting: false,
        phase: EligibilityLoadPhase.ready,
        verification: snapshot,
      );
      return snapshot.status;
    } on DioException catch (error) {
      // A conflict can mean the server already has a live or completed case;
      // refresh the canonical status instead of starting another one.
      if (error.response?.statusCode == 409) {
        try {
          final snapshot = await _gateway.fetchVerificationStatus();
          state = state.copyWith(
            submitting: false,
            phase: snapshot == null
                ? EligibilityLoadPhase.unavailable
                : EligibilityLoadPhase.ready,
            verification: snapshot,
            message: snapshot == null
                ? 'Verification status could not be confirmed.'
                : null,
          );
          return snapshot?.status ?? VerificationStatus.unavailable;
        } catch (_) {
          // Fall through to the safe unavailable state below.
        }
      }
      final rejected = error.response?.statusCode == 422;
      final snapshot = VerificationSnapshot(
        status: rejected
            ? VerificationStatus.rejected
            : VerificationStatus.unavailable,
      );
      state = state.copyWith(
        submitting: false,
        phase: rejected
            ? EligibilityLoadPhase.ready
            : EligibilityLoadPhase.error,
        verification: snapshot,
        message:
            apiErrorMessage(error.response?.data) ??
            'Verification could not be completed safely.',
      );
      return snapshot.status;
    }
  }

  Future<bool> setLimit({required bool deposit, required int? amount}) async {
    return _mutateProfile(
      () => deposit
          ? _gateway.setDepositLimit(amount)
          : _gateway.setStakeLimit(amount),
    );
  }

  Future<bool> takeBreak(int minutes) =>
      _mutateProfile(() => _gateway.startTimeout(minutes));

  Future<bool> selfExclude(String until) =>
      _mutateProfile(() => _gateway.startSelfExclusion(until));

  Future<bool> _mutateProfile(
    Future<SaferPlayProfile?> Function() operation,
  ) async {
    if (state.submitting) return false;
    state = state.copyWith(submitting: true, clearMessage: true);
    try {
      final profile = await operation();
      if (profile == null) {
        state = state.copyWith(
          submitting: false,
          phase: EligibilityLoadPhase.unavailable,
          message: 'The server did not confirm this control.',
        );
        return false;
      }
      state = state.copyWith(
        submitting: false,
        phase: EligibilityLoadPhase.ready,
        saferPlay: profile,
      );
      return true;
    } on DioException catch (error) {
      state = state.copyWith(
        submitting: false,
        phase: EligibilityLoadPhase.error,
        message:
            apiErrorMessage(error.response?.data) ??
            'This control could not be updated.',
      );
      return false;
    } catch (_) {
      state = state.copyWith(
        submitting: false,
        phase: EligibilityLoadPhase.error,
        message: 'This control could not be updated.',
      );
      return false;
    }
  }

  void applyDecision(EligibilityDecision decision) {
    state = state.copyWith(decision: decision);
  }

  void clearDecision() => state = state.copyWith(clearDecision: true);

  @override
  void dispose() {
    _reconcileTimer?.cancel();
    super.dispose();
  }
}

final eligibilityProvider =
    StateNotifierProvider<EligibilityNotifier, EligibilityState>(
      (ref) {
        final notifier = EligibilityNotifier(
          ref.watch(eligibilityGatewayProvider),
        )..startReconciling();
        return notifier;
      },
    );

EligibilityDecision? eligibilityDecisionFromDio(DioException error) =>
    EligibilityDecision.fromServerError(
      statusCode: error.response?.statusCode,
      body: error.response?.data,
    );
