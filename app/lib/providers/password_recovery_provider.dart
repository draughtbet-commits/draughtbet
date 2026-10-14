import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../services/password_recovery_gateway.dart';

enum RecoveryStep { contact, code, password, success }

class RecoveryState {
  const RecoveryState({
    this.step = RecoveryStep.contact,
    this.busy = false,
    this.maskedContact = '',
    this.error,
    this.expired = false,
  });
  final RecoveryStep step;
  final bool busy;
  final String maskedContact;
  final String? error;
  final bool expired;
}

String? validateRecoveryContact(String? value) {
  final contact = value?.trim() ?? '';
  if (RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$').hasMatch(contact) ||
      RegExp(r'^\+?[0-9]{7,15}$').hasMatch(contact)) {
    return null;
  }
  return 'Enter a valid email or phone number.';
}

String? validateRecoveryPassword(String? value) {
  final password = value ?? '';
  if (password.length < 8 ||
      !RegExp('[A-Z]').hasMatch(password) ||
      !RegExp('[a-z]').hasMatch(password) ||
      !RegExp('[0-9]').hasMatch(password)) {
    return 'Use at least 8 characters with uppercase, lowercase and a number.';
  }
  return null;
}

class PasswordRecoveryNotifier extends StateNotifier<RecoveryState> {
  PasswordRecoveryNotifier(this._gateway) : super(const RecoveryState());
  final PasswordRecoveryGateway _gateway;
  String? _contact;
  RecoveryChallenge? _challenge;
  String? _grant;
  final _resendClock = Stopwatch();
  int _generation = 0;

  int get resendSeconds {
    final remaining =
        (_challenge?.resendAfter ?? Duration.zero) - _resendClock.elapsed;
    return remaining.isNegative ? 0 : (remaining.inMilliseconds / 1000).ceil();
  }

  void startOver() {
    _generation++;
    _contact = null;
    _challenge = null;
    _grant = null;
    _resendClock
      ..stop()
      ..reset();
    state = const RecoveryState();
  }

  Future<void> requestCode(String contact, {bool resend = false}) async {
    if (state.busy ||
        (!resend && state.step != RecoveryStep.contact) ||
        (resend && (state.step != RecoveryStep.code || resendSeconds > 0))) {
      return;
    }
    if (validateRecoveryContact(contact) != null) return;
    final generation = _generation;
    final previous = state;
    _set(previous.step, busy: true);
    try {
      final challenge = await _gateway.requestCode(contact.trim());
      if (!mounted || generation != _generation) return;
      if (challenge.id.trim().isEmpty ||
          challenge.maskedContact.trim().isEmpty ||
          challenge.resendAfter.isNegative) {
        throw const RecoveryException(RecoveryFailure.unavailable);
      }
      _contact = contact.trim();
      _challenge = challenge;
      _resendClock
        ..reset()
        ..start();
      _set(RecoveryStep.code);
    } catch (error) {
      if (mounted && generation == _generation) {
        _set(previous.step, error: _message(error), expired: previous.expired);
      }
    }
  }

  Future<void> resend() async {
    final contact = _contact;
    if (contact != null) await requestCode(contact, resend: true);
  }

  Future<void> verify(String code) async {
    final challenge = _challenge;
    if (state.busy ||
        state.expired ||
        state.step != RecoveryStep.code ||
        challenge == null ||
        !RegExp(r'^\d{6}$').hasMatch(code)) {
      return;
    }
    final generation = _generation;
    _set(RecoveryStep.code, busy: true);
    try {
      final grant = await _gateway.verifyCode(challenge.id, code);
      if (!mounted || generation != _generation) return;
      if (grant.trim().isEmpty) {
        throw const RecoveryException(RecoveryFailure.invalidCode);
      }
      _grant = grant;
      _set(RecoveryStep.password);
    } catch (error) {
      if (mounted && generation == _generation) {
        _set(
          RecoveryStep.code,
          error: _message(error),
          expired:
              error is RecoveryException &&
              error.failure == RecoveryFailure.expired,
        );
      }
    }
  }

  Future<void> updatePassword(String password) async {
    final grant = _grant;
    if (state.busy ||
        state.step != RecoveryStep.password ||
        grant == null ||
        validateRecoveryPassword(password) != null) {
      return;
    }
    final generation = _generation;
    _set(RecoveryStep.password, busy: true);
    try {
      final confirmed = await _gateway.resetPassword(grant, password);
      if (!mounted || generation != _generation) return;
      if (!confirmed) throw const RecoveryException(RecoveryFailure.network);
      _grant = null;
      _contact = null;
      _challenge = null;
      _set(RecoveryStep.success);
    } catch (error) {
      if (!mounted || generation != _generation) return;
      if (error is RecoveryException &&
          error.failure == RecoveryFailure.expired) {
        _grant = null;
        _set(RecoveryStep.code, error: _message(error), expired: true);
      } else {
        _set(
          RecoveryStep.password,
          error:
              'We could not confirm the password update. Try signing in before requesting another reset.',
        );
      }
    }
  }

  void _set(
    RecoveryStep step, {
    bool busy = false,
    String? error,
    bool expired = false,
  }) {
    state = RecoveryState(
      step: step,
      busy: busy,
      error: error,
      expired: expired,
      maskedContact: _challenge?.maskedContact ?? '',
    );
  }

  String _message(Object error) => switch (error) {
    RecoveryException(failure: RecoveryFailure.invalidCode) =>
      'That code could not be verified. Check it and try again.',
    RecoveryException(failure: RecoveryFailure.expired) =>
      'This code has expired. Request a new code to continue.',
    RecoveryException(failure: RecoveryFailure.rateLimited) =>
      'Too many attempts. Please wait before trying again.',
    RecoveryException(failure: RecoveryFailure.unavailable) =>
      'Password recovery is currently unavailable. Please try again later.',
    _ =>
      'We could not confirm your request. Check your connection and try again.',
  };

  @override
  void dispose() {
    _generation++;
    _grant = null;
    _contact = null;
    _challenge = null;
    _resendClock.stop();
    super.dispose();
  }
}

final passwordRecoveryProvider =
    StateNotifierProvider.autoDispose<PasswordRecoveryNotifier, RecoveryState>(
      (ref) =>
          PasswordRecoveryNotifier(ref.watch(passwordRecoveryGatewayProvider)),
    );
