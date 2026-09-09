import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../providers/auth_provider.dart';
import '../services/auth_check_service.dart';
import '../services/geo_service.dart';
import '../theme/colors.dart';

class RegisterScreen extends ConsumerStatefulWidget {
  const RegisterScreen({Key? key}) : super(key: key);

  @override
  ConsumerState<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends ConsumerState<RegisterScreen> {
  final _formKey = GlobalKey<FormState>();
  final _usernameController = TextEditingController();
  final _emailController = TextEditingController();
  final _fullNameController = TextEditingController();
  final _addressController = TextEditingController();
  final _phoneController = TextEditingController();
  final _passwordController = TextEditingController();
  final _confirmController = TextEditingController();
  final _confirmFieldKey = GlobalKey<FormFieldState<String>>();
  final _dobController = TextEditingController();

  DateTime? _dateOfBirth;
  bool _obscurePassword = true;
  bool _obscureConfirm = true;
  bool _acceptedTerms = false;
  bool _termsError = false;
  bool _acceptedAge = false;
  bool _ageError = false;

  // Real-time uniqueness state (null = not yet checked).
  bool? _usernameTaken;
  bool? _emailTaken;
  bool? _phoneTaken;

  bool _checkingGeo = false;
  String? _localError;
  String? _countryCode;
  Timer? _availabilityDebounce;

  @override
  void dispose() {
    _availabilityDebounce?.cancel();
    _usernameController.dispose();
    _emailController.dispose();
    _fullNameController.dispose();
    _addressController.dispose();
    _phoneController.dispose();
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
              primary: AppColors.brand,
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

  /// Debounced real-time uniqueness checks against /auth/check-availability.
  void _scheduleAvailabilityCheck(String type, String value, void Function(bool?) update) {
    _availabilityDebounce?.cancel();
    if (value.trim().isEmpty) {
      setState(() => update(null));
      return;
    }
    _availabilityDebounce = Timer(const Duration(milliseconds: 600), () async {
      try {
        final result = await ref
            .read(authCheckServiceProvider)
            .checkAvailability(type, value.trim());
        if (mounted) setState(() => update(!result.available));
      } catch (_) {
        if (mounted) setState(() => update(null));
      }
    });
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    if (_usernameTaken == true || _emailTaken == true || _phoneTaken == true) {
      return;
    }
    if (!_acceptedAge) {
      setState(() => _ageError = true);
      return;
    }
    if (!_acceptedTerms) {
      setState(() => _termsError = true);
      return;
    }

    setState(() {
      _checkingGeo = true;
      _localError = null;
    });

    try {
      final geo = await GeoService.checkLocation();
      if (!geo.success || geo.latitude == null || geo.longitude == null) {
        setState(() {
          _checkingGeo = false;
          _localError = geo.message ?? 'Could not verify your location.';
        });
        return;
      }
      final locate = await ref
          .read(authCheckServiceProvider)
          .geoLocate(geo.latitude!, geo.longitude!);
      if (!locate.allowed) {
        setState(() {
          _checkingGeo = false;
          _localError = 'This app is not available in your country.';
        });
        return;
      }
      _countryCode = locate.countryCode;
    } catch (_) {
      setState(() {
        _checkingGeo = false;
        _localError = 'Could not verify your location. Please try again.';
      });
      return;
    }

    final auth = ref.read(authProvider.notifier);
    final ok = await auth.register(
      email: _emailController.text.trim().isEmpty ? null : _emailController.text.trim(),
      phone: _phoneController.text.trim().isEmpty ? null : _phoneController.text.trim(),
      username: _usernameController.text.trim().isEmpty ? null : _usernameController.text.trim(),
      fullName: _fullNameController.text.trim().isEmpty ? null : _fullNameController.text.trim(),
      address: _addressController.text.trim().isEmpty ? null : _addressController.text.trim(),
      password: _passwordController.text,
      dateOfBirth: _dateOfBirth!,
      countryCode: _countryCode,
    );
    if (ok) {
      // Auto-login succeeded: tokens are stored, so land straight on the app.
      if (mounted) context.go('/home');
    }
  }

  Widget _availabilityHelp(bool? taken, String message) {
    if (taken != true) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 6, left: 4),
      child: Text(
        message,
        style: GoogleFonts.inter(
          fontSize: 12,
          fontWeight: FontWeight.w400,
          color: AppColors.danger,
        ),
      ),
    );
  }

  InputDecoration _decoration({
    required String label,
    String? hint,
    Widget? prefixIcon,
    Widget? suffixIcon,
  }) {
    return InputDecoration(
      labelText: label,
      hintText: hint,
      hintStyle: GoogleFonts.inter(
        fontSize: 15,
        fontWeight: FontWeight.w400,
        color: AppColors.textMuted,
      ),
      filled: true,
      fillColor: AppColors.surface1,
      prefixIcon: prefixIcon,
      suffixIcon: suffixIcon,
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: AppColors.borderDim),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: AppColors.borderDim),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: BorderSide(color: AppColors.brand, width: 1.5),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final authState = ref.watch(authProvider);
    final strength = _passwordScore(_passwordController.text);
    final showStrength = _passwordController.text.isNotEmpty;
    final showError = _localError ?? authState.error;
    final isBusy = authState.isLoading || _checkingGeo;

    return Scaffold(
      backgroundColor: AppColors.voidBg,
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(24, 8, 24, 32),
          child: Form(
            key: _formKey,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Align(
                  alignment: Alignment.centerLeft,
                  child: IconButton(
                    onPressed: () => context.go('/landing'),
                    icon: const Icon(
                      LucideIcons.chevronLeft,
                      color: AppColors.textSecondary,
                      size: 24,
                    ),
                  ),
                ),
                const SizedBox(height: 16),
                Text(
                  'Create account',
                  style: GoogleFonts.sora(
                    fontSize: 28,
                    fontWeight: FontWeight.w700,
                    height: 1.2,
                    color: AppColors.textPrimary,
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  "Let's get you started",
                  style: GoogleFonts.inter(
                    fontSize: 15,
                    fontWeight: FontWeight.w400,
                    height: 1.4,
                    color: AppColors.textMuted,
                  ),
                ),
                const SizedBox(height: 32),
                TextFormField(
                  controller: _usernameController,
                  autocorrect: false,
                  onChanged: (v) =>
                      _scheduleAvailabilityCheck('username', v, (t) => _usernameTaken = t),
                  style: GoogleFonts.inter(
                    fontSize: 15,
                    fontWeight: FontWeight.w400,
                    color: AppColors.textPrimary,
                  ),
                  decoration: _decoration(
                    label: 'Username',
                    hint: 'Enter your username',
                    prefixIcon: const Icon(LucideIcons.userRound, color: AppColors.textMuted, size: 20),
                  ),
                  validator: (value) {
                    if (value == null || value.trim().isEmpty) {
                      return 'Enter a username';
                    }
                    if (_usernameTaken == true) {
                      return 'This username is already taken';
                    }
                    return null;
                  },
                ),
                _availabilityHelp(_usernameTaken, 'This username is already taken.'),
                const SizedBox(height: 16),
                TextFormField(
                  controller: _emailController,
                  keyboardType: TextInputType.emailAddress,
                  autocorrect: false,
                  onChanged: (v) =>
                      _scheduleAvailabilityCheck('email', v, (t) => _emailTaken = t),
                  style: GoogleFonts.inter(
                    fontSize: 15,
                    fontWeight: FontWeight.w400,
                    color: AppColors.textPrimary,
                  ),
                  decoration: _decoration(
                    label: 'Email',
                    hint: 'Enter your email',
                    prefixIcon: const Icon(LucideIcons.mail, color: AppColors.textMuted, size: 20),
                  ),
                  validator: (value) {
                    if (value == null || !value.contains('@')) {
                      return 'Enter a valid email address';
                    }
                    if (_emailTaken == true) {
                      return 'This email is already registered';
                    }
                    return null;
                  },
                ),
                _availabilityHelp(_emailTaken, 'This email is already registered.'),
                const SizedBox(height: 16),
                TextFormField(
                  controller: _fullNameController,
                  autocorrect: false,
                  style: GoogleFonts.inter(
                    fontSize: 15,
                    fontWeight: FontWeight.w400,
                    color: AppColors.textPrimary,
                  ),
                  decoration: _decoration(
                    label: 'Full Name',
                    hint: 'Enter your full name',
                    prefixIcon: const Icon(LucideIcons.idCard, color: AppColors.textMuted, size: 20),
                  ),
                  validator: (value) {
                    if (value == null || value.trim().isEmpty) {
                      return 'Enter your full name';
                    }
                    return null;
                  },
                ),
                const SizedBox(height: 16),
                TextFormField(
                  controller: _addressController,
                  autocorrect: false,
                  style: GoogleFonts.inter(
                    fontSize: 15,
                    fontWeight: FontWeight.w400,
                    color: AppColors.textPrimary,
                  ),
                  decoration: _decoration(
                    label: 'Residential Address',
                    hint: 'Enter your residential address',
                    prefixIcon: const Icon(LucideIcons.mapPin, color: AppColors.textMuted, size: 20),
                  ),
                  validator: (value) {
                    if (value == null || value.trim().isEmpty) {
                      return 'Enter your residential address';
                    }
                    return null;
                  },
                ),
                const SizedBox(height: 16),
                TextFormField(
                  controller: _phoneController,
                  keyboardType: TextInputType.phone,
                  autocorrect: false,
                  onChanged: (v) =>
                      _scheduleAvailabilityCheck('phone', v, (t) => _phoneTaken = t),
                  style: GoogleFonts.inter(
                    fontSize: 15,
                    fontWeight: FontWeight.w400,
                    color: AppColors.textPrimary,
                  ),
                  decoration: _decoration(
                    label: 'Phone',
                    hint: 'Enter your phone number',
                    prefixIcon: const Icon(LucideIcons.phone, color: AppColors.textMuted, size: 20),
                  ),
                  validator: (value) {
                    if (value == null || value.trim().isEmpty) {
                      return 'Enter your phone number';
                    }
                    if (!RegExp(r'^[0-9+\s-]{7,15}$').hasMatch(value.trim())) {
                      return 'Enter a valid phone number';
                    }
                    if (_phoneTaken == true) {
                      return 'This phone number is already registered';
                    }
                    return null;
                  },
                ),
                _availabilityHelp(_phoneTaken, 'This phone number is already registered.'),
                const SizedBox(height: 16),
                TextFormField(
                  controller: _passwordController,
                  obscureText: _obscurePassword,
                  style: GoogleFonts.inter(
                    fontSize: 15,
                    fontWeight: FontWeight.w400,
                    color: AppColors.textPrimary,
                  ),
                  onChanged: (_) {
                    setState(() {});
                    if (_confirmController.text.isNotEmpty) {
                      _confirmFieldKey.currentState?.validate();
                    }
                  },
                  decoration: _decoration(
                    label: 'Password',
                    hint: 'Enter your password',
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
                        style: GoogleFonts.inter(
                          fontSize: 13,
                          fontWeight: FontWeight.w400,
                          color: _strengthColor(strength),
                        ),
                      ),
                    ],
                  ),
                ],
                const SizedBox(height: 16),
                TextFormField(
                  key: _confirmFieldKey,
                  controller: _confirmController,
                  obscureText: _obscureConfirm,
                  // Only this field validates live (against the password);
                  autovalidateMode: AutovalidateMode.onUserInteraction,
                  style: GoogleFonts.inter(
                    fontSize: 15,
                    fontWeight: FontWeight.w400,
                    color: AppColors.textPrimary,
                  ),
                  decoration: _decoration(
                    label: 'Confirm password',
                    hint: 'Re-enter your password',
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
                  style: GoogleFonts.inter(
                    fontSize: 15,
                    fontWeight: FontWeight.w400,
                    color: AppColors.textPrimary,
                  ),
                  controller: _dobController,
                  decoration: _decoration(
                    label: 'Date of birth',
                    hint: 'Select your date of birth',
                    prefixIcon: const Icon(LucideIcons.calendar, color: AppColors.textMuted, size: 20),
                  ),
                  validator: (value) {
                    if (_dateOfBirth == null) {
                      return 'Select your date of birth';
                    }
                    if (!_isAdult(_dateOfBirth!)) {
                      return 'You must be 18 or older';
                    }
                    return null;
                  },
                ),
                const SizedBox(height: 8),
                CheckboxListTile(
                  value: _acceptedAge,
                  onChanged: (value) {
                    setState(() {
                      _acceptedAge = value ?? false;
                      _ageError = false;
                    });
                  },
                  contentPadding: EdgeInsets.zero,
                  controlAffinity: ListTileControlAffinity.leading,
                  activeColor: AppColors.brand,
                  title: Text(
                    'I confirm I am 18 or older.',
                    style: GoogleFonts.inter(
                      fontSize: 13,
                      fontWeight: FontWeight.w400,
                      color: AppColors.textMuted,
                    ),
                  ),
                ),
                if (_ageError) ...[
                  const SizedBox(height: 4),
                  Text(
                    'You must confirm you are 18 or older.',
                    style: GoogleFonts.inter(
                      fontSize: 13,
                      fontWeight: FontWeight.w400,
                      color: AppColors.danger,
                    ),
                  ),
                ],
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
                  activeColor: AppColors.brand,
                  title: Text(
                    'I agree to the Terms and Conditions.',
                    style: GoogleFonts.inter(
                      fontSize: 13,
                      fontWeight: FontWeight.w400,
                      color: AppColors.textMuted,
                    ),
                  ),
                ),
                if (_termsError) ...[
                  const SizedBox(height: 4),
                  Text(
                    'You must accept the terms before creating an account.',
                    style: GoogleFonts.inter(
                      fontSize: 13,
                      fontWeight: FontWeight.w400,
                      color: AppColors.danger,
                    ),
                  ),
                ],
                if (showError != null) ...[
                  const SizedBox(height: 12),
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: AppColors.danger.withOpacity(0.12),
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: AppColors.danger.withOpacity(0.4)),
                    ),
                    child: Text(
                      showError,
                      style: GoogleFonts.inter(
                        fontSize: 13,
                        fontWeight: FontWeight.w400,
                        color: AppColors.danger,
                      ),
                    ),
                  ),
                ],
                const SizedBox(height: 24),
                SizedBox(
                  width: double.infinity,
                  height: 52,
                  child: ElevatedButton(
                    onPressed: isBusy || _usernameTaken == true || _emailTaken == true || _phoneTaken == true
                        ? null
                        : _submit,
                    style: ElevatedButton.styleFrom(
                      backgroundColor: AppColors.brand,
                      foregroundColor: Colors.white,
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                      ),
                    ),
                    child: isBusy
                        ? const SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: Colors.white,
                            ),
                          )
                        : Text(
                            'Create account',
                            style: GoogleFonts.inter(
                              fontSize: 16,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                  ),
                ),
                const SizedBox(height: 20),
                Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Text(
                      'Already have an account?',
                      style: GoogleFonts.inter(
                        fontSize: 14,
                        fontWeight: FontWeight.w400,
                        color: AppColors.textSecondary,
                      ),
                    ),
                    const SizedBox(width: 4),
                    TextButton(
                      onPressed: () => context.go('/login'),
                      child: Text(
                        'Sign in',
                        style: GoogleFonts.inter(
                          fontSize: 14,
                          fontWeight: FontWeight.w600,
                          color: AppColors.brand,
                        ),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}