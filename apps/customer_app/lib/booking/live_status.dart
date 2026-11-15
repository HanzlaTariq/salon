import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';

import '../discovery/format.dart';
import 'booking_models.dart';

/// The customer's choice in [showEtaPicker]: [minutes] is null for "I'm on my way" without a time.
class EtaChoice {
  const EtaChoice(this.minutes);
  final int? minutes;
}

/// Asks "in how many minutes will you arrive?" with the quick choices 5 / 10 / 15 / 20 / 30 and a custom value (1-120).
/// When [required] is false the person can also continue without a time.
Future<EtaChoice?> showEtaPicker(BuildContext context, {required String title, required bool required}) {
  return showModalBottomSheet<EtaChoice>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (ctx) => _EtaSheet(title: title, required: required),
  );
}

class _EtaSheet extends StatefulWidget {
  const _EtaSheet({required this.title, required this.required});
  final String title;
  final bool required;

  @override
  State<_EtaSheet> createState() => _EtaSheetState();
}

class _EtaSheetState extends State<_EtaSheet> {
  int? _minutes;
  final _custom = TextEditingController();
  String? _error;

  @override
  void dispose() {
    _custom.dispose();
    super.dispose();
  }

  void _pick(int minutes) => setState(() {
        _minutes = minutes;
        _custom.clear();
        _error = null;
      });

  void _typed(String text) {
    final v = int.tryParse(text.trim());
    setState(() {
      _minutes = isValidEta(v) ? v : null;
      _error = text.trim().isEmpty || isValidEta(v) ? null : 'Enter a whole number from 1 to $kEtaMaxMinutes.';
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: EdgeInsets.fromLTRB(AppSpacing.lg, 0, AppSpacing.lg, MediaQuery.of(context).viewInsets.bottom + AppSpacing.lg),
      child: SingleChildScrollView(
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(widget.title, style: theme.textTheme.titleMedium),
          const SizedBox(height: AppSpacing.xs),
          Text('I will arrive in about…', style: theme.textTheme.bodySmall?.copyWith(color: AppColors.mutedText)),
          const SizedBox(height: AppSpacing.md),
          Wrap(spacing: AppSpacing.sm, runSpacing: AppSpacing.sm, children: [
            for (final m in kEtaChoices) ChoiceChip(label: Text('$m min'), selected: _minutes == m, onSelected: (_) => _pick(m)),
          ]),
          const SizedBox(height: AppSpacing.md),
          TextField(
            controller: _custom,
            keyboardType: TextInputType.number,
            maxLength: 3,
            decoration: InputDecoration(labelText: 'Other (minutes)', errorText: _error, counterText: ''),
            onChanged: _typed,
          ),
          const SizedBox(height: AppSpacing.md),
          FilledButton(onPressed: _minutes == null ? null : () => Navigator.pop(context, EtaChoice(_minutes)), child: const Text('Send to the salon')),
          if (!widget.required) TextButton(onPressed: () => Navigator.pop(context, const EtaChoice(null)), child: const Text('Skip the time')),
        ]),
      ),
    );
  }
}

/// The live part of a booking: the salon's delay forecast, what the customer reported, an early offer, and the arrival buttons.
/// Every rule (windows, limits, whether an offer is still valid) is decided by the server; the buttons only send the request
/// and show the server's answer.
class LiveStatusCard extends StatelessWidget {
  const LiveStatusCard({
    super.key,
    required this.booking,
    required this.busy,
    required this.onArrival,
    required this.onAccept,
    required this.onDecline,
  });

  final Booking booking;
  final bool busy;
  final Future<void> Function({required bool late, int? etaMinutes}) onArrival;
  final Future<void> Function(EarlyOffer offer, int? etaMinutes) onAccept;
  final Future<void> Function(EarlyOffer offer) onDecline;

  Future<void> _arrival(BuildContext context, {required bool late}) async {
    final choice = await showEtaPicker(context, title: late ? "I'll be late" : "I'm on my way", required: late);
    if (choice == null) return;
    await onArrival(late: late, etaMinutes: choice.minutes);
  }

  Future<void> _accept(BuildContext context, EarlyOffer offer) async {
    final choice = await showEtaPicker(context, title: 'Come at ${formatClock(offer.offeredTime)}', required: false);
    if (choice == null) return;
    await onAccept(offer, choice.minutes);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final b = booking;
    final delay = delayMessage(b);
    final offer = b.earlyOffer;
    final eta = b.customerEta;
    final children = <Widget>[];

    if (b.status == 'IN_PROGRESS') {
      children.add(_note(context, Icons.content_cut, 'Your service is in progress.', AppColors.emerald));
    }
    if (delay != null) children.add(_note(context, Icons.schedule, delay, AppColors.warning));
    if (eta != null && b.status == 'CONFIRMED') {
      final text = eta.state == 'RUNNING_LATE' ? "You told the salon you'll be late" : 'You told the salon you are on your way';
      children.add(_note(context, Icons.directions_walk, eta.etaTime == null ? '$text.' : '$text, arriving around ${formatClock(eta.etaTime!)}.', AppColors.info));
    }
    if (offer != null) {
      children.add(Card(
        margin: const EdgeInsets.only(top: AppSpacing.sm),
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.md),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Your stylist is free earlier', style: theme.textTheme.titleSmall),
            const SizedBox(height: AppSpacing.xs),
            Text(
              'Would you like to come at ${formatClock(offer.offeredTime)} instead of ${formatClock(offer.originalTime)}? You would save about ${offer.savesMinutes} minutes. If you keep your time, nothing changes and there is no penalty.',
              style: theme.textTheme.bodyMedium,
            ),
            const SizedBox(height: AppSpacing.md),
            Row(children: [
              Expanded(child: FilledButton(onPressed: busy ? null : () => _accept(context, offer), child: const Text('Come earlier'))),
              const SizedBox(width: AppSpacing.sm),
              Expanded(child: OutlinedButton(onPressed: busy ? null : () => onDecline(offer), child: const Text('Keep my time'))),
            ]),
          ]),
        ),
      ));
    }
    if (b.status == 'CONFIRMED') {
      children.add(const SizedBox(height: AppSpacing.sm));
      children.add(Row(children: [
        Expanded(child: OutlinedButton.icon(onPressed: busy ? null : () => _arrival(context, late: false), icon: const Icon(Icons.directions_walk), label: const Text("I'm on my way"))),
        const SizedBox(width: AppSpacing.sm),
        Expanded(child: OutlinedButton.icon(onPressed: busy ? null : () => _arrival(context, late: true), icon: const Icon(Icons.hourglass_bottom), label: const Text("I'll be late"))),
      ]));
    }
    if (children.isEmpty) return const SizedBox.shrink();
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children);
  }

  Widget _note(BuildContext context, IconData icon, String text, Color color) {
    return Container(
      margin: const EdgeInsets.only(top: AppSpacing.sm),
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(color: color.withValues(alpha: 0.10), borderRadius: BorderRadius.circular(12), border: Border.all(color: color.withValues(alpha: 0.35))),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Icon(icon, color: color, size: 20),
        const SizedBox(width: AppSpacing.sm),
        Expanded(child: Text(text, style: Theme.of(context).textTheme.bodyMedium)),
      ]),
    );
  }
}
