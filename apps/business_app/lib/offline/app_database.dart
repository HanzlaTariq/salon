import 'dart:io';

import 'package:drift/drift.dart';
import 'package:drift/native.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

part 'app_database.g.dart';

/// One cached appointment of the window. The full server JSON is kept in `json`; the columns exist for filtering and ordering.
@DataClassName('AppointmentRow')
class AppointmentRows extends Table {
  TextColumn get id => text()();
  TextColumn get staffId => text()();
  DateTimeColumn get startsAt => dateTime()();
  TextColumn get status => text()();
  TextColumn get json => text()();

  @override
  Set<Column> get primaryKey => {id};
}

@DataClassName('NoteRow')
class NoteRows extends Table {
  TextColumn get id => text()();
  TextColumn get appointmentId => text()();
  TextColumn get json => text()();

  @override
  Set<Column> get primaryKey => {id};
}

/// The outbox: operations done on this phone that the server may not have yet. `seq` keeps the order the person acted in.
@DataClassName('OutboxRow')
class OutboxRows extends Table {
  IntColumn get seq => integer().autoIncrement()();
  TextColumn get opId => text().unique()();
  TextColumn get state => text()();
  TextColumn get json => text()();
}

@DataClassName('MetaRow')
class MetaRows extends Table {
  TextColumn get key => text()();
  TextColumn get value => text()();

  @override
  Set<Column> get primaryKey => {key};
}

@DriftDatabase(tables: [AppointmentRows, NoteRows, OutboxRows, MetaRows])
class OfflineDatabase extends _$OfflineDatabase {
  OfflineDatabase(super.executor);

  /// One database FILE per signed-in user: another account on the same phone never sees (or sends) this one's data.
  factory OfflineDatabase.forUser(String userId) => OfflineDatabase(LazyDatabase(() async {
        final dir = await getApplicationSupportDirectory();
        return NativeDatabase.createInBackground(File(p.join(dir.path, 'offline_${_safe(userId)}.sqlite')));
      }));

  static String _safe(String id) => id.replaceAll(RegExp(r'[^A-Za-z0-9_-]'), '_');

  static Future<void> deleteFileFor(String userId) async {
    final dir = await getApplicationSupportDirectory();
    final base = p.join(dir.path, 'offline_${_safe(userId)}.sqlite');
    for (final suffix in const ['', '-wal', '-shm', '-journal']) {
      final f = File('$base$suffix');
      if (await f.exists()) await f.delete();
    }
  }

  @override
  int get schemaVersion => 1;
}
