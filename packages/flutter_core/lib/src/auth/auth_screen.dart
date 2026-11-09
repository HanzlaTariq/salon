import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme/tokens.dart';
import 'auth_errors.dart';
import 'auth_repository.dart';

enum _Mode { signIn, register, checkEmail }

final _emailPattern = RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$');

/// Sign-in, registration and "check your e-mail" screen. Shared by both apps.
/// Field rules here are only for quick feedback; the API is the authority (it re-validates everything).
class AuthScreen extends StatefulWidget {
  const AuthScreen({super.key, required this.repository, required this.accountType});

  final AuthRepository repository;

  /// Role for new accounts created from this app (`CUSTOMER` or `SALON_OWNER`).
  final String accountType;

  @override
  State<AuthScreen> createState() => _AuthScreenState();
}

class _AuthScreenState extends State<AuthScreen> {
  final _formKey = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _mfa = TextEditingController();

  _Mode _mode = _Mode.signIn;
  bool _busy = false;
  bool _mfaRequired = false;
  bool _canResendVerification = false;
  String? _error;
  String? _info;
  List<String> _details = const [];

  @override
  void dispose() {
    _name.dispose();
    _email.dispose();
    _password.dispose();
    _mfa.dispose();
    super.dispose();
  }

  void _switchMode(_Mode mode) {
    setState(() {
      _mode = mode;
      _error = null;
      _info = null;
      _details = const [];
      _canResendVerification = false;
    });
  }

  /// Runs one auth action with a single busy/error path. Success may unmount this screen
  /// (the AuthGate swaps it for the signed-in content), so every setState checks `mounted`.
  Future<void> _run(Future<void> Function() action) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
      _info = null;
      _details = const [];
      _canResendVerification = false;
    });
    try {
      await action();
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.message;
        _details = e.details;
        if (e.code == 'MFA_REQUIRED') _mfaRequired = true;
        _canResendVerification = e.code == 'EMAIL_NOT_VERIFIED';
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _error = 'Something went wrong. Please try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _signIn() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    await _run(() => widget.repository.login(
          email: _email.text.trim().toLowerCase(),
          password: _password.text,
          mfaCode: _mfaRequired ? _mfa.text.trim() : null,
        ));
  }

  Future<void> _register() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    final email = _email.text.trim().toLowerCase();
    await _run(() async {
      await widget.repository.register(
        email: email,
        password: _password.text,
        fullName: _name.text.trim(),
        accountType: widget.accountType,
      );
      if (!mounted) return;
      setState(() {
        _mode = _Mode.checkEmail;
        _info = 'If the details are valid, a verification e-mail has been sent to $email.';
      });
    });
  }

  Future<void> _resend() async {
    final email = _email.text.trim().toLowerCase();
    await _run(() async {
      await widget.repository.resendVerification(email);
      if (!mounted) return;
      setState(() => _info = 'If the account needs verification, a new e-mail has been sent.');
    });
  }

  String? _requiredEmail(String? v) {
    final value = v?.trim() ?? '';
    if (value.isEmpty) return 'Enter your e-mail address.';
    if (!_emailPattern.hasMatch(value) || value.length > 254) return 'Enter a valid e-mail address.';
    return null;
  }

  String? _newPassword(String? v) {
    final value = v ?? '';
    if (value.length < 10) return 'Use at least 10 characters.';
    if (value.length > 128) return 'Use at most 128 characters.';
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final title = switch (_mode) {
      _Mode.signIn => 'Sign in',
      _Mode.register => 'Create your account',
      _Mode.checkEmail => 'Verify your e-mail',
    };

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(AppSpacing.xl),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 440),
              child: Form(
                key: _formKey,
                child: AutofillGroup(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Text(title, style: theme.textTheme.headlineMedium, textAlign: TextAlign.center),
                      const SizedBox(height: AppSpacing.xl),
                      if (_info != null) _Banner(text: _info!, tone: _BannerTone.info),
                      if (_error != null)
                        _Banner(text: _error!, details: _details, tone: _BannerTone.danger),
                      if (_mode == _Mode.checkEmail) ...[
                        Text(
                          'Open the link in the e-mail, then come back and sign in. The link works on any device.',
                          style: theme.textTheme.bodyMedium,
                          textAlign: TextAlign.center,
                        ),
                        const SizedBox(height: AppSpacing.lg),
                        OutlinedButton(
                          onPressed: _busy ? null : _resend,
                          child: const Text('Resend verification e-mail'),
                        ),
                        const SizedBox(height: AppSpacing.sm),
                        TextButton(onPressed: () => _switchMode(_Mode.signIn), child: const Text('Back to sign in')),
                      ] else ...[
                        if (_mode == _Mode.register) ...[
                          TextFormField(
                            controller: _name,
                            textInputAction: TextInputAction.next,
                            autofillHints: const [AutofillHints.name],
                            decoration: const InputDecoration(labelText: 'Full name'),
                            validator: (v) {
                              final len = v?.trim().length ?? 0;
                              return (len < 2 || len > 120) ? 'Enter 2 to 120 characters.' : null;
                            },
                          ),
                          const SizedBox(height: AppSpacing.md),
                        ],
                        TextFormField(
                          controller: _email,
                          keyboardType: TextInputType.emailAddress,
                          textInputAction: TextInputAction.next,
                          autofillHints: const [AutofillHints.email],
                          decoration: const InputDecoration(labelText: 'E-mail'),
                          validator: _requiredEmail,
                        ),
                        const SizedBox(height: AppSpacing.md),
                        TextFormField(
                          controller: _password,
                          obscureText: true,
                          textInputAction: _mfaRequired ? TextInputAction.next : TextInputAction.done,
                          autofillHints: [
                            _mode == _Mode.register ? AutofillHints.newPassword : AutofillHints.password,
                          ],
                          decoration: InputDecoration(
                            labelText: 'Password',
                            helperText: _mode == _Mode.register ? 'At least 10 characters.' : null,
                          ),
                          validator: _mode == _Mode.register
                              ? _newPassword
                              : (v) => (v == null || v.isEmpty) ? 'Enter your password.' : null,
                          onFieldSubmitted: (_) => _mode == _Mode.register ? _register() : _signIn(),
                        ),
                        if (_mode == _Mode.signIn && _mfaRequired) ...[
                          const SizedBox(height: AppSpacing.md),
                          TextFormField(
                            controller: _mfa,
                            keyboardType: TextInputType.number,
                            textInputAction: TextInputAction.done,
                            inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9A-Za-z-]'))],
                            decoration: const InputDecoration(
                              labelText: 'Authenticator code',
                              helperText: 'Enter the 6-digit code, or a recovery code.',
                            ),
                            validator: (v) => (v == null || v.trim().isEmpty) ? 'Enter the code.' : null,
                            onFieldSubmitted: (_) => _signIn(),
                          ),
                        ],
                        const SizedBox(height: AppSpacing.xl),
                        FilledButton(
                          onPressed: _busy ? null : (_mode == _Mode.register ? _register : _signIn),
                          child: _busy
                              ? const SizedBox(
                                  height: 20,
                                  width: 20,
                                  child: CircularProgressIndicator(strokeWidth: 2),
                                )
                              : Text(_mode == _Mode.register ? 'Create account' : 'Sign in'),
                        ),
                        if (_canResendVerification) ...[
                          const SizedBox(height: AppSpacing.sm),
                          TextButton(
                            onPressed: _busy ? null : _resend,
                            child: const Text('Resend verification e-mail'),
                          ),
                        ],
                        const SizedBox(height: AppSpacing.md),
                        TextButton(
                          onPressed: () => _switchMode(_mode == _Mode.register ? _Mode.signIn : _Mode.register),
                          child: Text(
                            _mode == _Mode.register ? 'Already have an account? Sign in' : 'New here? Create an account',
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
}

enum _BannerTone { info, danger }

class _Banner extends StatelessWidget {
  const _Banner({required this.text, required this.tone, this.details = const []});

  final String text;
  final List<String> details;
  final _BannerTone tone;

  @override
  Widget build(BuildContext context) {
    final color = tone == _BannerTone.danger ? AppColors.danger : AppColors.info;
    final theme = Theme.of(context);
    return Semantics(
      liveRegion: true,
      child: Container(
        margin: const EdgeInsets.only(bottom: AppSpacing.lg),
        padding: const EdgeInsets.all(AppSpacing.md),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.08),
          border: Border.all(color: color.withValues(alpha: 0.4)),
          borderRadius: BorderRadius.circular(AppRadius.card),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(text, style: theme.textTheme.bodyMedium?.copyWith(color: color)),
            for (final d in details)
              Padding(
                padding: const EdgeInsets.only(top: AppSpacing.xs),
                child: Text('• $d', style: theme.textTheme.bodySmall?.copyWith(color: color)),
              ),
          ],
        ),
      ),
    );
  }
}
