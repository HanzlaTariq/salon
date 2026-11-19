import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';

import '../billing/billing_models.dart' show formatPkr;
import 'reports_api.dart';
import 'reports_models.dart';
import 'reports_widgets.dart';

/// Staff screen: MY OWN performance only. The server derives who you are from your login; there is no way to ask for a colleague,
/// and salon expenses are never part of this report.
class StaffReportScreen extends StatefulWidget {
  const StaffReportScreen({super.key, required this.api});

  final ReportsApi api;

  @override
  State<StaffReportScreen> createState() => _StaffReportScreenState();
}

class _StaffReportScreenState extends State<StaffReportScreen> {
  int _days = 30;
  bool _loading = true;
  ApiException? _error;
  MyPerformance? _data;
  int _generation = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final gen = ++_generation;
    setState(() {
      _loading = true;
      _error = null;
    });
    final r = presetRange(karachiToday(), _days);
    try {
      final d = await widget.api.myPerformance(r.from, r.to);
      if (mounted && gen == _generation) setState(() => _data = d);
    } on ApiException catch (e) {
      if (mounted && gen == _generation) setState(() => _error = e);
    } finally {
      if (mounted && gen == _generation) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final d = _data;
    return Scaffold(
      appBar: AppBar(title: const Text('My performance')),
      body: _loading && d == null
          ? const LoadingView(label: 'Loading your numbers…')
          : _error != null && d == null
              ? ErrorView(message: _error!.message, requestId: _error!.requestId, onRetry: _load)
              : d == null
                  ? const EmptyView(title: 'Nothing to show')
                  : RefreshIndicator(onRefresh: _load, child: _content(context, d)),
    );
  }

  Widget _content(BuildContext context, MyPerformance d) {
    final t = Theme.of(context).textTheme;
    final a = d.appointments;
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.all(AppSpacing.lg),
      children: [
        RangeChips(selectedDays: _days, onSelected: (v) {
          if (v == _days) return;
          setState(() => _days = v);
          _load();
        }),
        const SizedBox(height: AppSpacing.xs),
        Text('${shortDay(d.range.from)} to ${shortDay(d.range.to)}', style: t.bodySmall),
        if (_loading) const Padding(padding: EdgeInsets.only(top: AppSpacing.sm), child: LinearProgressIndicator()),
        const SizedBox(height: AppSpacing.lg),
        StatGrid(tiles: [
          StatTile(label: 'Services completed', value: '${a.completed}', hint: 'Completion ${pctText(d.rates.completionRate)}'),
          StatTile(label: 'Value of my services', value: formatPkr(d.revenue), hint: d.averageTicket == null ? null : 'Average ${formatPkr(d.averageTicket)}'),
          StatTile(label: 'No-shows', value: '${a.noShow}', hint: 'Rate ${pctText(d.rates.noShowRate)}'),
          StatTile(label: 'Cancelled', value: '${a.cancelled}', hint: '${a.walkIn} walk-ins handled'),
        ]),
        if (d.avgServiceMinutes != null) ...[
          const SizedBox(height: AppSpacing.sm),
          Text('A service takes you about ${d.avgServiceMinutes} minutes on average.', style: t.bodySmall),
        ],
        if (d.points.isNotEmpty) ...[
          const SizedBox(height: AppSpacing.xl),
          Text('Completed services', style: t.titleMedium),
          const SizedBox(height: AppSpacing.sm),
          MiniBars(
            title: 'Completed services per ${d.group}',
            values: [for (final p in d.points) p.completed.toDouble()],
            labels: [for (final p in d.points) shortDay(p.bucket)],
            valueTexts: [for (final p in d.points) '${p.completed}'],
            color: AppColors.emerald,
          ),
        ],
        const SizedBox(height: AppSpacing.xl),
        Text('My most performed services', style: t.titleMedium),
        const SizedBox(height: AppSpacing.sm),
        if (d.topServices.isEmpty)
          const Text('Completed services will appear here.')
        else
          for (final v in d.topServices)
            ListTile(contentPadding: EdgeInsets.zero, title: Text(v.name), subtitle: Text('${v.times} time${v.times == 1 ? '' : 's'}'), trailing: Text(formatPkr(v.revenue))),
        const SizedBox(height: AppSpacing.xxl),
      ],
    );
  }
}
