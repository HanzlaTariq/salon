import 'offline_models.dart';

/// Everything the phone keeps for offline use. The engine and the screens only know this interface: the real one is SQLite (Drift),
/// the tests use an in-memory one.
abstract class LocalStore {
  Future<List<OfflineAppointment>> appointments();
  Future<List<OfflineNote>> notes();
  Future<OfflineCatalog?> catalog();

  /// Stores a pull. [full]: everything of the window is in [appointments], so cached appointments that are NOT in it are removed
  /// (cancelled-and-gone, moved out of the window...) unless a waiting operation still points at them. A delta only adds / replaces.
  Future<void> applyPull({
    required bool full,
    required List<OfflineAppointment> appointments,
    required List<OfflineNote> notes,
    required Map<String, dynamic>? catalogJson,
    required DateTime windowFrom,
    required Set<String> keepIds,
  });

  Future<List<PendingOp>> ops();
  /// Appends an operation (the store assigns `seq`, which keeps the order the person acted in).
  Future<PendingOp> enqueue(PendingOp op);
  Future<void> updateOp(PendingOp op);
  Future<void> removeOp(String id);

  Future<String?> meta(String key);
  Future<void> setMeta(String key, String value);

  /// Removes everything (sign-out). Waiting operations of a signed-out person must never be sent under another account.
  Future<void> wipe();
  Future<void> close();
}

abstract final class MetaKey {
  static const cursor = 'cursor';
  static const lastFullAt = 'lastFullAt';
  static const deviceId = 'deviceId';
  static const lastSyncedAt = 'lastSyncedAt';
}
