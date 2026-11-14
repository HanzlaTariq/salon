import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';

import '../booking/booking_api.dart';
import '../booking/booking_models.dart';
import '../booking/confirm_booking_screen.dart';
import 'discovery_api.dart';
import 'discovery_models.dart';
import 'format.dart';

/// For the chosen services: which staff can do ALL of them, what each one charges in total (cheapest first) and
/// their free start times on the chosen day. Tapping a time opens the confirmation step; only the server's answer to the
/// booking request confirms a time (someone else may take it first, then the list is refreshed).
class AvailabilityScreen extends StatefulWidget {
  const AvailabilityScreen({super.key, required this.api, required this.bookingApi, required this.salonId, required this.salonName, required this.services});

  final DiscoveryApi api;
  final BookingApi bookingApi;
  final String salonId;
  final String salonName;
  final List<CatalogService> services;

  @override
  State<AvailabilityScreen> createState() => _AvailabilityScreenState();
}

class _AvailabilityScreenState extends State<AvailabilityScreen> {
  static const _days = 14;
  late final DateTime _today = karachiToday();
  int _dayIndex = 0;
  late Future<AvailabilityResult> _load = _fetch();

  Future<AvailabilityResult> _fetch() => widget.api.availability(
        salonId: widget.salonId,
        date: isoDate(_today.add(Duration(days: _dayIndex))),
        serviceIds: widget.services.map((s) => s.id).toList(),
      );

  void _select(int i) {
    if (i == _dayIndex) return;
    setState(() {
      _dayIndex = i;
      _load = _fetch();
    });
  }

  Future<void> _book(AvailabilityResult r, StaffAvailability staff, String time) async {
    final booking = await Navigator.push<Booking>(
      context,
      MaterialPageRoute<Booking>(
        builder: (_) => ConfirmBookingScreen(
          api: widget.bookingApi,
          salonId: widget.salonId,
          salonName: widget.salonName,
          staffId: staff.staffId,
          staffName: staff.name,
          date: r.date,
          time: time,
          serviceIds: widget.services.map((s) => s.id).toList(),
          serviceNames: widget.services.map((s) => s.name).toList(),
          durationMinutes: r.durationMinutes,
          totalPrice: staff.totalPrice,
        ),
      ),
    );
    if (!mounted) return;
    if (booking == null) {
      setState(() => _load = _fetch()); // the time may have been taken: show the truth
      return;
    }
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Booked! Find it under My bookings.')));
    Navigator.of(context).popUntil((route) => route.isFirst);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(widget.salonName, overflow: TextOverflow.ellipsis)),
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(AppSpacing.lg, AppSpacing.md, AppSpacing.lg, AppSpacing.sm),
          child: Align(alignment: Alignment.centerLeft, child: Text(widget.services.map((s) => s.name).join(', '), style: theme.textTheme.titleSmall)),
        ),
        SizedBox(
          height: 56,
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
            itemCount: _days,
            separatorBuilder: (_, __) => const SizedBox(width: AppSpacing.sm),
            itemBuilder: (_, i) => ChoiceChip(
              label: Text(i == 0 ? 'Today' : formatDay(_today.add(Duration(days: i)))),
              selected: i == _dayIndex,
              onSelected: (_) => _select(i),
            ),
          ),
        ),
        Expanded(
          child: FutureBuilder<AvailabilityResult>(
            future: _load,
            builder: (context, snap) {
              if (snap.connectionState != ConnectionState.done) return const LoadingView(label: 'Checking free times…');
              if (snap.hasError) {
                final e = snap.error;
                return ErrorView(
                  message: e is ApiException ? e.message : 'Could not check times.',
                  requestId: e is ApiException ? e.requestId : null,
                  onRetry: () => setState(() => _load = _fetch()),
                );
              }
              final r = snap.data!;
              if (r.staff.isEmpty) {
                return const EmptyView(
                  icon: Icons.group_off_outlined,
                  title: 'No one offers all these services together',
                  message: 'Go back and choose fewer services, or services done by the same person.',
                );
              }
              return ListView(padding: const EdgeInsets.all(AppSpacing.lg), children: [
                Text('Total time: ${formatDuration(r.durationMinutes)}', style: theme.textTheme.bodyMedium?.copyWith(color: AppColors.mutedText)),
                const SizedBox(height: AppSpacing.md),
                for (final s in r.staff) _StaffCard(staff: s, onPick: (t) => _book(r, s, t)),
                const SizedBox(height: AppSpacing.md),
                Text(
                  'Free times include other bookings. A time is only yours once the booking is confirmed.',
                  style: theme.textTheme.bodySmall?.copyWith(color: AppColors.mutedText),
                ),
              ]);
            },
          ),
        ),
      ]),
    );
  }
}

class _StaffCard extends StatelessWidget {
  const _StaffCard({required this.staff, required this.onPick});
  final StaffAvailability staff;
  final void Function(String time) onPick;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      margin: const EdgeInsets.only(bottom: AppSpacing.md),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(child: Text(staff.name, style: theme.textTheme.titleMedium)),
            Text(formatPkr(staff.totalPrice), style: theme.textTheme.titleMedium),
          ]),
          const SizedBox(height: AppSpacing.md),
          if (staff.slots.isEmpty)
            Text('No free time on this day', style: theme.textTheme.bodyMedium?.copyWith(color: AppColors.mutedText))
          else
            Wrap(spacing: AppSpacing.sm, runSpacing: AppSpacing.sm, children: [
              for (final t in staff.slots) ActionChip(label: Text(formatClock(t)), onPressed: () => onPick(t)),
            ]),
        ]),
      ),
    );
  }
}
