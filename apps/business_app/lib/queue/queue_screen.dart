import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';

import 'queue_api.dart';
import 'queue_models.dart';
import 'walk_in_screen.dart';

/// The live queue. Owner: one section per staff member. Staff: their own queue only.
///
/// Every action is an explicit tap and the server decides: Start, Complete, Next customer, No-show (only after the salon's grace
/// period), Offer an earlier time, Add walk-in. Nothing happens automatically. The screen refreshes itself every 20 seconds
/// because the forecast depends on the time.
class QueueScreen extends StatefulWidget {
  const QueueScreen({super.key, required this.api, required this.owner});

  final QueueApi api;
  final bool owner;

  @override
  State<QueueScreen> createState() => _QueueScreenState();
}

class _QueueScreenState extends State<QueueScreen> {
  QueueSnapshot? _snapshot;
  bool _loading = true;
  bool _busy = false;
  ApiException? _error;
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    _load();
    _poll = Timer.periodic(const Duration(seconds: 20), (_) => _load(quiet: true));
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _load({bool quiet = false}) async {
    if (quiet && (_busy || !mounted)) return;
    if (!quiet) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final s = await widget.api.queue(owner: widget.owner);
      if (mounted) setState(() => _snapshot = s);
    } on ApiException catch (e) {
      if (mounted && !quiet) setState(() => _error = e);
    } finally {
      if (mounted && !quiet) setState(() => _loading = false);
    }
  }

  void _snack(String text) => ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));

  /// Runs one action, shows the server's message when it is refused, and always reloads so the screen shows the truth.
  Future<void> _run(Future<void> Function() action, {String? done}) async {
    setState(() => _busy = true);
    try {
      await action();
      if (done != null && mounted) _snack(done);
    } on ApiException catch (e) {
      if (mounted) _snack(e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
      await _load(quiet: true);
    }
  }

  Future<bool> _confirm(String title, String text, String yes) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: Text(text),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Not now')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: Text(yes)),
        ],
      ),
    );
    return ok == true;
  }

  Future<void> _next(QueueLane lane) async {
    var completeCurrent = false;
    if (lane.current != null) {
      // A running service is NEVER completed silently: the person confirms first, then the app sends completeCurrent: true.
      final ok = await _confirm('A service is still running', '${nextConfirmText(lane)}\n\nThe current service will be marked as completed.', 'Complete and call next');
      if (!ok) return;
      completeCurrent = true;
    }
    await _run(() => widget.api.next(owner: widget.owner, staffId: lane.staffId, completeCurrent: completeCurrent), done: 'Next customer started.');
  }

  Future<void> _noShow(QueueItem item) async {
    final ok = await _confirm('Mark as no-show?', '${item.customerName} did not arrive. This is saved in the history and the customer is told.', 'Mark no-show');
    if (!ok) return;
    await _run(() => widget.api.noShow(item.id, owner: widget.owner), done: 'Marked as no-show.');
  }

  Future<void> _offer(EarlyCandidate c, String name) async {
    final ok = await _confirm('Offer an earlier time?', 'Ask $name to come at ${c.earliestTime} instead (saves about ${c.savesMinutes} minutes). They can keep their original time with no penalty.', 'Send offer');
    if (!ok) return;
    await _run(() => widget.api.offerEarly(c.appointmentId, owner: widget.owner), done: 'Offer sent.');
  }

  Future<void> _walkIn({String? staffId}) async {
    final snapshot = _snapshot;
    if (snapshot == null) return;
    final lanes = snapshot.lanes.where((l) => l.canAddWalkIn).toList();
    if (lanes.isEmpty) return;
    final added = await Navigator.of(context).push<bool>(MaterialPageRoute<bool>(
      builder: (_) => WalkInScreen(api: widget.api, owner: widget.owner, lanes: lanes, initialStaffId: staffId),
    ));
    if (added == true) {
      if (mounted) _snack('Walk-in added to the queue.');
      await _load(quiet: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final snapshot = _snapshot;
    final canWalkIn = snapshot != null && snapshot.lanes.any((l) => l.canAddWalkIn);
    return Scaffold(
      appBar: AppBar(title: Text(widget.owner ? 'Live queue' : "Today's queue")),
      floatingActionButton: canWalkIn ? FloatingActionButton.extended(onPressed: _busy ? null : _walkIn, icon: const Icon(Icons.person_add_alt_1), label: const Text('Walk-in')) : null,
      body: _loading && snapshot == null
          ? const LoadingView(label: 'Loading the queue…')
          : _error != null && snapshot == null
              ? ErrorView(message: _error!.message, requestId: _error!.requestId, onRetry: _load)
              : snapshot == null || snapshot.lanes.isEmpty
                  ? const EmptyView(title: 'No queue yet', message: 'Staff members who take customers appear here.', icon: Icons.groups_outlined)
                  : RefreshIndicator(
                      onRefresh: _load,
                      child: ListView(
                        padding: const EdgeInsets.fromLTRB(AppSpacing.lg, AppSpacing.lg, AppSpacing.lg, 96),
                        children: [for (final lane in snapshot.lanes) _LaneCard(lane: lane, owner: widget.owner, busy: _busy, onNext: _next, onNoShow: _noShow, onOffer: _offer, onWalkIn: _walkIn, api: widget.api, run: _run)],
                      ),
                    ),
    );
  }
}

class _LaneCard extends StatelessWidget {
  const _LaneCard({required this.lane, required this.owner, required this.busy, required this.onNext, required this.onNoShow, required this.onOffer, required this.onWalkIn, required this.api, required this.run});

  final QueueLane lane;
  final bool owner;
  final bool busy;
  final Future<void> Function(QueueLane) onNext;
  final Future<void> Function(QueueItem) onNoShow;
  final Future<void> Function(EarlyCandidate, String) onOffer;
  final Future<void> Function({String? staffId}) onWalkIn;
  final QueueApi api;
  final Future<void> Function(Future<void> Function() action, {String? done}) run;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cand = lane.candidate;
    final candName = cand == null ? null : lane.waiting.where((w) => w.id == cand.appointmentId).map((w) => w.customerName).firstOrNull;
    return Card(
      margin: const EdgeInsets.only(bottom: AppSpacing.lg),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(child: Text(lane.staffName, style: theme.textTheme.titleMedium)),
            Text('${lane.completedToday} done · ${lane.noShowsToday} no-show', style: theme.textTheme.bodySmall?.copyWith(color: AppColors.mutedText)),
          ]),
          const SizedBox(height: AppSpacing.xs),
          Text(laneStatusText(lane), style: theme.textTheme.bodyMedium?.copyWith(color: lane.current != null && lane.current!.overrunMinutes > 0 ? AppColors.warning : AppColors.mutedText)),
          const SizedBox(height: AppSpacing.md),
          if (lane.current != null) _CurrentCard(item: lane.current!, busy: busy, onComplete: () => run(() => api.complete(lane.current!.id, owner: owner), done: 'Service completed.')),
          if (lane.current == null && lane.waiting.isEmpty) Padding(padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm), child: Text('Nobody is waiting.', style: theme.textTheme.bodyMedium)),
          if (cand != null && candName != null)
            Container(
              margin: const EdgeInsets.only(bottom: AppSpacing.sm),
              padding: const EdgeInsets.all(AppSpacing.md),
              decoration: BoxDecoration(color: AppColors.info.withValues(alpha: 0.10), borderRadius: BorderRadius.circular(12)),
              child: Row(children: [
                Expanded(child: Text('You are free earlier. $candName could come at ${cand.earliestTime} (saves ${cand.savesMinutes} min).', style: theme.textTheme.bodyMedium)),
                TextButton(onPressed: busy ? null : () => onOffer(cand, candName), child: const Text('Offer')),
              ]),
            ),
          for (final w in lane.waiting)
            _WaitingTile(
              item: w,
              busy: busy,
              onStart: () => run(() => api.start(w.id, owner: owner), done: 'Service started.'),
              onNoShow: () => onNoShow(w),
              onWithdraw: () => run(() => api.withdrawOffer(w.id, owner: owner), done: 'Offer withdrawn.'),
            ),
          if (lane.next != null)
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.md),
              child: SizedBox(width: double.infinity, child: FilledButton.icon(onPressed: busy ? null : () => onNext(lane), icon: const Icon(Icons.skip_next), label: const Text('Next customer'))),
            ),
          if (lane.canAddWalkIn && owner)
            Align(alignment: Alignment.centerLeft, child: TextButton.icon(onPressed: busy ? null : () => onWalkIn(staffId: lane.staffId), icon: const Icon(Icons.person_add_alt_1), label: Text('Add walk-in for ${lane.staffName}'))),
          if (lane.overdue.isNotEmpty) ...[
            const Divider(height: AppSpacing.xl),
            Text('Still open from earlier days', style: theme.textTheme.titleSmall),
            const SizedBox(height: AppSpacing.xs),
            for (final o in lane.overdue)
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: Text('${o.customerName} · ${o.time}'),
                subtitle: Text(o.services.join(', ')),
                trailing: TextButton(onPressed: busy || !o.noShowAllowed ? null : () => onNoShow(o), child: const Text('No-show')),
              ),
          ],
        ]),
      ),
    );
  }
}

class _CurrentCard extends StatelessWidget {
  const _CurrentCard({required this.item, required this.busy, required this.onComplete});

  final QueueItem item;
  final bool busy;
  final VoidCallback onComplete;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      margin: const EdgeInsets.only(bottom: AppSpacing.sm),
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(color: AppColors.emerald.withValues(alpha: 0.10), borderRadius: BorderRadius.circular(12), border: Border.all(color: AppColors.emerald.withValues(alpha: 0.4))),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('In service', style: theme.textTheme.labelMedium?.copyWith(color: AppColors.emerald)),
        Text(item.customerName, style: theme.textTheme.titleSmall),
        Text('${item.services.join(', ')} · until ${item.endTime}${item.overrunMinutes > 0 ? ' (+${item.overrunMinutes} min over)' : ''}', style: theme.textTheme.bodyMedium),
        const SizedBox(height: AppSpacing.sm),
        FilledButton(onPressed: busy ? null : onComplete, child: const Text('Complete service')),
      ]),
    );
  }
}

class _WaitingTile extends StatelessWidget {
  const _WaitingTile({required this.item, required this.busy, required this.onStart, required this.onNoShow, required this.onWithdraw});

  final QueueItem item;
  final bool busy;
  final VoidCallback onStart;
  final VoidCallback onNoShow;
  final VoidCallback onWithdraw;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final from = item.noShowAllowedFrom;
    final fromText = from == null ? '' : ' from ${TimeOfDay.fromDateTime(from.toLocal()).format(context)}';
    return Container(
      margin: const EdgeInsets.only(bottom: AppSpacing.sm),
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(border: Border.all(color: AppColors.border), borderRadius: BorderRadius.circular(12)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          CircleAvatar(radius: 12, child: Text('${item.position ?? ''}', style: theme.textTheme.labelSmall)),
          const SizedBox(width: AppSpacing.sm),
          Expanded(child: Text(item.customerName, style: theme.textTheme.titleSmall)),
          if (item.walkIn) const Chip(label: Text('Walk-in'), visualDensity: VisualDensity.compact),
        ]),
        const SizedBox(height: AppSpacing.xs),
        Text(item.services.join(', '), style: theme.textTheme.bodyMedium),
        Text(timesText(item), style: theme.textTheme.bodySmall?.copyWith(color: item.isDelayed ? AppColors.warning : AppColors.mutedText)),
        if (item.customerPhone != null) Text(item.customerPhone!, style: theme.textTheme.bodySmall),
        const SizedBox(height: AppSpacing.sm),
        Wrap(spacing: AppSpacing.sm, children: [
          FilledButton.tonal(onPressed: busy || !item.canStart ? null : onStart, child: const Text('Start')),
          Tooltip(
            message: item.noShowAllowed ? 'The customer did not arrive' : 'Available$fromText (grace ${item.graceMinutes} min)',
            child: OutlinedButton(onPressed: busy || !item.noShowAllowed ? null : onNoShow, child: const Text('No-show')),
          ),
          if (item.hasEarlyOffer) TextButton(onPressed: busy ? null : onWithdraw, child: const Text('Withdraw offer')),
        ]),
      ]),
    );
  }
}
