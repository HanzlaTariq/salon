import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';

void main() {
  runApp(CustomerApp(repository: AuthRepository(api: AuthApi())));
}

class CustomerApp extends StatelessWidget {
  const CustomerApp({super.key, required this.repository});

  final AuthRepository repository;

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
        signedInBuilder: (_) => SignedInHome(
          repository: repository,
          title: 'Salon',
          subtitle: 'Salon discovery aur booking Phase 7-8 mein aayega.',
          allowedRoles: const {'CUSTOMER'},
        ),
      ),
    );
  }
}
