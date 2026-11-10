import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';

import 'catalog_api.dart';
import 'catalog_models.dart';

/// Create (existing == null) or edit a service: category, duration, fixed or staff-based pricing, assigned staff.
/// Prices are re-validated by the server; the app never decides what a customer pays.
class ServiceFormScreen extends StatefulWidget {
  const ServiceFormScreen({super.key, required this.api, required this.overview, this.existing, this.categoryId});

  final CatalogApi api;
  final CatalogOverview overview;
  final CatalogService? existing;
  final String? categoryId;

  @override
  State<ServiceFormScreen> createState() => _ServiceFormScreenState();
}

class _ServiceFormScreenState extends State<ServiceFormScreen> {
  final _key = GlobalKey<FormState>();
  late final _name = TextEditingController(text: widget.existing?.name);
  late final _description = TextEditingController(text: widget.existing?.description);
  late final _duration = TextEditingController(text: widget.existing?.durationMinutes.toString() ?? '30');
  late final _price = TextEditingController(text: widget.existing?.price == null ? '' : _plain(widget.existing!.price!));
  late String _categoryId = widget.existing?.categoryId ?? widget.categoryId ?? widget.overview.categories.first.id;
  late String _mode = widget.existing?.pricingMode ?? 'FIXED';
  late bool _active = widget.existing?.isActive ?? true;
  late final Set<String> _selected = {for (final a in widget.existing?.staff ?? const <Assignment>[]) a.staffId};
  late final Map<String, TextEditingController> _staffPrices = {
    for (final s in widget.overview.staff)
      s.id: TextEditingController(
        text: (widget.existing?.staff.where((a) => a.staffId == s.id).map((a) => a.price).firstOrNull) == null
            ? ''
            : _plain(widget.existing!.staff.firstWhere((a) => a.staffId == s.id).price!),
      ),
  };
  bool _saving = false;
  String? _error;

  static String _plain(String p) => p.endsWith('.00') ? p.substring(0, p.length - 3) : p;

  @override
  void dispose() {
    for (final c in [_name, _description, _duration, _price, ..._staffPrices.values]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    if (!_key.currentState!.validate()) return;
    final staff = <Map<String, dynamic>>[];
    for (final id in _selected) {
      if (_mode == 'STAFF_BASED') {
        final p = parsePrice(_staffPrices[id]!.text);
        if (p == null) {
          setState(() => _error = 'Enter a valid price for every selected staff member.');
          return;
        }
        staff.add({'staffId': id, 'price': p});
      } else {
        staff.add({'staffId': id});
      }
    }
    final body = <String, dynamic>{
      'categoryId': _categoryId,
      'name': _name.text.trim(),
      'description': _description.text.trim().isEmpty ? null : _description.text.trim(),
      'durationMinutes': int.parse(_duration.text.trim()),
      'pricing': _mode == 'FIXED' ? {'mode': 'FIXED', 'price': parsePrice(_price.text)} : {'mode': 'STAFF_BASED'},
      'staff': staff,
      'isActive': _active,
    };
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      if (widget.existing == null) {
        await widget.api.createService(body);
      } else {
        await widget.api.updateService(widget.existing!.id, body);
      }
      if (mounted) Navigator.of(context).pop(true);
    } on ApiException catch (e) {
      setState(() => _error = e.details.isNotEmpty ? e.details.join('\n') : e.message);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final staff = widget.overview.staff;
    return Scaffold(
      appBar: AppBar(title: Text(widget.existing == null ? 'New service' : 'Edit service')),
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 560),
            child: Form(
              key: _key,
              child: ListView(
                padding: const EdgeInsets.all(AppSpacing.xl),
                children: [
                  TextFormField(
                    controller: _name,
                    decoration: const InputDecoration(labelText: 'Service name', hintText: 'Haircut'),
                    textCapitalization: TextCapitalization.words,
                    validator: (v) => (v ?? '').trim().length < 2 ? 'Enter at least 2 characters' : ((v ?? '').contains(RegExp(r'[<>]')) ? 'Characters < and > are not allowed' : null),
                  ),
                  const SizedBox(height: AppSpacing.lg),
                  DropdownButtonFormField<String>(
                    value: _categoryId,
                    decoration: const InputDecoration(labelText: 'Category'),
                    items: [for (final c in widget.overview.categories) DropdownMenuItem(value: c.id, child: Text(c.name))],
                    onChanged: (v) => setState(() => _categoryId = v ?? _categoryId),
                  ),
                  const SizedBox(height: AppSpacing.lg),
                  TextFormField(
                    controller: _duration,
                    decoration: const InputDecoration(labelText: 'Duration (minutes)'),
                    keyboardType: TextInputType.number,
                    validator: (v) {
                      final n = int.tryParse((v ?? '').trim());
                      return (n == null || n < 5 || n > 480) ? 'Enter 5 to 480 minutes' : null;
                    },
                  ),
                  const SizedBox(height: AppSpacing.lg),
                  TextFormField(
                    controller: _description,
                    decoration: const InputDecoration(labelText: 'Description (optional)'),
                    maxLines: 2,
                    maxLength: 500,
                    validator: (v) => (v ?? '').contains(RegExp(r'[<>]')) ? 'Characters < and > are not allowed' : null,
                  ),
                  const SizedBox(height: AppSpacing.md),
                  Text('Pricing', style: Theme.of(context).textTheme.titleMedium),
                  const SizedBox(height: AppSpacing.sm),
                  SegmentedButton<String>(
                    segments: const [
                      ButtonSegment(value: 'FIXED', label: Text('Same price')),
                      ButtonSegment(value: 'STAFF_BASED', label: Text('Price per staff')),
                    ],
                    selected: {_mode},
                    onSelectionChanged: (s) => setState(() => _mode = s.first),
                  ),
                  const SizedBox(height: AppSpacing.md),
                  if (_mode == 'FIXED')
                    TextFormField(
                      controller: _price,
                      decoration: const InputDecoration(labelText: 'Price (Rs)', prefixText: 'Rs '),
                      keyboardType: const TextInputType.numberWithOptions(decimal: true),
                      validator: (v) => parsePrice(v ?? '') == null ? 'Enter a price such as 300 or 299.50' : null,
                    ),
                  const SizedBox(height: AppSpacing.lg),
                  Text('Who performs this service?', style: Theme.of(context).textTheme.titleMedium),
                  if (staff.isEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: AppSpacing.sm),
                      child: Text('Add staff members in the Staff tab first. Customers only see a service once someone is assigned.', style: Theme.of(context).textTheme.bodySmall),
                    ),
                  for (final s in staff)
                    Column(children: [
                      CheckboxListTile(
                        contentPadding: EdgeInsets.zero,
                        value: _selected.contains(s.id),
                        title: Text(s.isOwner ? '${s.displayName} (you)' : s.displayName),
                        subtitle: s.isActive ? null : const Text('Inactive'),
                        onChanged: (v) => setState(() => v == true ? _selected.add(s.id) : _selected.remove(s.id)),
                      ),
                      if (_mode == 'STAFF_BASED' && _selected.contains(s.id))
                        Padding(
                          padding: const EdgeInsets.only(bottom: AppSpacing.sm),
                          child: TextField(
                            controller: _staffPrices[s.id],
                            decoration: InputDecoration(labelText: 'Price for ${s.displayName} (Rs)', prefixText: 'Rs '),
                            keyboardType: const TextInputType.numberWithOptions(decimal: true),
                          ),
                        ),
                    ]),
                  SwitchListTile(contentPadding: EdgeInsets.zero, value: _active, title: const Text('Available to customers'), onChanged: (v) => setState(() => _active = v)),
                  if (_error != null) ...[
                    const SizedBox(height: AppSpacing.sm),
                    Text(_error!, style: const TextStyle(color: AppColors.danger), semanticsLabel: 'Error: $_error'),
                  ],
                  const SizedBox(height: AppSpacing.lg),
                  FilledButton(
                    onPressed: _saving ? null : _save,
                    child: _saving ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2)) : const Text('Save service'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
