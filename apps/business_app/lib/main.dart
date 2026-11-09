import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';

void main() {
  runApp(BusinessApp(repository: AuthRepository(api: AuthApi())));
}

class BusinessApp extends StatelessWidget {
  const BusinessApp({super.key, required this.repository});

  final AuthRepository repository;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Salon Business',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light(),
      darkTheme: AppTheme.dark(),
      home: AuthGate(
        repository: repository,
        accountType: 'SALON_OWNER',
        signedInBuilder: (_) => SignedInHome(
          repository: repository,
          title: 'Salon Business',
          subtitle: 'Owner dashboard Phase 3-5 mein banega. Staff accounts invite ke zariye bante hain.',
          // Staff accounts are created by an owner (Phase 5). They sign in through this same app.
          allowedRoles: const {'SALON_OWNER', 'SALON_STAFF'},
        ),
      ),
    );
  }
}
