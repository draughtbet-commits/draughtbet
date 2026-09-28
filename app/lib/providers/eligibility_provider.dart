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
  }) : super(initialState);

  final EligibilityGateway _gateway;

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
}

final eligibilityProvider =
    StateNotifierProvider<EligibilityNotifier, EligibilityState>(
      (ref) => EligibilityNotifier(ref.watch(eligibilityGatewayProvider)),
    );

EligibilityDecision? eligibilityDecisionFromDio(DioException error) =>
    EligibilityDecision.fromServerError(
      statusCode: error.response?.statusCode,
      body: error.response?.data,
    );
