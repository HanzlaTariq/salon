import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';

import '../discovery/format.dart';
import 'booking_api.dart';
import 'booking_models.dart';

/// Last step: shows exactly what will be booked and the total the server calculated for this staff member, then books.
/// Pops with the created [Booking]; pops with null when the customer goes back.
class ConfirmBookingScreen extends StatefulWidget {
  const ConfirmBookingScreen({
    super.key,
    required this.api,
    required this.salonId,
    required this.salonName,
    required this.staffId,
    required this.staffName,
    required this.date,
    required this.time,
    required this.serviceIds,
    required this.serviceNames,
    required this.durationMinutes,
    required this.totalPrice,
  });

  final BookingApi api;
  final String salonId;
  final String salonName;
  final String staffId;
  final String staffName;
  final String date;
  final String time;
  final List<String> serviceIds;
  final List<String> serviceNames;
  final int durationMinutes;
  final String totalPrice;

  @override
  State<ConfirmBookingScreen> createState() => _ConfirmBookingScreenState();
}

class _ConfirmBookingScreenState extends State<ConfirmBookingScreen> {
  final _note = TextEditingController();
  String _key = newIdempotencyKey();
  String _keyNote = '';
  bool _busy = false;
  String? _error;
  bool _slotGone = false;

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  Future<void> _confirm() async {
    final note = _note.text.trim();
    // A retry of the SAME request keeps its key (no double booking after a network failure). A changed note is a new request.
    if (note != _keyNote) {
      _key = newIdempotencyKey();
      _keyNote = note;
    }
    setState(() {
      _busy = true;
      _error = null;
      _slotGone = false;
    });
    try {
      final booking = await widget.api.create(
        salonId: widget.salonId,
        staffId: widget.staffId,
        serviceIds: widget.serviceIds,
        date: widget.date,
        time: widget.time,
        idempotencyKey: _key,
        note: note,
      );
      if (mounted) Navigator.pop(context, booking);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _slotGone = e.code == 'SLOT_TAKEN';
        _error = e.message;
      });
    } catch (_) {
      if (mounted) setState(() {
        _busy = false;
        _error = 'Could not book. Please try again.';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final day = DateTime.tryParse('${widget.date}T00:00:00Z');
    return Scaffold(
      appBar: AppBar(title: const Text('Confirm booking')),
      body: ListView(padding: const EdgeInsets.all(AppSpacing.lg), children: [
        Card(
          child: Padding(
            padding: const EdgeInsets.all(AppSpacing.lg),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(widget.salonName, style: theme.textTheme.titleMedium),
              const SizedBox(height: AppSpacing.sm),
              Text('With ${widget.staffName}', style: theme.textTheme.bodyMedium),
              const SizedBox(height: AppSpacing.sm),
              Text('${day == null ? widget.date : formatDay(day)} at ${formatClock(widget.time)}', style: theme.textTheme.titleSmall),
              const SizedBox(height: AppSpacing.md),
              for (final n in widget.serviceNames) Padding(padding: const EdgeInsets.only(bottom: 2), child: Text('• $n')),
              const Divider(height: AppSpacing.xl),
              Row(children: [
                Expanded(child: Text('Total (${formatDuration(widget.durationMinutes)})', style: theme.textTheme.titleSmall)),
                Text(formatPkr(widget.totalPrice), style: theme.textTheme.titleMedium),
              ]),
              const SizedBox(height: AppSpacing.sm),
              Text('You pay the salon directly. No online payment.', style: theme.textTheme.bodySmall?.copyWith(color: AppColors.mutedText)),
            ]),
          ),
        ),
        const SizedBox(height: AppSpacing.lg),
        TextField(
          controller: _note,
          enabled: !_busy,
          maxLength: 300,
          maxLines: 2,
          decoration: const InputDecoration(labelText: 'Note for the salon (optional)'),
        ),
        if (_error != null) ...[
          const SizedBox(height: AppSpacing.sm),
          Text(_error!, style: theme.textTheme.bodyMedium?.copyWith(color: theme.colorScheme.error)),
        ],
        const SizedBox(height: AppSpacing.lg),
        if (_slotGone)
          FilledButton(onPressed: () => Navigator.pop(context, null), child: const Text('Choose another time'))
        else
          FilledButton(
            onPressed: _busy ? null : _confirm,
            child: _busy
                ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2))
                : const Text('Confirm booking'),
          ),
      ]),
    );
  }
}

/// Short text for a status chip.
Widget statusChip(BuildContext context, Booking b) {
  final scheme = Theme.of(context).colorScheme;
  final bad = b.status == 'CANCELLED' || b.status == 'NO_SHOW';
  return Chip(
    label: Text(statusLabel(b.status)),
    visualDensity: VisualDensity.compact,
    backgroundColor: bad ? scheme.errorContainer : scheme.secondaryContainer,
  );
}
