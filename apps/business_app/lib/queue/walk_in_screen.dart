import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';

import 'queue_api.dart';
import 'queue_models.dart';

/// Adds a customer who just walked in. The server chooses the earliest free time for the staff member (working hours, breaks,
/// bookings, a service that is running late) and takes price and duration from the catalogue: neither is typed here.
class WalkInScreen extends StatefulWidget {
  const WalkInScreen({super.key, required this.api, required this.owner, required this.lanes, this.initialStaffId});

  final QueueApi api;
  final bool owner;
  /// The lanes the person may add to (staff: only their own; owner: every staff member who can take customers).
  final List<QueueLane> lanes;
  final String? initialStaffId;

  @override
  State<WalkInScreen> createState() => _WalkInScreenState();
}

class _WalkInScreenState extends State<WalkInScreen> {
  final _form = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _phone = TextEditingController();
  final _note = TextEditingController();
  late String _staffId = widget.initialStaffId ?? widget.lanes.first.staffId;
  List<OfferedService> _services = const [];
  final Set<String> _chosen = {};
  bool _loading = true;
  bool _saving = false;
  ApiException? _loadError;
  String? _error;
  // One key per form: a retry after a flaky network returns the same walk-in instead of creating a second one.
  final String _key = 'walkin-${DateTime.now().microsecondsSinceEpoch}';

  @override
  void initState() {
    super.initState();
    _loadServices();
  }

  @override
  void dispose() {
    _name.dispose();
    _phone.dispose();
    _note.dispose();
    super.dispose();
  }

  Future<void> _loadServices() async {
    setState(() {
      _loading = true;
      _loadError = null;
      _chosen.clear();
    });
    try {
      final list = await widget.api.services(owner: widget.owner, staffId: _staffId);
      if (mounted) setState(() => _services = list);
    } on ApiException catch (e) {
      if (mounted) setState(() => _loadError = e);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _save() async {
    if (!_form.currentState!.validate()) return;
    if (_chosen.isEmpty) {
      setState(() => _error = 'Choose at least one service.');
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await widget.api.addWalkIn(
        owner: widget.owner,
        staffId: _staffId,
        customerName: _name.text,
        phone: _phone.text,
        serviceIds: _services.where((s) => _chosen.contains(s.id)).map((s) => s.id).toList(),
        note: _note.text,
        idempotencyKey: _key,
      );
      if (mounted) Navigator.pop(context, true);
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _saving = false;
          _error = e.message;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final totals = walkInTotals(_services.where((s) => _chosen.contains(s.id)).toList());
    return Scaffold(
      appBar: AppBar(title: const Text('Add walk-in')),
      body: Form(
        key: _form,
        child: ListView(padding: const EdgeInsets.all(AppSpacing.lg), children: [
          if (widget.owner && widget.lanes.length > 1) ...[
            DropdownButtonFormField<String>(
              initialValue: _staffId,
              decoration: const InputDecoration(labelText: 'Staff member'),
              items: [for (final l in widget.lanes) DropdownMenuItem(value: l.staffId, child: Text(l.staffName))],
              onChanged: _saving
                  ? null
                  : (v) {
                      if (v == null) return;
                      setState(() => _staffId = v);
                      _loadServices();
                    },
            ),
            const SizedBox(height: AppSpacing.md),
          ],
          TextFormField(
            controller: _name,
            maxLength: 80,
            textCapitalization: TextCapitalization.words,
            decoration: const InputDecoration(labelText: 'Customer name'),
            validator: (v) => (v == null || v.trim().length < 2) ? 'Enter the customer name.' : null,
          ),
          TextFormField(
            controller: _phone,
            keyboardType: TextInputType.phone,
            maxLength: 20,
            decoration: const InputDecoration(labelText: 'Phone (optional)', hintText: '0300 1234567'),
          ),
          const SizedBox(height: AppSpacing.sm),
          Text('Services', style: theme.textTheme.titleMedium),
          if (_loading) const Padding(padding: EdgeInsets.all(AppSpacing.lg), child: Center(child: CircularProgressIndicator())),
          if (_loadError != null) ErrorView(message: _loadError!.message, requestId: _loadError!.requestId, onRetry: _loadServices),
          if (!_loading && _loadError == null && _services.isEmpty) const EmptyView(title: 'No services', message: 'This staff member has no services assigned yet.'),
          for (final s in _services)
            CheckboxListTile(
              contentPadding: EdgeInsets.zero,
              value: _chosen.contains(s.id),
              onChanged: _saving ? null : (v) => setState(() => v == true ? _chosen.add(s.id) : _chosen.remove(s.id)),
              title: Text(s.name),
              subtitle: Text('${s.durationMinutes} min'),
              secondary: Text('Rs. ${s.price}'),
            ),
          if (_chosen.isNotEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
              child: Text('Total: ${totals.minutes} min · Rs. ${totals.price}', style: theme.textTheme.titleSmall),
            ),
          TextFormField(controller: _note, maxLength: 300, decoration: const InputDecoration(labelText: 'Note (optional)')),
          if (_error != null) Padding(padding: const EdgeInsets.only(top: AppSpacing.sm), child: Text(_error!, style: const TextStyle(color: AppColors.danger))),
          const SizedBox(height: AppSpacing.lg),
          FilledButton(onPressed: _saving || _loading ? null : _save, child: Text(_saving ? 'Adding…' : 'Add to queue')),
          const SizedBox(height: AppSpacing.sm),
          Text(
            'The customer gets the earliest free time of this staff member today. Bookings that were made earlier are never moved.',
            style: theme.textTheme.bodySmall?.copyWith(color: AppColors.mutedText),
          ),
        ]),
      ),
    );
  }
}
