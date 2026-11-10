import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';

import 'team_api.dart';
import 'team_models.dart';

/// Owner screen for one team member: account and invitation, status, permissions, hours, breaks and leave.
class MemberScreen extends StatefulWidget {
  const MemberScreen({super.key, required this.api, required this.memberId});

  final TeamApi api;
  final String memberId;

  @override
  State<MemberScreen> createState() => _MemberScreenState();
}

class _MemberScreenState extends State<MemberScreen> {
  MemberDetail? _d;
  bool _loading = true;
  bool _busy = false;
  ApiException? _error;
  late Set<String> _perms;

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
      final d = await widget.api.detail(widget.memberId);
      if (mounted) {
        setState(() {
          _d = d;
          _perms = d.member.permissions.toSet();
        });
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  /// Runs a mutation, shows the server's message on failure, reloads on success.
  Future<void> _run(Future<void> Function() action, {String? done}) async {
    setState(() => _busy = true);
    try {
      await action();
      await _load();
      if (done != null && mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(done)));
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _invite() async {
    final email = await showDialog<String>(context: context, builder: (_) => const _EmailDialog());
    if (email == null) return;
    await _run(() => widget.api.invite(widget.memberId, email).then((_) {}), done: 'Invitation sent to $email');
  }

  Future<void> _confirmRemove() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Remove team member?'),
        content: const Text('Their login ends at once and they leave the service assignments. Past bookings stay in history.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Remove')),
        ],
      ),
    );
    if (ok != true) return;
    await _run(() => widget.api.remove(widget.memberId), done: 'Removed');
    if (mounted && _error == null) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final d = _d;
    return Scaffold(
      appBar: AppBar(title: Text(d?.member.displayName ?? 'Team member')),
      body: _loading && d == null
          ? const LoadingView(label: 'Loading…')
          : _error != null && d == null
              ? ErrorView(message: _error!.message, requestId: _error!.requestId, onRetry: _load)
              : d == null
                  ? const EmptyView(title: 'Not found')
                  : RefreshIndicator(onRefresh: _load, child: _body(d)),
    );
  }

  Widget _body(MemberDetail d) {
    final m = d.member;
    final style = Theme.of(context).textTheme;
    final canEdit = !m.isOwner;
    return ListView(
      padding: const EdgeInsets.all(AppSpacing.lg),
      children: [
        Text(_accountLabel(m), style: style.bodyMedium),
        const SizedBox(height: AppSpacing.md),
        if (m.invitation != null) ...[
          Text('Invitation to ${m.invitation!.email}', style: style.bodySmall),
          const SizedBox(height: AppSpacing.sm),
          Row(children: [
            OutlinedButton(onPressed: _busy ? null : _invite, child: const Text('Resend invitation')),
            const SizedBox(width: AppSpacing.sm),
            TextButton(
              onPressed: _busy ? null : () => _run(() => widget.api.revokeInvitation(m.invitation!.id), done: 'Invitation cancelled'),
              child: const Text('Cancel invitation'),
            ),
          ]),
        ] else if (!m.linked && !m.isOwner && m.isActive) ...[
          FilledButton.icon(onPressed: _busy ? null : _invite, icon: const Icon(Icons.mail_outline), label: const Text('Send invitation')),
        ],
        const Divider(height: AppSpacing.xxl),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: const Text('Active'),
          subtitle: Text(m.isOwner ? 'The owner profile is always active.' : 'Inactive members cannot sign in and are not billed.'),
          value: m.isActive,
          onChanged: canEdit && !_busy ? (v) => _run(() => widget.api.update(m.id, {'isActive': v}).then((_) {}), done: v ? 'Activated' : 'Deactivated') : null,
        ),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: const Text('Performs services (billable)'),
          value: m.performsServices,
          onChanged: !_busy ? (v) => _run(() => widget.api.update(m.id, {'performsServices': v}).then((_) {})) : null,
        ),
        const Divider(height: AppSpacing.xxl),
        Text('Permissions', style: style.titleMedium),
        for (final entry in kStaffPermissionLabels.entries)
          CheckboxListTile(
            contentPadding: EdgeInsets.zero,
            title: Text(entry.value),
            value: _perms.contains(entry.key),
            onChanged: canEdit && !_busy ? (v) => setState(() => v == true ? _perms.add(entry.key) : _perms.remove(entry.key)) : null,
          ),
        if (canEdit)
          Align(
            alignment: Alignment.centerRight,
            child: FilledButton(
              onPressed: _busy ? null : () => _run(() => widget.api.update(m.id, {'permissions': _perms.toList()}).then((_) {}), done: 'Permissions saved'),
              child: const Text('Save permissions'),
            ),
          ),
        const Divider(height: AppSpacing.xxl),
        Row(children: [
          Expanded(child: Text('Weekly hours', style: style.titleMedium)),
          TextButton(
            onPressed: _busy ? null : () => _editHours(d),
            child: const Text('Edit hours'),
          ),
        ]),
        for (final h in d.workingHours)
          ListTile(
            contentPadding: EdgeInsets.zero,
            dense: true,
            title: Text(kWeekdayNames[h.weekday]),
            trailing: Text(!h.configured ? 'Not set' : h.off ? 'Off' : '${h.startsAt} – ${h.endsAt}'),
          ),
        const Divider(height: AppSpacing.xxl),
        Text('Breaks', style: style.titleMedium),
        if (d.breaks.isEmpty) Text('No breaks set.', style: style.bodySmall),
        for (final b in d.breaks)
          ListTile(
            contentPadding: EdgeInsets.zero,
            dense: true,
            title: Text('${kWeekdayNames[b.weekday]} · ${b.label}'),
            trailing: Text('${b.startsAt} – ${b.endsAt}'),
          ),
        const Divider(height: AppSpacing.xxl),
        Text('Leave', style: style.titleMedium),
        if (d.leaves.isEmpty) Text('No upcoming leave.', style: style.bodySmall),
        for (final l in d.leaves)
          ListTile(
            contentPadding: EdgeInsets.zero,
            title: Text('${l.startsOn} → ${l.endsOn}'),
            subtitle: Text(l.reason ?? l.status),
            trailing: l.status == 'PENDING'
                ? Wrap(spacing: AppSpacing.xs, children: [
                    IconButton(tooltip: 'Approve', icon: const Icon(Icons.check_circle_outline), onPressed: _busy ? null : () => _run(() => widget.api.reviewLeave(l.id, approve: true).then((_) {}), done: 'Leave approved')),
                    IconButton(tooltip: 'Reject', icon: const Icon(Icons.cancel_outlined), onPressed: _busy ? null : () => _run(() => widget.api.reviewLeave(l.id, approve: false).then((_) {}), done: 'Leave rejected')),
                  ])
                : Text(l.status, style: style.bodySmall),
          ),
        OutlinedButton.icon(
          onPressed: _busy ? null : () => _addLeave(m.id),
          icon: const Icon(Icons.event_busy_outlined),
          label: const Text('Record leave'),
        ),
        if (canEdit) ...[
          const Divider(height: AppSpacing.xxl),
          TextButton(onPressed: _busy ? null : _confirmRemove, child: const Text('Remove from team', style: TextStyle(color: AppColors.danger))),
        ],
        const SizedBox(height: AppSpacing.xxl),
      ],
    );
  }

  static String _accountLabel(TeamMember m) {
    if (m.isOwner) return 'Owner account';
    return switch (m.account) {
      'LINKED' => 'Has a login',
      'INVITED' => 'Invited, waiting for acceptance',
      'INVITE_EXPIRED' => 'Invitation expired. Send a new one.',
      _ => 'No login yet. Send an invitation so they can sign in.',
    };
  }

  Future<void> _editHours(MemberDetail d) async {
    final saved = await Navigator.of(context).push<bool>(MaterialPageRoute(
      builder: (_) => _HoursEditor(api: widget.api, memberId: widget.memberId, initial: d.workingHours),
    ));
    if (saved == true) await _load();
  }

  Future<void> _addLeave(String staffId) async {
    final result = await showDialog<_LeaveInput>(context: context, builder: (_) => const _LeaveDialog());
    if (result == null) return;
    await _run(
      () => widget.api.recordLeave(staffId, startsOn: result.from, endsOn: result.to, reason: result.reason).then((_) {}),
      done: 'Leave recorded',
    );
  }
}

class _EmailDialog extends StatefulWidget {
  const _EmailDialog();

  @override
  State<_EmailDialog> createState() => _EmailDialogState();
}

class _EmailDialogState extends State<_EmailDialog> {
  final _email = TextEditingController();

  @override
  void dispose() {
    _email.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: const Text('Invite by e-mail'),
        content: TextField(
          controller: _email,
          keyboardType: TextInputType.emailAddress,
          autofillHints: const [AutofillHints.email],
          decoration: const InputDecoration(labelText: 'Their e-mail address'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(context, _email.text.trim().toLowerCase()), child: const Text('Send')),
        ],
      );
}

class _LeaveInput {
  const _LeaveInput(this.from, this.to, this.reason);
  final String from;
  final String to;
  final String? reason;
}

class _LeaveDialog extends StatefulWidget {
  const _LeaveDialog();

  @override
  State<_LeaveDialog> createState() => _LeaveDialogState();
}

class _LeaveDialogState extends State<_LeaveDialog> {
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
        title: const Text('Record leave'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: _from, decoration: const InputDecoration(labelText: 'From (YYYY-MM-DD)')),
          TextField(controller: _to, decoration: const InputDecoration(labelText: 'To (YYYY-MM-DD)')),
          TextField(controller: _reason, decoration: const InputDecoration(labelText: 'Reason (optional)')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
          FilledButton(
            onPressed: () => Navigator.pop(context, _LeaveInput(_from.text.trim(), _to.text.trim(), _reason.text.trim())),
            child: const Text('Save'),
          ),
        ],
      );
}

/// Edits the seven weekdays. Times are HH:MM in 5-minute steps; the server checks them against salon hours.
class _HoursEditor extends StatefulWidget {
  const _HoursEditor({required this.api, required this.memberId, required this.initial});

  final TeamApi api;
  final String memberId;
  final List<DayHours> initial;

  @override
  State<_HoursEditor> createState() => _HoursEditorState();
}

class _HoursEditorState extends State<_HoursEditor> {
  late List<DayHours> _days;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _days = [for (var w = 1; w <= 7; w++) widget.initial.firstWhere((h) => h.weekday == w, orElse: () => DayHours(weekday: w, configured: false, off: true))];
  }

  Future<void> _pick(int index, {required bool start}) async {
    final current = start ? _days[index].startsAt : _days[index].endsAt;
    final parts = (current ?? (start ? '11:00' : '19:00')).split(':');
    final picked = await showTimePicker(
      context: context,
      initialTime: TimeOfDay(hour: int.parse(parts[0]), minute: int.parse(parts[1])),
    );
    if (picked == null) return;
    // Snap to the 5-minute grid the server requires.
    final minute = (picked.minute ~/ 5) * 5;
    final text = '${picked.hour.toString().padLeft(2, '0')}:${minute.toString().padLeft(2, '0')}';
    setState(() {
      _days[index] = start ? _days[index].copyWith(startsAt: text) : _days[index].copyWith(endsAt: text);
    });
  }

  Future<void> _save() async {
    setState(() => _saving = true);
    try {
      await widget.api.setHours(widget.memberId, _days);
      if (mounted) Navigator.of(context).pop(true);
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Weekly hours')),
      body: ListView.builder(
        padding: const EdgeInsets.all(AppSpacing.lg),
        itemCount: _days.length,
        itemBuilder: (_, i) {
          final h = _days[i];
          return Card(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
              child: Column(children: [
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text(kWeekdayNames[h.weekday]),
                  subtitle: Text(h.off ? 'Day off' : 'Working'),
                  value: !h.off,
                  onChanged: _saving ? null : (on) => setState(() => _days[i] = h.copyWith(off: !on, startsAt: h.startsAt ?? '11:00', endsAt: h.endsAt ?? '19:00')),
                ),
                if (!h.off)
                  Row(children: [
                    Expanded(child: TextButton(onPressed: _saving ? null : () => _pick(i, start: true), child: Text('From ${h.startsAt ?? '11:00'}'))),
                    Expanded(child: TextButton(onPressed: _saving ? null : () => _pick(i, start: false), child: Text('To ${h.endsAt ?? '19:00'}'))),
                  ]),
              ]),
            ),
          );
        },
      ),
      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.lg),
          child: FilledButton(onPressed: _saving ? null : _save, child: Text(_saving ? 'Saving…' : 'Save hours')),
        ),
      ),
    );
  }
}
