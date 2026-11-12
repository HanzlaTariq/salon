import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';

import 'billing/billing_api.dart';
import 'catalog/catalog_api.dart';
import 'salon/salon_api.dart';
import 'salon/salon_home.dart';
import 'team/staff_home.dart';
import 'team/team_api.dart';

void main() {
  final repository = AuthRepository(api: AuthApi());
  runApp(BusinessApp(
    repository: repository,
    salonApi: SalonApi(repository: repository),
    catalogApi: CatalogApi(repository: repository),
    teamApi: TeamApi(repository: repository),
    billingApi: BillingApi(repository: repository),
  ));
}

class BusinessApp extends StatelessWidget {
  const BusinessApp({super.key, required this.repository, required this.salonApi, required this.catalogApi, required this.teamApi, required this.billingApi});

  final AuthRepository repository;
  final SalonApi salonApi;
  final CatalogApi catalogApi;
  final TeamApi teamApi;
  final BillingApi billingApi;

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
          // Owners register and manage the salon. Staff accounts (Phase 5 invitations) see their own schedule only.
          if (role == 'SALON_OWNER') {
            return SalonHome(repository: repository, api: salonApi, catalogApi: catalogApi, teamApi: teamApi, billingApi: billingApi);
          }
          return StaffHome(repository: repository, api: teamApi);
        },
      ),
    );
  }
}
