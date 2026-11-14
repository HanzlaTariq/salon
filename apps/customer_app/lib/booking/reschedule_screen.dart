import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';

import '../discovery/discovery_api.dart';
import '../discovery/discovery_models.dart';
import '../discovery/format.dart';
import 'booking_api.dart';
import 'booking_models.dart';

/// Move a booking to another free time with the SAME staff member and services. Free times come from the same
/// availability endpoint the booking screen uses; the server re-checks everything when the customer confirms.
class RescheduleScreen extends StatefulWidget {
  const RescheduleScreen({super.key, required this.api, required this.discovery, required this.booking});

  final BookingApi api;
  final DiscoveryApi discovery;
  final Booking booking;

  @override
  State<RescheduleScreen> createState() => _RescheduleScreenState();
}

class _RescheduleScreenState extends State<RescheduleScreen> {
  static const _days = 14;
  late final DateTime _today = karachiToday();
  int _dayIndex = 0;
  bool _busy = false;
  late Future<AvailabilityResult> _load = _fetch();

  String get _date => isoDate(_today.add(Duration(days: _dayIndex)));

  Future<AvailabilityResult> _fetch() => widget.discovery.availability(
        salonId: widget.booking.salonId,
        date: _date,
        serviceIds: widget.booking.services.map((s) => s.serviceId).toList(),
        staffId: widget.booking.staffId,
      );

  void _select(int i) {
    if (i == _dayIndex) return;
    setState(() {
      _dayIndex = i;
      _load = _fetch();
    });
  }

  Future<void> _move(String time) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Move booking?'),
        content: Text('New time: ${formatDay(_today.add(Duration(days: _dayIndex)))} at ${formatClock(time)}.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Back')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Move')),
        ],
      ),
    );
    if (ok != true) return;
    setState(() => _busy = true);
    try {
      final updated = await widget.api.reschedule(widget.booking.id, date: _date, time: time);
      if (mounted) Navigator.pop(context, updated);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _load = _fetch(); // the list of free times changed: show the truth
      });
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Choose a new time')),
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.all(AppSpacing.lg),
          child: Align(alignment: Alignment.centerLeft, child: Text('${widget.booking.staffName} · ${widget.booking.services.map((s) => s.name).join(', ')}', style: theme.textTheme.titleSmall)),
        ),
        SizedBox(
          height: 56,
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
            itemCount: _days,
            separatorBuilder: (_, __) => const SizedBox(width: AppSpacing.sm),
            itemBuilder: (_, i) => ChoiceChip(label: Text(i == 0 ? 'Today' : formatDay(_today.add(Duration(days: i)))), selected: i == _dayIndex, onSelected: (_) => _select(i)),
          ),
        ),
        Expanded(
          child: FutureBuilder<AvailabilityResult>(
            future: _load,
            builder: (context, snap) {
              if (snap.connectionState != ConnectionState.done) return const LoadingView(label: 'Checking free times…');
              if (snap.hasError) {
                final e = snap.error;
                return ErrorView(message: e is ApiException ? e.message : 'Could not check times.', requestId: e is ApiException ? e.requestId : null, onRetry: () => setState(() => _load = _fetch()));
              }
              final slots = snap.data!.staff.isEmpty ? <String>[] : snap.data!.staff.first.slots;
              if (slots.isEmpty) return const EmptyView(icon: Icons.event_busy_outlined, title: 'No free time on this day', message: 'Try another day.');
              return ListView(padding: const EdgeInsets.all(AppSpacing.lg), children: [
                Wrap(spacing: AppSpacing.sm, runSpacing: AppSpacing.sm, children: [
                  for (final t in slots) ActionChip(label: Text(formatClock(t)), onPressed: _busy ? null : () => _move(t)),
                ]),
              ]);
            },
          ),
        ),
      ]),
    );
  }
}
