import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models/support_case.dart';

import '../config/backend_contract.dart';
import '../services/support_gateway.dart';

@immutable
class SupportState {
  const SupportState({
    this.cases = const [],
    this.loading = false,
    this.submitting = false,
    this.errorMessage,
    this.openedCase,
  });

  final List<SupportCase> cases;
  final bool loading;
  final bool submitting;
  final String? errorMessage;

  /// Set once a case is created so the caller can show its reference.
  final SupportCase? openedCase;

  bool get hasOpenCase => cases.any((c) => c.status.isOpen);

  /// Most recent open ACCOUNT case — what the restricted screen surfaces as the
  /// player's appeal reference.
  SupportCase? get latestAccountCase {
    final matches = cases
        .where((c) => c.type == SupportCaseType.account && c.status.isOpen)
        .toList();
    if (matches.isEmpty) return null;
    matches.sort(
      (a, b) => (b.createdAt ?? DateTime(0)).compareTo(a.createdAt ?? DateTime(0)),
    );
    return matches.first;
  }

  SupportState copyWith({
    List<SupportCase>? cases,
    bool? loading,
    bool? submitting,
    String? errorMessage,
    bool clearError = false,
    SupportCase? openedCase,
    bool clearOpenedCase = false,
  }) {
    return SupportState(
      cases: cases ?? this.cases,
      loading: loading ?? this.loading,
      submitting: submitting ?? this.submitting,
      errorMessage: clearError ? null : errorMessage ?? this.errorMessage,
      openedCase: clearOpenedCase ? null : openedCase ?? this.openedCase,
    );
  }
}

class SupportNotifier extends StateNotifier<SupportState> {
  SupportNotifier(this._gateway) : super(const SupportState());

  final SupportGateway _gateway;

  Future<bool> load() async {
    if (state.loading) return false;
    state = state.copyWith(loading: true, clearError: true);
    try {
      final cases = await _gateway.fetchMyCases();
      state = state.copyWith(loading: false, cases: cases, clearError: true);
      return true;
    } on DioException catch (error) {
      state = state.copyWith(
        loading: false,
        errorMessage:
            apiErrorMessage(error.response?.data) ??
            'We could not load your support cases.',
      );
      return false;
    } catch (_) {
      state = state.copyWith(
        loading: false,
        errorMessage: 'We could not load your support cases.',
      );
      return false;
    }
  }

  Future<bool> openCase({
    required SupportCaseType type,
    required String subject,
    String? description,
  }) async {
    if (state.submitting) return false;
    state = state.copyWith(submitting: true, clearError: true);
    try {
      final created = await _gateway.openCase(
        type: type,
        subject: subject,
        description: description,
      );
      if (created == null) {
        state = state.copyWith(
          submitting: false,
          errorMessage: 'The case was created but we could not read it back.',
        );
        return false;
      }
      state = state.copyWith(
        submitting: false,
        openedCase: created,
        cases: [created, ...state.cases],
      );
      return true;
    } on DioException catch (error) {
      state = state.copyWith(
        submitting: false,
        errorMessage:
            apiErrorMessage(error.response?.data) ??
            'We could not open the case. Try again.',
      );
      return false;
    } catch (_) {
      state = state.copyWith(
        submitting: false,
        errorMessage: 'We could not open the case. Try again.',
      );
      return false;
    }
  }

  void clearOpenedCase() =>
      state = state.copyWith(clearOpenedCase: true, clearError: true);
}

final supportProvider =
    StateNotifierProvider<SupportNotifier, SupportState>(
      (ref) => SupportNotifier(ref.watch(supportGatewayProvider)),
    );
/// Test seam: a notifier that performs no I/O, for golden/widget tests that
/// render screens which eagerly load support cases.
class FakeSupportNotifier extends SupportNotifier {
  FakeSupportNotifier() : super(_FakeSupportGateway());
}

/// Unreachable Dio: FakeSupportNotifier overrides every method, so no request
/// is ever issued through it.
class _FakeSupportGateway extends SupportGateway {
  _FakeSupportGateway() : super(Dio());
}
