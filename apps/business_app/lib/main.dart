import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';

import 'catalog/catalog_api.dart';
import 'salon/salon_api.dart';
import 'salon/salon_home.dart';

void main() {
  final repository = AuthRepository(api: AuthApi());
  runApp(BusinessApp(repository: repository, salonApi: SalonApi(repository: repository), catalogApi: CatalogApi(repository: repository)));
}

class BusinessApp extends StatelessWidget {
  const BusinessApp({super.key, required this.repository, required this.salonApi, required this.catalogApi});

  final AuthRepository repository;
  final SalonApi salonApi;
  final CatalogApi catalogApi;

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
        signedInBuilder: (_) {
          final role = repository.session?.user.role;
          // Owners register and manage the salon. Staff accounts (invited by an owner, Phase 5) keep the
          // basic home until their dashboard exists.
          if (role == 'SALON_OWNER') return SalonHome(repository: repository, api: salonApi, catalogApi: catalogApi);
          return SignedInHome(
            repository: repository,
            title: 'Salon Business',
            subtitle: 'Your staff dashboard arrives in a later release.',
            allowedRoles: const {'SALON_OWNER', 'SALON_STAFF'},
          );
        },
      ),
    );
  }
}
