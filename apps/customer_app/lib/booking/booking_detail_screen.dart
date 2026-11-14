import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';

import '../discovery/discovery_api.dart';
import '../discovery/format.dart';
import 'booking_api.dart';
import 'booking_models.dart';
import 'confirm_booking_screen.dart';
import 'reschedule_screen.dart';

/// One booking: what was booked, the price on record, and Cancel / Reschedule when the salon's policy allows it.
class BookingDetailScreen extends StatefulWidget {
  const BookingDetailScreen({super.key, required this.api, required this.discovery, required this.bookingId, this.initial});

  final BookingApi api;
  final DiscoveryApi discovery;
  final String bookingId;
  final Booking? initial;

  @override
  State<BookingDetailScreen> createState() => _BookingDetailScreenState();
}

class _BookingDetailScreenState extends State<BookingDetailScreen> {
  late Future<Booking> _load = widget.api.get(widget.bookingId);
  bool _busy = false;

  void _reload() => setState(() => _load = widget.api.get(widget.bookingId));

  void _snack(String text) => ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));

  Future<void> _cancel(Booking b) async {
    final reason = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Cancel this booking?'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          const Text('The time will be released for other customers.'),
          const SizedBox(height: AppSpacing.md),
          TextField(controller: reason, maxLength: 300, decoration: const InputDecoration(labelText: 'Reason (optional)')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Keep booking')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Cancel booking')),
        ],
      ),
    );
    final text = reason.text;
    reason.dispose();
    if (ok != true) return;
    setState(() => _busy = true);
    try {
      final updated = await widget.api.cancel(b.id, reason: text);
      if (!mounted) return;
      setState(() {
        _busy = false;
        _load = Future.value(updated);
      });
      _snack('Booking cancelled.');
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      _snack(e.message);
      _reload();
    }
  }

  Future<void> _reschedule(Booking b) async {
    final updated = await Navigator.push<Booking>(
      context,
      MaterialPageRoute<Booking>(builder: (_) => RescheduleScreen(api: widget.api, discovery: widget.discovery, booking: b)),
    );
    if (updated != null && mounted) {
      setState(() => _load = Future.value(updated));
      _snack('Booking moved.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Booking')),
      body: FutureBuilder<Booking>(
        future: _load,
        builder: (context, snap) {
          if (snap.connectionState != ConnectionState.done) return const LoadingView(label: 'Loading…');
          if (snap.hasError) {
            final e = snap.error;
            return ErrorView(message: e is ApiException ? e.message : 'Could not load this booking.', requestId: e is ApiException ? e.requestId : null, onRetry: _reload);
          }
          final b = snap.data!;
          final day = DateTime.tryParse('${b.date}T00:00:00Z');
          return ListView(padding: const EdgeInsets.all(AppSpacing.lg), children: [
            Row(children: [Expanded(child: Text(b.salonName, style: theme.textTheme.titleLarge)), statusChip(context, b)]),
            const SizedBox(height: AppSpacing.sm),
            Text('${day == null ? b.date : formatDay(day)}, ${formatClock(b.time)} to ${formatClock(b.endTime)}', style: theme.textTheme.titleSmall),
            Text('With ${b.staffName}', style: theme.textTheme.bodyMedium),
            const SizedBox(height: AppSpacing.lg),
            Card(
              child: Padding(
                padding: const EdgeInsets.all(AppSpacing.lg),
                child: Column(children: [
                  for (final l in b.services)
                    Padding(
                      padding: const EdgeInsets.only(bottom: AppSpacing.sm),
                      child: Row(children: [
                        Expanded(child: Text('${l.name} (${formatDuration(l.durationMinutes)})')),
                        Text(formatPkr(l.price)),
                      ]),
                    ),
                  const Divider(),
                  Row(children: [
                    Expanded(child: Text('Total', style: theme.textTheme.titleSmall)),
                    Text(formatPkr(b.totalPrice), style: theme.textTheme.titleMedium),
                  ]),
                ]),
              ),
            ),
            if (b.note != null) ...[const SizedBox(height: AppSpacing.md), Text('Your note: ${b.note}', style: theme.textTheme.bodyMedium)],
            if (b.status == 'CANCELLED') ...[
              const SizedBox(height: AppSpacing.md),
              Text(
                'Cancelled by ${b.cancelledBy == 'SALON' ? 'the salon' : 'you'}${b.cancellationReason == null ? '' : ': ${b.cancellationReason}'}',
                style: theme.textTheme.bodyMedium?.copyWith(color: theme.colorScheme.error),
              ),
            ],
            const SizedBox(height: AppSpacing.xl),
            if (b.status == 'CONFIRMED') ...[
              OutlinedButton(onPressed: _busy || !b.canReschedule ? null : () => _reschedule(b), child: Text('Change time (${b.reschedulesLeft} left)')),
              const SizedBox(height: AppSpacing.sm),
              OutlinedButton(
                style: OutlinedButton.styleFrom(foregroundColor: theme.colorScheme.error),
                onPressed: _busy || !b.canCancel ? null : () => _cancel(b),
                child: const Text('Cancel booking'),
              ),
              if (!b.canCancel || !b.canReschedule) ...[
                const SizedBox(height: AppSpacing.sm),
                Text(
                  'Changes online are closed for this booking (salon policy). Please contact the salon.',
                  style: theme.textTheme.bodySmall?.copyWith(color: AppColors.mutedText),
                ),
              ],
            ],
          ]);
        },
      ),
    );
  }
}
