import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';

import 'discovery/discovery_api.dart';
import 'discovery/discovery_home_screen.dart';

void main() {
  runApp(CustomerApp(repository: AuthRepository(api: AuthApi()), discoveryApi: DiscoveryApi()));
}

class CustomerApp extends StatelessWidget {
  const CustomerApp({super.key, required this.repository, required this.discoveryApi});

  final AuthRepository repository;
  final DiscoveryApi discoveryApi;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Salon',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light(),
      darkTheme: AppTheme.dark(),
      home: AuthGate(
        repository: repository,
        accountType: 'CUSTOMER',
        signedInBuilder: (_) => _CustomerHome(repository: repository, api: discoveryApi),
      ),
    );
  }
}

/// Only CUSTOMER accounts use this app; any other account type is told so and signed out of this device.
class _CustomerHome extends StatelessWidget {
  const _CustomerHome({required this.repository, required this.api});

  final AuthRepository repository;
  final DiscoveryApi api;

  @override
  Widget build(BuildContext context) {
    final user = repository.session?.user;
    if (user == null) return const SizedBox.shrink();
    if (user.role != 'CUSTOMER') {
      return Scaffold(
        body: EmptyView(
          icon: Icons.lock_outline,
          title: 'This app is not for your account type',
          message: 'Your account (${user.role}) cannot use this app. Please use the correct app or the web dashboard.',
          action: FilledButton(onPressed: repository.logout, child: const Text('Sign out')),
        ),
      );
    }
    return DiscoveryHomeScreen(api: api, repository: repository);
  }
}
