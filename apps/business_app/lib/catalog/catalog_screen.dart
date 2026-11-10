import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';

import 'catalog_api.dart';
import 'catalog_models.dart';
import 'service_form.dart';

/// Owner screen: Services (categories + services), Staff (minimal roster) and opening Hours.
class CatalogScreen extends StatefulWidget {
  const CatalogScreen({super.key, required this.api});

  final CatalogApi api;

  @override
  State<CatalogScreen> createState() => _CatalogScreenState();
}

class _CatalogScreenState extends State<CatalogScreen> {
  CatalogOverview? _data;
  bool _loading = true;
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
      final d = await widget.api.getCatalog();
      if (mounted) setState(() => _data = d);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  /// Runs a mutation, shows the server's message on failure, reloads on success.
  Future<void> _run(Future<void> Function() action) async {
    try {
      await action();
      await _load();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  Future<bool> _confirm(String title, String text) async =>
      await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: Text(title),
          content: Text(text),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Delete')),
          ],
        ),
      ) ??
      false;

  Future<void> _categoryDialog({CatalogCategory? existing}) async {
    final name = TextEditingController(text: existing?.name);
    final desc = TextEditingController(text: existing?.description);
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(existing == null ? 'New category' : 'Edit category'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: name, decoration: const InputDecoration(labelText: 'Name', hintText: 'Hair, Beard, Facial...'), textCapitalization: TextCapitalization.words),
          const SizedBox(height: AppSpacing.md),
          TextField(controller: desc, decoration: const InputDecoration(labelText: 'Description (optional)'), maxLines: 2),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Save')),
        ],
      ),
    );
    final n = name.text.trim();
    final d = desc.text.trim();
    name.dispose();
    desc.dispose();
    if (ok != true) return;
    await _run(() => existing == null
        ? widget.api.createCategory(n, d.isEmpty ? null : d)
        : widget.api.updateCategory(existing.id, {'name': n, 'description': d.isEmpty ? null : d}));
  }

  Future<void> _openService({CatalogService? existing, String? categoryId}) async {
    final d = _data!;
    final saved = await Navigator.of(context).push<bool>(
      MaterialPageRoute(builder: (_) => ServiceFormScreen(api: widget.api, overview: d, existing: existing, categoryId: categoryId)),
    );
    if (saved == true) await _load();
  }

  Future<void> _staffDialog({StaffMember? existing}) async {
    final name = TextEditingController(text: existing?.displayName);
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(existing == null ? 'Add staff member' : 'Edit staff member'),
        content: TextField(controller: name, decoration: const InputDecoration(labelText: 'Name'), textCapitalization: TextCapitalization.words),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Save')),
        ],
      ),
    );
    final n = name.text.trim();
    name.dispose();
    if (ok != true) return;
    await _run(() => existing == null ? widget.api.createStaff(displayName: n) : widget.api.updateStaff(existing.id, {'displayName': n}));
  }

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 3,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('Services, staff and hours'),
          bottom: const TabBar(tabs: [Tab(text: 'Services'), Tab(text: 'Staff'), Tab(text: 'Hours')]),
          actions: [IconButton(tooltip: 'Refresh', icon: const Icon(Icons.refresh), onPressed: _loading ? null : _load)],
        ),
        body: SafeArea(
          child: _loading
              ? const LoadingView(label: 'Loading...')
              : _error != null
                  ? ErrorView(message: _error!.message, requestId: _error!.requestId, onRetry: _load)
                  : TabBarView(children: [_services(_data!), _staff(_data!), _HoursTab(api: widget.api, canEdit: _data!.canEdit)]),
        ),
      ),
    );
  }

  Widget _notice(CatalogOverview d) => d.canEdit
      ? const SizedBox.shrink()
      : const Padding(
          padding: EdgeInsets.all(AppSpacing.lg),
          child: Text('Editing is locked while your salon is under review or suspended.'),
        );

  Widget _services(CatalogOverview d) {
    if (d.categories.isEmpty) {
      return EmptyView(
        icon: Icons.content_cut,
        title: 'No categories yet',
        message: 'Create your own categories (Hair, Beard, Facial...) and add services with prices.',
        action: d.canEdit ? FilledButton(onPressed: () => _categoryDialog(), child: const Text('Add category')) : null,
      );
    }
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.all(AppSpacing.lg),
        children: [
          _notice(d),
          for (final c in d.categories)
            Card(
              child: ExpansionTile(
                initiallyExpanded: true,
                title: Text(c.name + (c.isActive ? '' : ' (hidden)')),
                subtitle: c.description == null ? null : Text(c.description!),
                trailing: d.canEdit
                    ? PopupMenuButton<String>(
                        tooltip: 'Category options',
                        onSelected: (v) async {
                          if (v == 'edit') await _categoryDialog(existing: c);
                          if (v == 'hide') await _run(() => widget.api.updateCategory(c.id, {'isActive': !c.isActive}));
                          if (v == 'delete' && await _confirm('Delete "${c.name}"?', 'Only empty categories can be deleted.')) {
                            await _run(() => widget.api.deleteCategory(c.id));
                          }
                        },
                        itemBuilder: (_) => [
                          const PopupMenuItem(value: 'edit', child: Text('Rename')),
                          PopupMenuItem(value: 'hide', child: Text(c.isActive ? 'Hide from customers' : 'Show to customers')),
                          const PopupMenuItem(value: 'delete', child: Text('Delete')),
                        ],
                      )
                    : null,
                children: [
                  for (final s in c.services)
                    ListTile(
                      title: Text(s.name + (s.isActive ? '' : ' (hidden)')),
                      subtitle: Text([
                        '${s.durationMinutes} min',
                        s.priceLabel(),
                        if (s.isStaffBased) 'price per staff',
                        if (s.staff.isEmpty) 'no staff assigned: customers cannot see it',
                      ].join('  |  ')),
                      onTap: d.canEdit ? () => _openService(existing: s) : null,
                      trailing: d.canEdit
                          ? IconButton(
                              tooltip: 'Delete service',
                              icon: const Icon(Icons.delete_outline),
                              onPressed: () async {
                                if (await _confirm('Delete "${s.name}"?', 'Past bookings keep their price and duration.')) await _run(() => widget.api.deleteService(s.id));
                              },
                            )
                          : null,
                    ),
                  if (d.canEdit)
                    Align(
                      alignment: Alignment.centerLeft,
                      child: TextButton.icon(onPressed: () => _openService(categoryId: c.id), icon: const Icon(Icons.add), label: const Text('Add service')),
                    ),
                ],
              ),
            ),
          if (d.canEdit) OutlinedButton.icon(onPressed: () => _categoryDialog(), icon: const Icon(Icons.create_new_folder_outlined), label: const Text('Add category')),
        ],
      ),
    );
  }

  Widget _staff(CatalogOverview d) {
    final hasSelf = d.staff.any((s) => s.isOwner);
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.all(AppSpacing.lg),
        children: [
          _notice(d),
          Text('Staff who perform services. Invitations, logins and schedules arrive in the next release.', style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(height: AppSpacing.md),
          if (d.staff.isEmpty) const EmptyView(icon: Icons.group_outlined, title: 'No staff yet', message: 'Add yourself and your team so services can be assigned.'),
          for (final s in d.staff)
            Card(
              child: ListTile(
                leading: Icon(s.isOwner ? Icons.workspace_premium_outlined : Icons.person_outline),
                title: Text(s.isOwner ? '${s.displayName} (you)' : s.displayName),
                subtitle: Text(s.isActive ? 'Active' : 'Inactive'),
                trailing: d.canEdit
                    ? PopupMenuButton<String>(
                        tooltip: 'Staff options',
                        onSelected: (v) async {
                          if (v == 'edit') await _staffDialog(existing: s);
                          if (v == 'toggle') await _run(() => widget.api.updateStaff(s.id, {'isActive': !s.isActive}));
                          if (v == 'delete' && await _confirm('Remove ${s.displayName}?', 'They are removed from all services.')) await _run(() => widget.api.deleteStaff(s.id));
                        },
                        itemBuilder: (_) => [
                          const PopupMenuItem(value: 'edit', child: Text('Rename')),
                          PopupMenuItem(value: 'toggle', child: Text(s.isActive ? 'Deactivate' : 'Activate')),
                          const PopupMenuItem(value: 'delete', child: Text('Remove')),
                        ],
                      )
                    : null,
              ),
            ),
          if (d.canEdit) ...[
            const SizedBox(height: AppSpacing.md),
            FilledButton.icon(onPressed: () => _staffDialog(), icon: const Icon(Icons.person_add_alt), label: const Text('Add staff member')),
            if (!hasSelf)
              TextButton(onPressed: () => _run(() => widget.api.createStaff(self: true)), child: const Text('I also perform services (add me)')),
          ],
        ],
      ),
    );
  }
}

class _HoursTab extends StatefulWidget {
  const _HoursTab({required this.api, required this.canEdit});

  final CatalogApi api;
  final bool canEdit;

  @override
  State<_HoursTab> createState() => _HoursTabState();
}

class _HoursTabState extends State<_HoursTab> {
  List<OpeningDay>? _days;
  bool _loading = true;
  bool _saving = false;
  String? _error;

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
      final d = await widget.api.getHours();
      if (mounted) setState(() => _days = d);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  String _fmt(TimeOfDay t) => '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';

  TimeOfDay _parse(String? v, TimeOfDay fallback) {
    if (v == null || v == '24:00') return v == '24:00' ? const TimeOfDay(hour: 23, minute: 59) : fallback;
    final p = v.split(':');
    return TimeOfDay(hour: int.parse(p[0]), minute: int.parse(p[1]));
  }

  Future<void> _pick(int index, bool opening) async {
    final day = _days![index];
    final t = await showTimePicker(context: context, initialTime: _parse(opening ? day.opensAt : day.closesAt, TimeOfDay(hour: opening ? 10 : 21, minute: 0)));
    if (t == null) return;
    setState(() => _days![index] = opening ? day.copyWith(opensAt: _fmt(t)) : day.copyWith(closesAt: _fmt(t)));
  }

  Future<void> _save() async {
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final saved = await widget.api.setHours(_days!);
      if (mounted) {
        setState(() => _days = saved);
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Opening hours saved')));
      }
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const LoadingView(label: 'Loading hours...');
    if (_days == null) return ErrorView(message: _error ?? 'Could not load hours', onRetry: _load);
    return ListView(
      padding: const EdgeInsets.all(AppSpacing.lg),
      children: [
        for (var i = 0; i < _days!.length; i++)
          Card(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.sm),
              child: Row(children: [
                SizedBox(width: 96, child: Text(weekdayNames[_days![i].weekday] ?? '')),
                Switch(
                  value: !_days![i].closed,
                  onChanged: widget.canEdit
                      ? (open) => setState(() => _days![i] = open
                          ? OpeningDay(weekday: _days![i].weekday, closed: false, opensAt: '10:00', closesAt: '21:00')
                          : OpeningDay(weekday: _days![i].weekday, closed: true))
                      : null,
                ),
                Expanded(
                  child: _days![i].closed
                      ? const Text('Closed')
                      : Wrap(spacing: AppSpacing.sm, children: [
                          OutlinedButton(onPressed: widget.canEdit ? () => _pick(i, true) : null, child: Text(_days![i].opensAt ?? '--:--')),
                          OutlinedButton(onPressed: widget.canEdit ? () => _pick(i, false) : null, child: Text(_days![i].closesAt ?? '--:--')),
                        ]),
                ),
              ]),
            ),
          ),
        if (_error != null) Padding(padding: const EdgeInsets.only(top: AppSpacing.sm), child: Text(_error!, style: const TextStyle(color: AppColors.danger))),
        if (widget.canEdit) ...[
          const SizedBox(height: AppSpacing.md),
          FilledButton(
            onPressed: _saving ? null : _save,
            child: _saving ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2)) : const Text('Save opening hours'),
          ),
        ],
      ],
    );
  }
}
