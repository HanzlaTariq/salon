import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';

import 'discovery_filters.dart';
import 'discovery_models.dart';
import 'format.dart';
import 'salon_card.dart';

const _sortLabels = {
  'nearest': 'Nearest first',
  'price_low': 'Lowest price',
  'newest': 'Newest salons',
  'name': 'Name (A to Z)',
};

/// Bottom sheet with every filter. Returns the new filters, or null when dismissed.
Future<DiscoveryFilters?> showFiltersSheet(BuildContext context, {required DiscoveryFilters current, required DiscoveryOptions? options}) {
  return showModalBottomSheet<DiscoveryFilters>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: true,
    builder: (_) => _FiltersSheet(current: current, options: options),
  );
}

class _FiltersSheet extends StatefulWidget {
  const _FiltersSheet({required this.current, required this.options});
  final DiscoveryFilters current;
  final DiscoveryOptions? options;

  @override
  State<_FiltersSheet> createState() => _FiltersSheetState();
}

class _FiltersSheetState extends State<_FiltersSheet> {
  late String? _type = widget.current.type;
  late String? _sort = widget.current.sort;
  late String? _date = widget.current.date;
  late String? _time = widget.current.time;
  late double? _radius = widget.current.radiusKm;
  late final _service = TextEditingController(text: widget.current.service ?? '');
  late final _staff = TextEditingController(text: widget.current.staff ?? '');
  late final _min = TextEditingController(text: widget.current.minPrice == null ? '' : widget.current.minPrice!.toStringAsFixed(0));
  late final _max = TextEditingController(text: widget.current.maxPrice == null ? '' : widget.current.maxPrice!.toStringAsFixed(0));
  String? _priceError;

  @override
  void dispose() {
    _service.dispose();
    _staff.dispose();
    _min.dispose();
    _max.dispose();
    super.dispose();
  }

  double? _parse(String s) => s.trim().isEmpty ? null : double.tryParse(s.trim());

  void _apply() {
    final min = _parse(_min.text);
    final max = _parse(_max.text);
    if ((_min.text.trim().isNotEmpty && min == null) || (_max.text.trim().isNotEmpty && max == null) || (min != null && min < 0) || (max != null && max < 0)) {
      setState(() => _priceError = 'Enter prices as numbers, for example 500.');
      return;
    }
    if (min != null && max != null && min > max) {
      setState(() => _priceError = 'The lowest price cannot be above the highest price.');
      return;
    }
    String? text(TextEditingController c) => c.text.trim().isEmpty ? null : c.text.trim();
    Navigator.pop(
      context,
      widget.current.copyWith(
        type: _type,
        service: text(_service),
        staff: text(_staff),
        minPrice: min,
        maxPrice: max,
        date: _date,
        time: _date == null ? null : _time,
        radiusKm: widget.current.hasLocation ? _radius : null,
        sort: _sort,
      ),
    );
  }

  Future<void> _pickDate() async {
    final today = karachiToday();
    final horizon = widget.options?.horizonDays ?? 14;
    final picked = await showDatePicker(
      context: context,
      initialDate: _date == null ? today : DateTime.tryParse('${_date}T00:00:00Z') ?? today,
      firstDate: today,
      lastDate: today.add(Duration(days: horizon - 1)),
    );
    if (picked != null) setState(() => _date = isoDate(picked));
  }

  Future<void> _pickTime() async {
    final picked = await showTimePicker(context: context, initialTime: const TimeOfDay(hour: 12, minute: 0));
    if (picked != null) setState(() => _time = '${picked.hour.toString().padLeft(2, '0')}:${picked.minute.toString().padLeft(2, '0')}');
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final located = widget.current.hasLocation;
    final sorts = (widget.options?.sorts ?? const ['name']).where((s) => s != 'nearest' || located).toList();
    final radiusMax = (widget.options?.radiusMaxKm ?? 100).toDouble();
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: ListView(
        padding: const EdgeInsets.fromLTRB(AppSpacing.xl, 0, AppSpacing.xl, AppSpacing.xl),
        shrinkWrap: true,
        children: [
          Text('Filters', style: theme.textTheme.titleLarge),
          const SizedBox(height: AppSpacing.lg),
          Text('Salon type', style: theme.textTheme.titleSmall),
          const SizedBox(height: AppSpacing.sm),
          Wrap(spacing: AppSpacing.sm, children: [
            ChoiceChip(label: const Text('Any'), selected: _type == null, onSelected: (_) => setState(() => _type = null)),
            for (final t in widget.options?.salonTypes ?? const ['MEN', 'LADIES', 'UNISEX'])
              ChoiceChip(label: Text(salonTypeLabels[t] ?? t), selected: _type == t, onSelected: (_) => setState(() => _type = t)),
          ]),
          const SizedBox(height: AppSpacing.xl),
          TextField(controller: _service, maxLength: 80, decoration: const InputDecoration(labelText: 'Service or category', hintText: 'Haircut, Facial, Makeup...', counterText: '')),
          const SizedBox(height: AppSpacing.md),
          TextField(controller: _staff, maxLength: 80, decoration: const InputDecoration(labelText: 'Staff member name', counterText: '')),
          const SizedBox(height: AppSpacing.xl),
          Text('Price (Rs.)', style: theme.textTheme.titleSmall),
          const SizedBox(height: AppSpacing.sm),
          Row(children: [
            Expanded(child: TextField(controller: _min, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'From'))),
            const SizedBox(width: AppSpacing.md),
            Expanded(child: TextField(controller: _max, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'To'))),
          ]),
          if (_priceError != null) Padding(padding: const EdgeInsets.only(top: AppSpacing.sm), child: Text(_priceError!, style: theme.textTheme.bodySmall?.copyWith(color: AppColors.danger))),
          const SizedBox(height: AppSpacing.xl),
          Text('Available on', style: theme.textTheme.titleSmall),
          const SizedBox(height: AppSpacing.sm),
          Wrap(spacing: AppSpacing.sm, runSpacing: AppSpacing.sm, children: [
            OutlinedButton.icon(
              onPressed: _pickDate,
              icon: const Icon(Icons.event),
              label: Text(_date == null ? 'Pick a date' : formatDay(DateTime.parse('${_date}T00:00:00Z'))),
            ),
            if (_date != null)
              OutlinedButton.icon(onPressed: _pickTime, icon: const Icon(Icons.schedule), label: Text(_time == null ? 'Any time' : formatClock(_time!))),
            if (_date != null) TextButton(onPressed: () => setState(() { _date = null; _time = null; }), child: const Text('Clear')),
          ]),
          if (located) ...[
            const SizedBox(height: AppSpacing.xl),
            Text('Distance: within ${(_radius ?? widget.options?.radiusDefaultKm ?? 10).round()} km', style: theme.textTheme.titleSmall),
            Slider(
              min: 1,
              max: radiusMax,
              divisions: (radiusMax - 1).round(),
              value: ((_radius ?? (widget.options?.radiusDefaultKm ?? 10).toDouble())).clamp(1, radiusMax).toDouble(),
              label: '${(_radius ?? widget.options?.radiusDefaultKm ?? 10).round()} km',
              onChanged: (v) => setState(() => _radius = v),
            ),
          ],
          const SizedBox(height: AppSpacing.xl),
          Text('Sort by', style: theme.textTheme.titleSmall),
          const SizedBox(height: AppSpacing.sm),
          Wrap(spacing: AppSpacing.sm, children: [
            for (final s in sorts) ChoiceChip(label: Text(_sortLabels[s] ?? s), selected: _sort == s, onSelected: (on) => setState(() => _sort = on ? s : null)),
          ]),
          const SizedBox(height: AppSpacing.xxl),
          Row(children: [
            Expanded(
              child: OutlinedButton(
                onPressed: () => Navigator.pop(
                  context,
                  widget.current.copyWith(type: null, service: null, staff: null, minPrice: null, maxPrice: null, date: null, time: null, sort: null, area: null),
                ),
                child: const Text('Reset'),
              ),
            ),
            const SizedBox(width: AppSpacing.md),
            Expanded(child: FilledButton(onPressed: _apply, child: const Text('Show salons'))),
          ]),
        ],
      ),
    );
  }
}
