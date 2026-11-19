import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';

import 'attention_screen.dart';
import 'offline_models.dart';
import 'offline_overlay.dart';
import 'offline_scope.dart';
import 'sync_status_chip.dart';
import 'walk_in_sheet.dart';

/// The day's appointments, from the phone's own database. It works with no network: start, complete, no-show, notes and walk-ins are
/// saved on the phone and sent as soon as a connection exists. The server re-checks every rule; a refusal appears under "Needs attention".
///
/// Online-only features (the live forecast, early offers, arrival updates) stay in the live queue screen.
class OfflineTodayScreen extends StatefulWidget {
  const OfflineTodayScreen({super.key, required this.hub});
  final OfflineHub hub;

  @override
  State<OfflineTodayScreen> createState() => _OfflineTodayScreenState();
}

class _OfflineTodayScreenState extends State<OfflineTodayScreen> {
  List<LocalAppointment> _all = const [];
  List<PendingOp> _ops = const [];
  OfflineCatalog? _catalog;
  bool _loading = true;
  bool _today = true;

  OfflineHub get _hub => widget.hub;

  @override
  void initState() {
    super.initState();
    _hub.engine.addListener(_reload);
    _reload();
  }

  @override
  void dispose() {
    _hub.engine.removeListener(_reload);
    super.dispose();
  }

  Future<void> _reload() async {
    final cached = await _hub.store.appointments();
    final notes = await _hub.store.notes();
    final ops = await _hub.store.ops();
    final catalog = await _hub.store.catalog();
    if (!mounted) return;
    setState(() {
      _ops = ops;
      _catalog = catalog;
      _all = overlayLocal(cached: cached, notes: notes, ops: ops);
      _loading = false;
    });
  }

  bool _isToday(LocalAppointment a) {
    final s = a.startsAt?.toLocal();
    if (s == null) return true; // a provisional walk-in belongs to today
    final n = DateTime.now();
    return a.inProgress || (s.year == n.year && s.month == n.month && s.day == n.day);
  }

  Future<void> _enqueue(PendingOp op) async {
    await _hub.engine.enqueue(op);
    await _reload();
  }

  /// A walk-in that exists only on this phone is addressed by its operation id; one the server already placed by its real id.
  PendingOp _action(String kind, LocalAppointment a, {Map<String, dynamic> payload = const {}}) {
    final localWalkIn = _ops.any((o) => o.kind == SyncKind.walkIn && o.id == a.id);
    return PendingOp(
      id: newUuid(),
      kind: kind,
      createdAt: DateTime.now().toUtc(),
      appointmentId: localWalkIn ? null : a.id,
      refOperationId: localWalkIn ? a.id : null,
      payload: payload,
      local: {'label': a.customerName},
    );
  }

  Future<bool> _confirm(String title, String body, String yes) async =>
      (await showDialog<bool>(
        context: context,
        builder: (c) => AlertDialog(
          title: Text(title),
          content: Text(body),
          actions: [
            TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(c, true), child: Text(yes)),
          ],
        ),
      )) ??
      false;

  Future<void> _complete(LocalAppointment a) async {
    if (await _confirm('Complete this service?', '${a.customerName} · ${a.serviceNames.join(', ')}', 'Complete')) await _enqueue(_action(SyncKind.complete, a));
  }

  Future<void> _noShow(LocalAppointment a) async {
    if (await _confirm('Mark as no-show?', '${a.customerName} did not arrive. The customer is told and it is saved in the history.', 'Mark no-show')) {
      await _enqueue(_action(SyncKind.noShow, a));
    }
  }

  Future<void> _note(LocalAppointment a) async {
    final controller = TextEditingController();
    final text = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      builder: (c) => Padding(
        padding: EdgeInsets.fromLTRB(AppSpacing.lg, AppSpacing.lg, AppSpacing.lg, MediaQuery.of(c).viewInsets.bottom + AppSpacing.lg),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Note for ${a.customerName}', style: Theme.of(c).textTheme.titleMedium),
          const SizedBox(height: AppSpacing.md),
          TextField(controller: controller, autofocus: true, maxLength: 500, maxLines: 3, decoration: const InputDecoration(labelText: 'Note (visible to your salon only)')),
          const SizedBox(height: AppSpacing.md),
          FilledButton(onPressed: () => Navigator.pop(c, controller.text.trim()), child: const Text('Save note')),
        ]),
      ),
    );
    controller.dispose();
    if (text != null && text.isNotEmpty) await _enqueue(_action(SyncKind.note, a, payload: {'body': text}));
  }

  Future<void> _walkIn() async {
    final catalog = _catalog;
    if (catalog == null) return;
    final op = await showWalkInSheet(context, catalog);
    if (op != null) await _enqueue(op);
  }

  @override
  Widget build(BuildContext context) {
    final engine = _hub.engine;
    final status = engine.status;
    final catalog = _catalog;
    final canWalkIn = catalog != null && (catalog.isOwner || catalog.staff.any((s) => s.canAddWalkIn));
    final rules = LocalRules(_all);
    final shown = _all.where((a) => _today ? _isToday(a) : !_isToday(a)).toList();

    return Scaffold(
      appBar: AppBar(title: const Text('Appointments'), actions: [SyncStatusChip(status: status, onTap: () => engine.syncNow())]),
      floatingActionButton: canWalkIn ? FloatingActionButton.extended(onPressed: _walkIn, icon: const Icon(Icons.person_add_alt_1), label: const Text('Walk-in')) : null,
      body: Column(children: [
        if (status.phase == SyncPhase.offline) _banner(AppColors.warning, Icons.cloud_off_outlined, 'You are offline. Changes are saved on this phone and sent when you are back online.'),
        if (status.phase == SyncPhase.failed && status.message != null) _banner(AppColors.danger, Icons.error_outline, status.message!),
        if (status.phase != SyncPhase.failed && status.message != null) _banner(AppColors.warning, Icons.info_outline, status.message!),
        if (status.clockLooksWrong) _banner(AppColors.warning, Icons.schedule, "This phone's clock looks wrong. Times of changes made offline may be inaccurate: please correct the date and time."),
        if (status.needsAttention > 0)
          ListTile(
            leading: const Icon(Icons.report_problem_outlined, color: AppColors.danger),
            title: Text('${status.needsAttention} change${status.needsAttention == 1 ? '' : 's'} need your attention'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => AttentionScreen(engine: engine, store: _hub.store))),
          ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg, vertical: AppSpacing.sm),
          child: SegmentedButton<bool>(
            segments: const [ButtonSegment(value: true, label: Text('Today')), ButtonSegment(value: false, label: Text('Other days'))],
            selected: {_today},
            onSelectionChanged: (s) => setState(() => _today = s.first),
          ),
        ),
        Expanded(
          child: RefreshIndicator(
            onRefresh: () => engine.syncNow(full: true),
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : shown.isEmpty
                    ? ListView(children: [
                        const SizedBox(height: AppSpacing.xxxl),
                        Center(child: Text(status.lastSyncedAt == null && status.phase == SyncPhase.offline ? 'Nothing is saved on this phone yet. Connect once to load your schedule.' : 'No appointments here.')),
                      ])
                    : ListView.separated(
                        padding: const EdgeInsets.fromLTRB(AppSpacing.lg, AppSpacing.sm, AppSpacing.lg, 96),
                        itemCount: shown.length,
                        separatorBuilder: (_, __) => const SizedBox(height: AppSpacing.md),
                        itemBuilder: (_, i) => _card(shown[i], rules),
                      ),
          ),
        ),
      ]),
    );
  }

  Widget _banner(Color color, IconData icon, String text) => Container(
        width: double.infinity,
        color: color.withOpacity(0.12),
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg, vertical: AppSpacing.sm),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(icon, size: 18, color: color),
          const SizedBox(width: AppSpacing.sm),
          Expanded(child: Text(text, style: TextStyle(color: color))),
        ]),
      );

  Widget _card(LocalAppointment a, LocalRules rules) {
    final style = Theme.of(context).textTheme;
    final now = DateTime.now().toUtc();
    final when = a.provisional ? 'Time pending' : '${a.time}${a.endTime.isEmpty ? '' : ' – ${a.endTime}'}';
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(child: Text(when, style: style.titleMedium)),
            _statusPill(a),
          ]),
          const SizedBox(height: AppSpacing.xs),
          Text(a.customerName, style: style.titleSmall),
          if (_hub.isOwner && a.customerPhone != null) Text(a.customerPhone!, style: style.bodySmall),
          if (a.serviceNames.isNotEmpty) Text(a.serviceNames.join(', '), style: style.bodyMedium),
          Text('Rs. ${a.price}${a.durationMinutes > 0 ? ' · ${a.durationMinutes} min' : ''}${_hub.isOwner && a.staffName.isNotEmpty ? ' · ${a.staffName}' : ''}', style: style.bodySmall),
          if (a.provisional)
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.sm),
              child: Text('Not confirmed yet. The server will place this walk-in when you are online.', style: TextStyle(color: AppColors.warning)),
            ),
          if (a.waitingActions > 0)
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.xs),
              child: Text('${a.waitingActions} change${a.waitingActions == 1 ? '' : 's'} waiting to sync', style: const TextStyle(color: AppColors.info)),
            ),
          for (final n in a.notes) Padding(padding: const EdgeInsets.only(top: AppSpacing.xs), child: Text('Note: ${n.body}', style: style.bodySmall)),
          const SizedBox(height: AppSpacing.md),
          Wrap(spacing: AppSpacing.sm, runSpacing: AppSpacing.sm, children: [
            if (rules.canStart(a, now)) FilledButton(onPressed: () => _enqueue(_action(SyncKind.start, a)), child: const Text('Start')),
            if (rules.canComplete(a)) FilledButton(onPressed: () => _complete(a), child: const Text('Complete')),
            if (rules.canNoShow(a, now)) OutlinedButton(onPressed: () => _noShow(a), child: const Text('No-show')),
            if (!a.done || a.notes.isEmpty) TextButton(onPressed: () => _note(a), child: const Text('Add note')),
          ]),
          if (a.open && !rules.canStart(a, now) && rules.staffBusy(a))
            Padding(padding: const EdgeInsets.only(top: AppSpacing.xs), child: Text('Complete the service in progress first.', style: style.bodySmall)),
        ]),
      ),
    );
  }

  Widget _statusPill(LocalAppointment a) {
    final (label, color) = switch (a.status) {
      'IN_PROGRESS' => ('In progress', AppColors.info),
      'COMPLETED' => ('Completed', AppColors.emerald),
      'NO_SHOW' => ('No-show', AppColors.danger),
      'CANCELLED' => ('Cancelled', AppColors.danger),
      _ => (a.provisional ? 'Pending sync' : 'Confirmed', a.provisional ? AppColors.warning : AppColors.mutedText),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm, vertical: AppSpacing.xs),
      decoration: BoxDecoration(color: color.withOpacity(0.12), borderRadius: BorderRadius.circular(AppRadius.full)),
      child: Text(label, style: TextStyle(color: color, fontWeight: FontWeight.w600, fontSize: 12)),
    );
  }
}
