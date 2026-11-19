import 'dart:convert';

import 'package:drift/drift.dart';

import 'app_database.dart';
import 'local_store.dart';
import 'offline_models.dart';

/// The SQLite implementation of [LocalStore].
class DriftLocalStore implements LocalStore {
  DriftLocalStore(this.db);
  final OfflineDatabase db;

  @override
  Future<List<OfflineAppointment>> appointments() async {
    final rows = await (db.select(db.appointmentRows)..orderBy([(t) => OrderingTerm.asc(t.startsAt)])).get();
    return rows.map((r) => OfflineAppointment(jsonDecode(r.json) as Map<String, dynamic>)).toList();
  }

  @override
  Future<List<OfflineNote>> notes() async {
    final rows = await db.select(db.noteRows).get();
    return rows.map((r) => OfflineNote.fromJson(jsonDecode(r.json) as Map<String, dynamic>)).toList();
  }

  @override
  Future<OfflineCatalog?> catalog() async {
    final raw = await meta('catalog');
    return raw == null ? null : OfflineCatalog.fromJson(jsonDecode(raw) as Map<String, dynamic>);
  }

  @override
  Future<void> applyPull({
    required bool full,
    required List<OfflineAppointment> appointments,
    required List<OfflineNote> notes,
    required Map<String, dynamic>? catalogJson,
    required DateTime windowFrom,
    required Set<String> keepIds,
  }) async {
    await db.transaction(() async {
      final incoming = appointments.map((a) => a.id).toSet();
      if (full) {
        // Everything of the window is in this answer: what is missing is gone (or left the window).
        final existing = await db.select(db.appointmentRows).get();
        final gone = existing.where((r) => !incoming.contains(r.id) && !keepIds.contains(r.id)).map((r) => r.id).toList();
        if (gone.isNotEmpty) {
          await (db.delete(db.appointmentRows)..where((t) => t.id.isIn(gone))).go();
          await (db.delete(db.noteRows)..where((t) => t.appointmentId.isIn(gone))).go();
        }
      } else {
        // A delta never removes; it only forgets what is clearly older than the window.
        final stale = await (db.select(db.appointmentRows)..where((t) => t.startsAt.isSmallerThanValue(windowFrom) & t.status.isNotValue('IN_PROGRESS'))).get();
        final drop = stale.where((r) => !keepIds.contains(r.id)).map((r) => r.id).toList();
        if (drop.isNotEmpty) {
          await (db.delete(db.appointmentRows)..where((t) => t.id.isIn(drop))).go();
          await (db.delete(db.noteRows)..where((t) => t.appointmentId.isIn(drop))).go();
        }
      }
      await db.batch((b) {
        for (final a in appointments) {
          b.insert(
            db.appointmentRows,
            AppointmentRowsCompanion.insert(id: a.id, staffId: a.staffId, startsAt: a.startsAt, status: a.status, json: jsonEncode(a.json)),
            mode: InsertMode.insertOrReplace,
          );
        }
        for (final n in notes) {
          b.insert(db.noteRows, NoteRowsCompanion.insert(id: n.id, appointmentId: n.appointmentId, json: jsonEncode(n.toJson())), mode: InsertMode.insertOrReplace);
        }
      });
      if (catalogJson != null) await setMeta('catalog', jsonEncode(catalogJson));
    });
  }

  @override
  Future<List<PendingOp>> ops() async {
    final rows = await (db.select(db.outboxRows)..orderBy([(t) => OrderingTerm.asc(t.seq)])).get();
    return rows.map((r) => PendingOp.fromStorage(r.json, seq: r.seq)).toList();
  }

  @override
  Future<PendingOp> enqueue(PendingOp op) async {
    final seq = await db.into(db.outboxRows).insert(OutboxRowsCompanion.insert(opId: op.id, state: op.state.name, json: op.toStorage()));
    return op.copyWith(seq: seq);
  }

  @override
  Future<void> updateOp(PendingOp op) async {
    await (db.update(db.outboxRows)..where((t) => t.opId.equals(op.id))).write(OutboxRowsCompanion(state: Value(op.state.name), json: Value(op.toStorage())));
  }

  @override
  Future<void> removeOp(String id) async {
    await (db.delete(db.outboxRows)..where((t) => t.opId.equals(id))).go();
  }

  @override
  Future<String?> meta(String key) async {
    final row = await (db.select(db.metaRows)..where((t) => t.key.equals(key))).getSingleOrNull();
    return row?.value;
  }

  @override
  Future<void> setMeta(String key, String value) async {
    await db.into(db.metaRows).insertOnConflictUpdate(MetaRowsCompanion.insert(key: key, value: value));
  }

  @override
  Future<void> wipe() async {
    await db.transaction(() async {
      for (final t in db.allTables) {
        await db.delete(t).go();
      }
    });
  }

  @override
  Future<void> close() => db.close();
}
