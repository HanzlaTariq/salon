import 'package:flutter/material.dart';

import 'offline_scope.dart';
import 'offline_today_screen.dart';

/// Opens the offline-capable appointments screen. The hub exists as soon as the person is signed in (it opens in a moment).
void openOfflineAppointments(BuildContext context) {
  final hub = OfflineScope.maybeOf(context);
  if (hub == null) {
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Getting your offline data ready. Try again in a moment.')));
    return;
  }
  Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => OfflineTodayScreen(hub: hub)));
}
