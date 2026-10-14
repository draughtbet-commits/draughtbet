import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../providers/password_recovery_provider.dart';
import '../theme/colors.dart';
import '../theme/typography.dart';

/// One public route owns the temporary recovery session. Reopening it starts
/// at the contact form; URL parameters can never unlock reset or success.
class PasswordRecoveryScreen extends ConsumerStatefulWidget {
  const PasswordRecoveryScreen({super.key});
  static const route = '/auth/forgot-password';

  @override
  ConsumerState<PasswordRecoveryScreen> createState() =>
      _PasswordRecoveryScreenState();
}

class _PasswordRecoveryScreenState
    extends ConsumerState<PasswordRecoveryScreen> {
  final _form = GlobalKey<FormState>();
  final _contact = TextEditingController();
  final _code = TextEditingController();
  final _password = TextEditingController();
  final _confirmation = TextEditingController();
  bool _hidePassword = true;
  bool _hideConfirmation = true;
  Timer? _ticker;

  @override
  void initState() {
    super.initState();
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted &&
          ref.read(passwordRecoveryProvider).step == RecoveryStep.code) {
        setState(() {});
      }
    });
  }

  void _clearSecrets() {
    _code.clear();
    _password.clear();
    _confirmation.clear();
  }

  void _startOver() {
    _clearSecrets();
    ref.read(passwordRecoveryProvider.notifier).startOver();
  }

  void _signIn() {
    _startOver();
    context.go('/login');
  }

  Future<void> _submit() async {
    if (!_form.currentState!.validate()) return;
    FocusScope.of(context).unfocus();
    final notifier = ref.read(passwordRecoveryProvider.notifier);
    switch (ref.read(passwordRecoveryProvider).step) {
      case RecoveryStep.contact:
        await notifier.requestCode(_contact.text);
      case RecoveryStep.code:
        await notifier.verify(_code.text);
      case RecoveryStep.password:
        final password = _password.text;
        _password.clear();
        _confirmation.clear();
        await notifier.updatePassword(password);
      case RecoveryStep.success:
        _signIn();
    }
  }

  @override
  void dispose() {
    _ticker?.cancel();
    _contact.dispose();
    _code.dispose();
    _password.dispose();
    _confirmation.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(passwordRecoveryProvider);
    final notifier = ref.read(passwordRecoveryProvider.notifier);
    final title = switch (state.step) {
      RecoveryStep.contact => 'Forgot password?',
      RecoveryStep.code => state.expired ? 'Code expired' : 'Verification code',
      RecoveryStep.password => 'Reset password',
      RecoveryStep.success => 'Password reset\nsuccessful!',
    };
    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        leading: IconButton(
          tooltip: 'Back to sign in',
          onPressed: _signIn,
          icon: const Icon(LucideIcons.chevronLeft),
        ),
      ),
      body: SafeArea(
        top: false,
        child: LayoutBuilder(
          builder: (context, constraints) => SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(24, 20, 24, 24),
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 420),
                child: Form(
                  key: _form,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      if (state.step == RecoveryStep.success) ...[
                        Image.asset(
                          'assets/images/king_promotion.png',
                          height: 160,
                          semanticLabel: 'Crowned green draught piece',
                        ),
                        const SizedBox(height: 20),
                      ],
                      Text(
                        title,
                        textAlign: TextAlign.center,
                        style: AppTypography.heading2,
                      ),
                      const SizedBox(height: 14),
                      Text(
                        switch (state.step) {
                          RecoveryStep.contact =>
                            'Enter your email or phone number to request a password reset code.',
                          RecoveryStep.code =>
                            state.expired
                                ? 'Please request a new code to continue.'
                                : 'If an eligible account exists, a 6-digit code will be sent to ${state.maskedContact}.\nEnter the code to continue.',
                          RecoveryStep.password =>
                            'Enter your new password below.',
                          RecoveryStep.success =>
                            'Your password has been updated.\nYou can now sign in to your account.',
                        },
                        textAlign: TextAlign.center,
                        style: AppTypography.bodyLarge.copyWith(
                          color: AppColors.textSecondary,
                          height: 1.5,
                        ),
                      ),
                      const SizedBox(height: 30),
                      if (state.step == RecoveryStep.contact)
                        TextFormField(
                          key: const Key('recovery-contact'),
                          controller: _contact,
                          enabled: !state.busy,
                          autocorrect: false,
                          keyboardType: TextInputType.emailAddress,
                          textInputAction: TextInputAction.done,
                          autofillHints: const [AutofillHints.email],
                          decoration: const InputDecoration(
                            labelText: 'Email or phone',
                            prefixIcon: Icon(LucideIcons.mail),
                          ),
                          validator: validateRecoveryContact,
                          onFieldSubmitted: (_) => _submit(),
                        ),
                      if (state.step == RecoveryStep.code) ...[
                        TextFormField(
                          key: const Key('recovery-code'),
                          controller: _code,
                          enabled: !state.busy && !state.expired,
                          keyboardType: TextInputType.number,
                          textInputAction: TextInputAction.done,
                          autofillHints: const [AutofillHints.oneTimeCode],
                          inputFormatters: [
                            FilteringTextInputFormatter.digitsOnly,
                            LengthLimitingTextInputFormatter(6),
                          ],
                          textAlign: TextAlign.center,
                          style: AppTypography.heading2.copyWith(
                            letterSpacing: 12,
                          ),
                          decoration: const InputDecoration(
                            labelText: '6-digit code',
                            hintText: '000000',
                            errorMaxLines: 3,
                          ),
                          validator: (value) =>
                              RegExp(r'^\d{6}$').hasMatch(value ?? '')
                              ? null
                              : 'Enter the 6-digit code.',
                          onFieldSubmitted: (_) => _submit(),
                        ),
                        const SizedBox(height: 10),
                        TextButton(
                          onPressed: state.busy || notifier.resendSeconds > 0
                              ? null
                              : () {
                                  _code.clear();
                                  notifier.resend();
                                },
                          child: Text(
                            notifier.resendSeconds > 0
                                ? 'Resend in ${notifier.resendSeconds}s'
                                : 'Resend code',
                          ),
                        ),
                      ],
                      if (state.step == RecoveryStep.password) ...[
                        _passwordField(
                          _password,
                          'New password',
                          _hidePassword,
                          () => setState(() => _hidePassword = !_hidePassword),
                          validateRecoveryPassword,
                          state.busy,
                        ),
                        const SizedBox(height: 14),
                        const Text(
                          'At least 8 characters\nUppercase and lowercase letters\nInclude a number',
                          style: AppTypography.bodySmall,
                        ),
                        const SizedBox(height: 20),
                        _passwordField(
                          _confirmation,
                          'Confirm new password',
                          _hideConfirmation,
                          () => setState(
                            () => _hideConfirmation = !_hideConfirmation,
                          ),
                          (value) =>
                              value == _password.text &&
                                  (value?.isNotEmpty ?? false)
                              ? null
                              : 'Passwords do not match.',
                          state.busy,
                        ),
                      ],
                      if (state.error != null) ...[
                        const SizedBox(height: 16),
                        Semantics(
                          liveRegion: true,
                          child: Text(
                            state.error!,
                            style: AppTypography.bodySmall.copyWith(
                              color: AppColors.danger,
                            ),
                          ),
                        ),
                      ],
                      const SizedBox(height: 24),
                      FilledButton(
                        key: const Key('recovery-submit'),
                        style: FilledButton.styleFrom(
                          minimumSize: const Size.fromHeight(52),
                          foregroundColor: AppColors.textPrimary,
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(10),
                          ),
                          padding: const EdgeInsets.symmetric(
                            horizontal: 16,
                            vertical: 14,
                          ),
                        ),
                        onPressed: state.busy || state.expired
                            ? null
                            : state.step == RecoveryStep.success
                            ? _signIn
                            : _submit,
                        child: state.busy
                            ? Semantics(
                                label: 'Please wait',
                                child: SizedBox.square(
                                  dimension: 22,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                  ),
                                ),
                              )
                            : Text(switch (state.step) {
                                RecoveryStep.contact => 'Send code',
                                RecoveryStep.code => 'Verify code',
                                RecoveryStep.password => 'Update password',
                                RecoveryStep.success => 'Continue to sign in',
                              }),
                      ),
                      const SizedBox(height: 12),
                      if (state.step == RecoveryStep.code)
                        TextButton(
                          onPressed: _startOver,
                          child: const Text('Use a different email or phone'),
                        ),
                      if (state.step != RecoveryStep.success)
                        TextButton(
                          onPressed: _signIn,
                          child: const Text('Back to sign in'),
                        ),
                      if (state.step == RecoveryStep.contact ||
                          state.step == RecoveryStep.code) ...[
                        const SizedBox(height: 24),
                        ExcludeSemantics(
                          child: Image.asset(
                            'assets/images/king_promotion.png',
                            height: 170,
                            fit: BoxFit.contain,
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _passwordField(
    TextEditingController controller,
    String label,
    bool hidden,
    VoidCallback toggle,
    FormFieldValidator<String> validator,
    bool busy,
  ) {
    return TextFormField(
      key: ValueKey(label),
      controller: controller,
      enabled: !busy,
      obscureText: hidden,
      autocorrect: false,
      enableSuggestions: false,
      autofillHints: const [AutofillHints.newPassword],
      decoration: InputDecoration(
        labelText: label,
        errorMaxLines: 3,
        prefixIcon: const Icon(LucideIcons.lock),
        suffixIcon: IconButton(
          tooltip: hidden ? 'Show $label' : 'Hide $label',
          onPressed: toggle,
          icon: Icon(hidden ? LucideIcons.eye : LucideIcons.eyeOff),
        ),
      ),
      validator: validator,
    );
  }
}
