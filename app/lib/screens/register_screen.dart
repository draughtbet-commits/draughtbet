import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../providers/auth_provider.dart';
import '../theme/colors.dart';
import '../theme/typography.dart';

class RegisterScreen extends ConsumerStatefulWidget {
  const RegisterScreen({Key? key}) : super(key: key);

  @override
  ConsumerState<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends ConsumerState<RegisterScreen> {
  final _formKey = GlobalKey<FormState>();
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();
  final _confirmController = TextEditingController();
  final _dobController = TextEditingController();

  DateTime? _dateOfBirth;
  bool _obscurePassword = true;
  bool _obscureConfirm = true;
  bool _acceptedTerms = false;
  bool _termsError = false;

  @override
  void dispose() {
    _emailController.dispose();
    _passwordController.dispose();
    _confirmController.dispose();
    _dobController.dispose();
    super.dispose();
  }

  int _passwordScore(String value) {
    var score = 0;
    if (value.length >= 8) score++;
    if (RegExp(r'[A-Z]').hasMatch(value)) score++;
    if (RegExp(r'[a-z]').hasMatch(value)) score++;
    if (RegExp(r'[0-9]').hasMatch(value)) score++;
    return score;
  }

  String _strengthLabel(int score) {
    if (score <= 1) return 'Too short';
    if (score == 2) return 'Weak';
    if (score == 3) return 'Medium';
    return 'Strong';
  }

  Color _strengthColor(int score) {
    if (score <= 1) return AppColors.danger;
    if (score == 2) return AppColors.warning;
    if (score == 3) return AppColors.info;
    return AppColors.success;
  }

  bool _isAdult(DateTime dob) {
    final now = DateTime.now();
    var age = now.year - dob.year;
    final m = now.month - dob.month;
    if (m < 0 || (m == 0 && now.day < dob.day)) age--;
    return age >= 18;
  }

  Future<void> _pickDateOfBirth() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: now.subtract(const Duration(days: 365 * 18)),
      firstDate: DateTime(1940),
      lastDate: now,
      helpText: 'Date of birth',
      builder: (context, child) {
        return Theme(
          data: Theme.of(context).copyWith(
            colorScheme: const ColorScheme.dark(
              primary: AppColors.gold500,
              surface: AppColors.surface1,
              background: AppColors.voidBg,
            ),
          ),
          child: child!,
        );
      },
    );
    if (picked != null) {
      setState(() {
        _dateOfBirth = picked;
        _dobController.text =
            '${picked.year}-${picked.month.toString().padLeft(2, '0')}-${picked.day.toString().padLeft(2, '0')}';
      });
    }
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    if (!_acceptedTerms) {
      setState(() => _termsError = true);
      return;
    }
    final auth = ref.read(authProvider.notifier);
    final ok = await auth.register(
      email: _emailController.text.trim(),
      password: _passwordController.text,
      dateOfBirth: _dateOfBirth!,
    );
    if (ok) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Account created. Sign in to continue.'),
            backgroundColor: AppColors.success,
          ),
        );
        context.go('/login');
      }
    }
  }

  InputDecoration _decoration({
    required String label,
    Widget? prefixIcon,
    Widget? suffixIcon,
  }) {
    return InputDecoration(
      labelText: label,
      labelStyle: AppTypography.labelMuted,
      filled: true,
      fillColor: AppColors.surface1,
      prefixIcon: prefixIcon,
      suffixIcon: suffixIcon,
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(8),
        borderSide: const BorderSide(color: AppColors.borderDim),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(8),
        borderSide: const BorderSide(color: AppColors.borderDim),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(8),
        borderSide: const BorderSide(color: AppColors.gold500),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final authState = ref.watch(authProvider);
    final strength = _passwordScore(_passwordController.text);
    final showStrength = _passwordController.text.isNotEmpty;

    return Scaffold(
      backgroundColor: AppColors.voidBg,
      appBar: AppBar(
        backgroundColor: AppColors.voidBg,
        elevation: 0,
      ),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
            child: Form(
              key: _formKey,
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    'Create account',
                    textAlign: TextAlign.center,
                    style: AppTypography.heading2,
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'A wallet is created for you on sign-up.',
                    textAlign: TextAlign.center,
                    style: AppTypography.bodySmall,
                  ),
                  const SizedBox(height: 32),
                  TextFormField(
                    controller: _emailController,
                    keyboardType: TextInputType.emailAddress,
                    autocorrect: false,
                    style: AppTypography.bodyLarge,
                    decoration: _decoration(
                      label: 'Email',
                      prefixIcon: const Icon(LucideIcons.mail, color: AppColors.textMuted, size: 20),
                    ),
                    validator: (value) {
                      if (value == null || !value.contains('@')) {
                        return 'Enter a valid email address';
                      }
                      return null;
                    },
                  ),
                  const SizedBox(height: 16),
                  TextFormField(
                    controller: _passwordController,
                    obscureText: _obscurePassword,
                    style: AppTypography.bodyLarge,
                    onChanged: (_) => setState(() {}),
                    decoration: _decoration(
                      label: 'Password',
                      prefixIcon: const Icon(LucideIcons.lock, color: AppColors.textMuted, size: 20),
                      suffixIcon: IconButton(
                        icon: Icon(
                          _obscurePassword ? LucideIcons.eye : LucideIcons.eyeOff,
                          color: AppColors.textMuted,
                          size: 20,
                        ),
                        onPressed: () {
                          setState(() => _obscurePassword = !_obscurePassword);
                        },
                      ),
                    ),
                    validator: (value) {
                      if (value == null || value.isEmpty) {
                        return 'Enter a password';
                      }
                      if (value.length < 8) {
                        return 'At least 8 characters';
                      }
                      if (!RegExp(r'[A-Z]').hasMatch(value)) {
                        return 'Needs an uppercase letter';
                      }
                      if (!RegExp(r'[a-z]').hasMatch(value)) {
                        return 'Needs a lowercase letter';
                      }
                      if (!RegExp(r'[0-9]').hasMatch(value)) {
                        return 'Needs a number';
                      }
                      return null;
                    },
                  ),
                  if (showStrength) ...[
                    const SizedBox(height: 8),
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        LinearProgressIndicator(
                          value: strength / 4,
                          minHeight: 4,
                          backgroundColor: AppColors.surface3,
                          valueColor: AlwaysStoppedAnimation<Color>(_strengthColor(strength)),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          '${_strengthLabel(strength)} — use 8+ chars with upper, lower and a number',
                          style: AppTypography.bodySmall.copyWith(
                            color: _strengthColor(strength),
                          ),
                        ),
                      ],
                    ),
                  ],
                  const SizedBox(height: 16),
                  TextFormField(
                    controller: _confirmController,
                    obscureText: _obscureConfirm,
                    style: AppTypography.bodyLarge,
                    decoration: _decoration(
                      label: 'Confirm password',
                      prefixIcon: const Icon(LucideIcons.lock, color: AppColors.textMuted, size: 20),
                      suffixIcon: IconButton(
                        icon: Icon(
                          _obscureConfirm ? LucideIcons.eye : LucideIcons.eyeOff,
                          color: AppColors.textMuted,
                          size: 20,
                        ),
                        onPressed: () {
                          setState(() => _obscureConfirm = !_obscureConfirm);
                        },
                      ),
                    ),
                    validator: (value) {
                      if (value != _passwordController.text) {
                        return 'Passwords do not match';
                      }
                      return null;
                    },
                  ),
                  const SizedBox(height: 16),
                  TextFormField(
                    readOnly: true,
                    onTap: _pickDateOfBirth,
                    style: AppTypography.bodyLarge,
                    controller: _dobController,
                    decoration: _decoration(
                      label: 'Date of birth',
                      prefixIcon: const Icon(LucideIcons.calendar, color: AppColors.textMuted, size: 20),
                    ),
                    validator: (value) {
                      if (_dateOfBirth == null) {
                        return 'Select your date of birth';
                      }
                      if (!_isAdult(_dateOfBirth!)) {
                        return 'You must be 18 or older to play for money';
                      }
                      return null;
                    },
                  ),
                  const SizedBox(height: 8),
                  CheckboxListTile(
                    value: _acceptedTerms,
                    onChanged: (value) {
                      setState(() {
                        _acceptedTerms = value ?? false;
                        _termsError = false;
                      });
                    },
                    contentPadding: EdgeInsets.zero,
                    controlAffinity: ListTileControlAffinity.leading,
                    activeColor: AppColors.gold500,
                    title: Text(
                      'I confirm I am 18 or older and agree to the Terms of Service and Privacy Policy.',
                      style: AppTypography.bodySmall,
                    ),
                  ),
                  if (_termsError) ...[
                    const SizedBox(height: 4),
                    Text(
                      'You must accept the terms before creating an account.',
                      style: AppTypography.bodySmall.copyWith(color: AppColors.danger),
                    ),
                  ],
                  if (authState.error != null) ...[
                    const SizedBox(height: 8),
                    Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: AppColors.danger.withOpacity(0.12),
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: AppColors.danger.withOpacity(0.4)),
                      ),
                      child: Text(
                        authState.error!,
                        style: AppTypography.bodySmall.copyWith(color: AppColors.danger),
                      ),
                    ),
                  ],
                  const SizedBox(height: 24),
                  ElevatedButton(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: AppColors.gold500,
                      padding: const EdgeInsets.symmetric(vertical: 16),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(8),
                      ),
                    ),
                    onPressed: authState.isLoading ? null : _submit,
                    child: authState.isLoading
                        ? const SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: AppColors.voidBg,
                            ),
                          )
                        : const Text(
                            'Create account',
                            style: TextStyle(
                              color: AppColors.voidBg,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                  ),
                  const SizedBox(height: 16),
                  TextButton(
                    onPressed: () => context.go('/login'),
                    child: const Text(
                      'Already signed up? Sign in',
                      style: TextStyle(color: AppColors.textSecondary),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}