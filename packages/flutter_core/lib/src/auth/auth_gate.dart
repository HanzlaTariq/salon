import 'package:flutter/material.dart';

import '../widgets/state_views.dart';
import 'auth_errors.dart';
import 'auth_repository.dart';
import 'auth_screen.dart';

/// Decides what the user sees: a restore spinner, a retry screen (offline), the sign-in flow,
/// or the app's signed-in content. Sign-in / sign-out flip the screen through [AuthRepository].
class AuthGate extends StatefulWidget {
  const AuthGate({
    super.key,
    required this.repository,
    required this.accountType,
    required this.signedInBuilder,
  });

  final AuthRepository repository;

  /// `CUSTOMER` or `SALON_OWNER`: the role a new account from this app is created with.
  final String accountType;
  final WidgetBuilder signedInBuilder;

  @override
  State<AuthGate> createState() => _AuthGateState();
}

class _AuthGateState extends State<AuthGate> {
  late Future<void> _restore = widget.repository.restoreSession();

  void _retry() => setState(() => _restore = widget.repository.restoreSession());

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<void>(
      future: _restore,
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return const Scaffold(body: LoadingView(label: 'Loading your account…'));
        }
        if (snapshot.hasError) {
          final error = snapshot.error;
          final message = error is ApiException && error.isNetwork
              ? 'No internet connection. Check your network and try again.'
              : 'We could not restore your session. Please try again.';
          return Scaffold(body: ErrorView(message: message, onRetry: _retry));
        }
        return ListenableBuilder(
          listenable: widget.repository,
          builder: (context, _) => widget.repository.isSignedIn
              ? widget.signedInBuilder(context)
              : AuthScreen(repository: widget.repository, accountType: widget.accountType),
        );
      },
    );
  }
}
