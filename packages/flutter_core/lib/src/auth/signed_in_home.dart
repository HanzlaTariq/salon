import 'package:flutter/material.dart';

import '../theme/tokens.dart';
import '../widgets/state_views.dart';
import 'auth_repository.dart';

/// Signed-in shell used by both apps until the real screens exist.
/// Shows only real account data and a working sign-out. It is NOT a placeholder for features.
///
/// [allowedRoles] enforces which account types may use this app. A platform admin who opens the
/// customer app is told to use the admin web instead, and is signed out of this device.
class SignedInHome extends StatelessWidget {
  const SignedInHome({
    super.key,
    required this.repository,
    required this.title,
    required this.subtitle,
    required this.allowedRoles,
  });

  final AuthRepository repository;
  final String title;
  final String subtitle;
  final Set<String> allowedRoles;

  @override
  Widget build(BuildContext context) {
    final session = repository.session;
    if (session == null) return const SizedBox.shrink();
    final user = session.user;
    final theme = Theme.of(context);

    if (!allowedRoles.contains(user.role)) {
      return Scaffold(
        body: EmptyView(
          icon: Icons.lock_outline,
          title: 'This app is not for your account type',
          message: 'Your account (${user.role}) cannot use this app. Please use the correct app or the web dashboard.',
          action: FilledButton(onPressed: repository.logout, child: const Text('Sign out')),
        ),
      );
    }

    return Scaffold(
      appBar: AppBar(
        title: Text(title),
        actions: [
          IconButton(
            tooltip: 'Sign out',
            icon: const Icon(Icons.logout),
            onPressed: repository.logout,
          ),
        ],
      ),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 480),
          child: Padding(
            padding: const EdgeInsets.all(AppSpacing.xl),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Welcome, ${user.fullName}', style: theme.textTheme.headlineSmall),
                const SizedBox(height: AppSpacing.sm),
                Text(user.email, style: theme.textTheme.bodyMedium),
                const SizedBox(height: AppSpacing.lg),
                Text(
                  user.emailVerified ? 'E-mail verified' : 'E-mail not verified',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: user.emailVerified ? AppColors.emerald : AppColors.warning,
                  ),
                ),
                const SizedBox(height: AppSpacing.xl),
                Text(subtitle, style: theme.textTheme.bodyMedium),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
