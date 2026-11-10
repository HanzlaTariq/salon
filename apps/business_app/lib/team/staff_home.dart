import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';

import 'team_api.dart';
import 'team_models.dart';

/// Staff dashboard (SALON_STAFF). Shows ONLY the signed-in person's own hours, breaks and leave.
/// Breaks and leave requests are enabled when the owner granted `schedule.manage_own`.
class StaffHome extends StatefulWidget {
  const StaffHome({super.key, required this.repository, required this.api});

  final AuthRepository repository;
  final TeamApi api;

  @override
  State<StaffHome> createState() => _StaffHomeState();
}

class _StaffHomeState extends State<StaffHome> {
  StaffMe? _me;
  bool _loading = true;
  bool _busy = false;
  ApiException? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final me = await widget.api.staffMe();
      if (mounted) setState(() => _me = me);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _run(Future<void> Function() action, String done) async {
    setState(() => _busy = true);
    try {
      await action();
      await _load();
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(done)));
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _requestLeave() async {
    final input = await showDialog<(String, String, String)>(context: context, builder: (_) => const _RequestDialog());
    if (input == null) return;
    await _run(() => widget.api.requestLeave(startsOn: input.$1, endsOn: input.$2, reason: input.$3).then((_) {}), 'Leave request sent to your owner');
  }

  @override
  Widget build(BuildContext context) {
    final me = _me;
    final style = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(
        title: const Text('My schedule'),
        actions: [IconButton(tooltip: 'Sign out', icon: const Icon(Icons.logout), onPressed: () => widget.repository.logout())],
      ),
      body: _loading && me == null
          ? const LoadingView(label: 'Loading your schedule…')
          : _error != null
              ? ErrorView(message: _error!.message, requestId: _error!.requestId, onRetry: _load)
              : me == null
                  ? const EmptyView(title: 'No schedule yet')
                  : RefreshIndicator(
                      onRefresh: _load,
                      child: ListView(
                        padding: const EdgeInsets.all(AppSpacing.lg),
                        children: [
                          Text(me.displayName, style: style.titleLarge),
                          Text(me.salonName, style: style.bodyMedium),
                          if (me.salonStatus != 'APPROVED')
                            Padding(
                              padding: const EdgeInsets.only(top: AppSpacing.sm),
                              child: Text('Your salon is not active right now.', style: const TextStyle(color: AppColors.danger)),
                            ),
                          const SizedBox(height: AppSpacing.xl),
                          Text('Weekly hours', style: style.titleMedium),
                          for (final h in me.workingHours)
                            ListTile(
                              contentPadding: EdgeInsets.zero,
                              dense: true,
                              title: Text(kWeekdayNames[h.weekday]),
                              trailing: Text(!h.configured ? 'Not set' : h.off ? 'Off' : '${h.startsAt} – ${h.endsAt}'),
                            ),
                          const SizedBox(height: AppSpacing.lg),
                          Text('Breaks', style: style.titleMedium),
                          if (me.breaks.isEmpty) Text('No breaks set.', style: style.bodySmall),
                          for (final b in me.breaks)
                            ListTile(
                              contentPadding: EdgeInsets.zero,
                              dense: true,
                              title: Text('${kWeekdayNames[b.weekday]} · ${b.label}'),
                              trailing: Text('${b.startsAt} – ${b.endsAt}'),
                            ),
                          const SizedBox(height: AppSpacing.lg),
                          Row(children: [
                            Expanded(child: Text('Leave', style: style.titleMedium)),
                            if (me.canManageOwnSchedule)
                              FilledButton.tonal(onPressed: _busy ? null : _requestLeave, child: const Text('Request leave')),
                          ]),
                          if (me.leaves.isEmpty) Text('No upcoming leave.', style: style.bodySmall),
                          for (final l in me.leaves)
                            ListTile(
                              contentPadding: EdgeInsets.zero,
                              title: Text('${l.startsOn} → ${l.endsOn}'),
                              subtitle: Text(l.status),
                              trailing: l.status == 'PENDING' && me.canManageOwnSchedule
                                  ? TextButton(
                                      onPressed: _busy ? null : () => _run(() => widget.api.withdrawLeaveRequest(l.id), 'Request withdrawn'),
                                      child: const Text('Withdraw'),
                                    )
                                  : null,
                            ),
                        ],
                      ),
                    ),
    );
  }
}

class _RequestDialog extends StatefulWidget {
  const _RequestDialog();

  @override
  State<_RequestDialog> createState() => _RequestDialogState();
}

class _RequestDialogState extends State<_RequestDialog> {
  final _from = TextEditingController();
  final _to = TextEditingController();
  final _reason = TextEditingController();

  @override
  void dispose() {
    _from.dispose();
    _to.dispose();
    _reason.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: const Text('Request leave'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: _from, decoration: const InputDecoration(labelText: 'From (YYYY-MM-DD)')),
          TextField(controller: _to, decoration: const InputDecoration(labelText: 'To (YYYY-MM-DD)')),
          TextField(controller: _reason, decoration: const InputDecoration(labelText: 'Reason (optional)')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
          FilledButton(
            onPressed: () => Navigator.pop(context, (_from.text.trim(), _to.text.trim(), _reason.text.trim())),
            child: const Text('Send request'),
          ),
        ],
      );
}
