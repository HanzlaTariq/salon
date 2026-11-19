import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';

import 'app_database.dart';
import 'connectivity_probe.dart';
import 'drift_store.dart';
import 'local_store.dart';
import 'offline_models.dart';
import 'sync_engine.dart';
import 'sync_gateway.dart';

/// Everything the offline screens need for ONE signed-in person: a private SQLite file, the sync engine, the role.
class OfflineHub {
  OfflineHub({required this.userId, required this.role, required this.store, required this.engine, this.database});

  final String userId;
  final String role;
  final LocalStore store;
  final SyncEngine engine;
  final OfflineDatabase? database;

  bool get isOwner => role == 'SALON_OWNER';

  /// [wipe] on sign-out: the phone keeps nothing of the salon, and waiting operations can never be sent under another account.
  Future<void> close({required bool wipe}) async {
    engine.dispose();
    if (wipe) await store.wipe();
    await store.close();
    if (wipe) await OfflineDatabase.deleteFileFor(userId);
  }
}

/// Opens the hub when an owner or a staff member is signed in and wipes it when they sign out (or another account signs in).
/// It sits ABOVE the sign-in gate, so a token refresh or a rebuild of the screens never touches the waiting operations.
class OfflineScope extends StatefulWidget {
  const OfflineScope({super.key, required this.repository, required this.gateway, required this.child});

  final AuthRepository repository;
  final SyncGateway gateway;
  final Widget child;

  static OfflineHub? maybeOf(BuildContext context) => context.dependOnInheritedWidgetOfExactType<_HubInherited>()?.hub;

  @override
  State<OfflineScope> createState() => _OfflineScopeState();
}

class _OfflineScopeState extends State<OfflineScope> {
  OfflineHub? _hub;
  bool _busy = false;
  bool _recheck = false;

  @override
  void initState() {
    super.initState();
    widget.repository.addListener(_onSession);
    unawaited(_onSession());
  }

  @override
  void dispose() {
    widget.repository.removeListener(_onSession);
    final hub = _hub;
    if (hub != null) unawaited(hub.close(wipe: false)); // the app is closing: keep the waiting operations for the next start
    super.dispose();
  }

  Future<void> _onSession() async {
    if (_busy) {
      _recheck = true;
      return;
    }
    _busy = true;
    try {
      do {
        _recheck = false;
        final user = widget.repository.session?.user;
        final wanted = user != null && (user.role == 'SALON_OWNER' || user.role == 'SALON_STAFF') ? user : null;
        final current = _hub;
        if (current != null && (wanted == null || wanted.id != current.userId)) {
          setState(() => _hub = null);
          await current.close(wipe: true);
        }
        if (wanted != null && _hub == null) {
          final hub = await _open(wanted.id, wanted.role);
          if (mounted) {
            setState(() => _hub = hub);
          } else {
            await hub.close(wipe: false);
          }
        }
      } while (_recheck && mounted);
    } finally {
      _busy = false;
    }
  }

  Future<OfflineHub> _open(String userId, String role) async {
    final db = OfflineDatabase.forUser(userId);
    final store = DriftLocalStore(db);
    var deviceId = await store.meta(MetaKey.deviceId);
    if (deviceId == null) {
      deviceId = newUuid();
      await store.setMeta(MetaKey.deviceId, deviceId);
    }
    final engine = SyncEngine(store: store, gateway: widget.gateway, probe: PlatformConnectivityProbe(), deviceId: deviceId)..start();
    return OfflineHub(userId: userId, role: role, store: store, engine: engine, database: db);
  }

  @override
  Widget build(BuildContext context) => _HubInherited(hub: _hub, child: widget.child);
}

class _HubInherited extends InheritedWidget {
  const _HubInherited({required this.hub, required super.child});
  final OfflineHub? hub;

  @override
  bool updateShouldNotify(_HubInherited old) => old.hub != hub;
}
