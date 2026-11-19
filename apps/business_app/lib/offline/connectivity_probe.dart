import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';

/// "Is there a network at all?" The radio being on does not prove the server is reachable, so the engine ALSO treats any failed request
/// as offline. This only tells it WHEN to try again (the moment a network appears).
abstract class ConnectivityProbe {
  Stream<bool> get changes;
  Future<bool> isOnline();
}

class PlatformConnectivityProbe implements ConnectivityProbe {
  PlatformConnectivityProbe({Connectivity? connectivity}) : _c = connectivity ?? Connectivity();
  final Connectivity _c;

  static bool _up(List<ConnectivityResult> r) => r.any((x) => x != ConnectivityResult.none);

  @override
  Stream<bool> get changes => _c.onConnectivityChanged.map(_up).distinct();

  @override
  Future<bool> isOnline() async => _up(await _c.checkConnectivity());
}
