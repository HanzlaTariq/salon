import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';

import 'discovery_api.dart';
import 'discovery_models.dart';
import 'format.dart';

/// For the chosen services: which staff can do ALL of them, what each one charges in total (cheapest first) and
/// their free start times on the chosen day. This is a PREVIEW, not a booking: booking arrives in the next phase.
class AvailabilityScreen extends StatefulWidget {
  const AvailabilityScreen({super.key, required this.api, required this.salonId, required this.salonName, required this.services});

  final DiscoveryApi api;
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
                for (final s in r.staff) _StaffCard(staff: s),
                const SizedBox(height: AppSpacing.md),
                Text(
                  'Times are a preview based on working hours and leave. Booking opens in the next update; a time is only confirmed when you book it.',
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
  const _StaffCard({required this.staff});
  final StaffAvailability staff;

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
              for (final t in staff.slots)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.sm),
                  decoration: BoxDecoration(border: Border.all(color: theme.colorScheme.outline), borderRadius: BorderRadius.circular(AppRadius.input)),
                  child: Text(formatClock(t), style: theme.textTheme.labelLarge),
                ),
            ]),
        ]),
      ),
    );
  }
}
