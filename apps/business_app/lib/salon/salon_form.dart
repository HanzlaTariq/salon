import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';

import 'salon_api.dart';
import 'salon_models.dart';

/// Create (existing == null) or edit the salon profile. All values are re-validated by the server.
class SalonFormScreen extends StatefulWidget {
  const SalonFormScreen({super.key, required this.api, this.existing});

  final SalonApi api;
  final SalonProfile? existing;

  @override
  State<SalonFormScreen> createState() => _SalonFormScreenState();
}

class _SalonFormScreenState extends State<SalonFormScreen> {
  final _key = GlobalKey<FormState>();
  late final _name = TextEditingController(text: widget.existing?.name);
  late final _city = TextEditingController(text: widget.existing?.city);
  late final _area = TextEditingController(text: widget.existing?.area);
  late final _address = TextEditingController(text: widget.existing?.addressLine);
  late final _phone = TextEditingController(text: widget.existing?.phone);
  late final _email = TextEditingController(text: widget.existing?.contactEmail);
  late final _description = TextEditingController(text: widget.existing?.description);
  late String _type = widget.existing?.salonType ?? 'UNISEX';
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    for (final c in [_name, _city, _area, _address, _phone, _email, _description]) {
      c.dispose();
    }
    super.dispose();
  }

  String? _len(String? v, int min, int max, String what) {
    final t = (v ?? '').trim();
    if (t.length < min) return '$what must be at least $min characters';
    if (t.length > max) return '$what is too long';
    if (RegExp(r'[<>]').hasMatch(t)) return '$what contains characters that are not allowed';
    return null;
  }

  Future<void> _save() async {
    if (!_key.currentState!.validate()) return;
    setState(() {
      _saving = true;
      _error = null;
    });
    final body = <String, dynamic>{
      'name': _name.text.trim(),
      'salonType': _type,
      'city': _city.text.trim(),
      'area': _area.text.trim(),
      'addressLine': _address.text.trim(),
      'phone': _phone.text.trim(),
      if (_email.text.trim().isNotEmpty) 'contactEmail': _email.text.trim(),
      if (_description.text.trim().isNotEmpty) 'description': _description.text.trim(),
    };
    try {
      final result = widget.existing == null ? await widget.api.create(body) : await widget.api.update(body);
      if (mounted) Navigator.of(context).pop(result);
    } on ApiException catch (e) {
      setState(() => _error = e.details.isNotEmpty ? e.details.join('\n') : e.message);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final editing = widget.existing != null;
    return Scaffold(
      appBar: AppBar(title: Text(editing ? 'Edit salon details' : 'Register your salon')),
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
                    decoration: const InputDecoration(labelText: 'Salon name'),
                    textCapitalization: TextCapitalization.words,
                    validator: (v) => _len(v, 2, 120, 'Name'),
                  ),
                  const SizedBox(height: AppSpacing.lg),
                  Text('Salon type', style: Theme.of(context).textTheme.labelLarge),
                  const SizedBox(height: AppSpacing.sm),
                  SegmentedButton<String>(
                    segments: const [
                      ButtonSegment(value: 'MEN', label: Text("Men's")),
                      ButtonSegment(value: 'LADIES', label: Text('Ladies')),
                      ButtonSegment(value: 'UNISEX', label: Text('Unisex')),
                    ],
                    selected: {_type},
                    onSelectionChanged: (s) => setState(() => _type = s.first),
                  ),
                  const SizedBox(height: AppSpacing.lg),
                  TextFormField(
                    controller: _city,
                    decoration: const InputDecoration(labelText: 'City'),
                    textCapitalization: TextCapitalization.words,
                    validator: (v) => _len(v, 2, 80, 'City'),
                  ),
                  const SizedBox(height: AppSpacing.lg),
                  TextFormField(
                    controller: _area,
                    decoration: const InputDecoration(labelText: 'Area / neighbourhood'),
                    textCapitalization: TextCapitalization.words,
                    validator: (v) => _len(v, 2, 80, 'Area'),
                  ),
                  const SizedBox(height: AppSpacing.lg),
                  TextFormField(
                    controller: _address,
                    decoration: const InputDecoration(labelText: 'Street address'),
                    maxLines: 2,
                    validator: (v) => _len(v, 5, 250, 'Address'),
                  ),
                  const SizedBox(height: AppSpacing.lg),
                  TextFormField(
                    controller: _phone,
                    decoration: const InputDecoration(labelText: 'Salon phone', hintText: '0300 1234567'),
                    keyboardType: TextInputType.phone,
                    validator: (v) => (v ?? '').replaceAll(RegExp(r'[^0-9+]'), '').length < 10 ? 'Enter a valid phone number' : null,
                  ),
                  const SizedBox(height: AppSpacing.lg),
                  TextFormField(
                    controller: _email,
                    decoration: const InputDecoration(labelText: 'Contact e-mail (optional)'),
                    keyboardType: TextInputType.emailAddress,
                    validator: (v) => (v == null || v.trim().isEmpty || v.contains('@')) ? null : 'Enter a valid e-mail',
                  ),
                  const SizedBox(height: AppSpacing.lg),
                  TextFormField(
                    controller: _description,
                    decoration: const InputDecoration(labelText: 'Short description (optional)'),
                    maxLines: 3,
                    maxLength: 1000,
                    validator: (v) => (v ?? '').contains(RegExp(r'[<>]')) ? 'Characters < and > are not allowed' : null,
                  ),
                  if (_error != null) ...[
                    const SizedBox(height: AppSpacing.sm),
                    Text(_error!, style: const TextStyle(color: AppColors.danger), semanticsLabel: 'Error: $_error'),
                  ],
                  const SizedBox(height: AppSpacing.xl),
                  FilledButton(
                    onPressed: _saving ? null : _save,
                    child: _saving
                        ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2))
                        : Text(editing ? 'Save changes' : 'Save and continue'),
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
