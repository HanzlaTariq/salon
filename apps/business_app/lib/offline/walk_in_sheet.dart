import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';

import 'offline_models.dart';

/// Total price in paisa-exact arithmetic (strings like "300.00"), for DISPLAY only. The server takes the price from the catalogue.
String sumPrices(Iterable<String> prices) {
  var paisa = 0;
  for (final p in prices) {
    final parts = p.split('.');
    paisa += (int.tryParse(parts.first) ?? 0) * 100 + (parts.length > 1 ? int.tryParse(parts[1].padRight(2, '0').substring(0, 2)) ?? 0 : 0);
  }
  return '${paisa ~/ 100}.${(paisa % 100).toString().padLeft(2, '0')}';
}

/// Collects a walk-in OFFLINE and returns the operation to save. Only names, the phone and the chosen service ids are sent: the server
/// picks the staff member's earliest free time and takes price and duration from the catalogue (the totals shown here are an estimate).
Future<PendingOp?> showWalkInSheet(BuildContext context, OfflineCatalog catalog) {
  return showModalBottomSheet<PendingOp>(
    context: context,
    isScrollControlled: true,
    builder: (_) => _WalkInForm(catalog: catalog),
  );
}

class _WalkInForm extends StatefulWidget {
  const _WalkInForm({required this.catalog});
  final OfflineCatalog catalog;

  @override
  State<_WalkInForm> createState() => _WalkInFormState();
}

class _WalkInFormState extends State<_WalkInForm> {
  final _name = TextEditingController();
  final _phone = TextEditingController();
  final _note = TextEditingController();
  final Set<String> _chosen = {};
  late CatalogStaff _staff = _eligible.first;
  String? _error;

  List<CatalogStaff> get _eligible {
    final list = widget.catalog.staff.where((s) => widget.catalog.isOwner ? true : s.id == widget.catalog.ownStaffId).toList();
    return list.isEmpty ? widget.catalog.staff : list;
  }

  @override
  void dispose() {
    _name.dispose();
    _phone.dispose();
    _note.dispose();
    super.dispose();
  }

  void _save() {
    final name = _name.text.trim();
    if (name.length < 2) return setState(() => _error = 'Enter the customer name (at least 2 letters).');
    if (_chosen.isEmpty) return setState(() => _error = 'Choose at least one service.');
    final services = _staff.services.where((s) => _chosen.contains(s.id)).toList();
    final phone = _phone.text.trim();
    final note = _note.text.trim();
    Navigator.pop(
      context,
      PendingOp(
        id: newUuid(),
        kind: SyncKind.walkIn,
        createdAt: DateTime.now().toUtc(),
        payload: {
          'customerName': name,
          'serviceIds': services.map((s) => s.id).toList(),
          if (phone.isNotEmpty) 'phone': phone,
          if (note.isNotEmpty) 'note': note,
          if (widget.catalog.isOwner) 'staffId': _staff.id,
        },
        local: {
          'label': name,
          'staffId': _staff.id,
          'staffName': _staff.name,
          'serviceNames': services.map((s) => s.name).toList(),
          'minutes': services.fold<int>(0, (a, s) => a + s.durationMinutes),
          'price': sumPrices(services.map((s) => s.price)),
        },
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final style = Theme.of(context).textTheme;
    final chosen = _staff.services.where((s) => _chosen.contains(s.id)).toList();
    return Padding(
      padding: EdgeInsets.fromLTRB(AppSpacing.lg, AppSpacing.lg, AppSpacing.lg, MediaQuery.of(context).viewInsets.bottom + AppSpacing.lg),
      child: SingleChildScrollView(
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Add walk-in', style: style.titleLarge),
          const SizedBox(height: AppSpacing.xs),
          Text('Saved on this phone. The server places it at the earliest free time when you are online.', style: style.bodySmall),
          const SizedBox(height: AppSpacing.md),
          TextField(controller: _name, textCapitalization: TextCapitalization.words, maxLength: 80, decoration: const InputDecoration(labelText: 'Customer name')),
          TextField(controller: _phone, keyboardType: TextInputType.phone, maxLength: 20, decoration: const InputDecoration(labelText: 'Phone (optional)')),
          if (widget.catalog.isOwner && _eligible.length > 1) ...[
            const SizedBox(height: AppSpacing.sm),
            DropdownButtonFormField<String>(
              value: _staff.id,
              decoration: const InputDecoration(labelText: 'Staff member'),
              items: [for (final s in _eligible) DropdownMenuItem(value: s.id, child: Text(s.name))],
              onChanged: (v) => setState(() {
                _staff = _eligible.firstWhere((s) => s.id == v);
                _chosen.clear();
              }),
            ),
          ],
          const SizedBox(height: AppSpacing.md),
          Text('Services', style: style.titleSmall),
          if (_staff.services.isEmpty) const Text('This staff member has no services yet.'),
          for (final s in _staff.services)
            CheckboxListTile(
              value: _chosen.contains(s.id),
              onChanged: (v) => setState(() => v == true ? _chosen.add(s.id) : _chosen.remove(s.id)),
              title: Text(s.name),
              subtitle: Text('Rs. ${s.price} · ${s.durationMinutes} min'),
              contentPadding: EdgeInsets.zero,
            ),
          TextField(controller: _note, maxLength: 200, decoration: const InputDecoration(labelText: 'Note (optional)')),
          if (chosen.isNotEmpty) Text('About Rs. ${sumPrices(chosen.map((s) => s.price))} · ${chosen.fold<int>(0, (a, s) => a + s.durationMinutes)} min', style: style.titleSmall),
          if (_error != null) Padding(padding: const EdgeInsets.only(top: AppSpacing.sm), child: Text(_error!, style: const TextStyle(color: AppColors.danger))),
          const SizedBox(height: AppSpacing.md),
          SizedBox(width: double.infinity, child: FilledButton(onPressed: _save, child: const Text('Save walk-in'))),
        ]),
      ),
    );
  }
}
