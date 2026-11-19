import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';

import '../billing/billing_models.dart' show formatPkr;
import 'expenses_screen.dart';
import 'reports_api.dart';
import 'reports_models.dart';
import 'reports_widgets.dart';

/// Owner screen: how the salon is doing (appointments, revenue, expenses, staff, services, returning customers).
/// Every number is computed by the server from completed appointments (price snapshots) and the expenses the owner entered.
/// This is SALON money. The platform's subscription fee is on the subscription screen and is never mixed in here.
class ReportsScreen extends StatefulWidget {
  const ReportsScreen({super.key, required this.api});

  final ReportsApi api;

  @override
  State<ReportsScreen> createState() => _ReportsScreenState();
}

class _ReportsScreenState extends State<ReportsScreen> {
  int _days = 30;
  bool _loading = true;
  ApiException? _error;
  ReportSummary? _summary;
  TrendData? _trend;
  List<StaffStat> _staff = const [];
  List<ServiceStat> _services = const [];
  RetentionData? _retention;
  int _generation = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final gen = ++_generation; // a slow answer for an old period never overwrites the newer one
    setState(() {
      _loading = true;
      _error = null;
    });
    final r = presetRange(karachiToday(), _days);
    try {
      final results = await Future.wait<Object>([
        widget.api.summary(r.from, r.to),
        widget.api.trend(r.from, r.to),
        widget.api.staff(r.from, r.to),
        widget.api.services(r.from, r.to),
        widget.api.retention(r.from, r.to),
      ]);
      if (!mounted || gen != _generation) return;
      setState(() {
        _summary = results[0] as ReportSummary;
        _trend = results[1] as TrendData;
        _staff = results[2] as List<StaffStat>;
        _services = results[3] as List<ServiceStat>;
        _retention = results[4] as RetentionData;
      });
    } on ApiException catch (e) {
      if (mounted && gen == _generation) setState(() => _error = e);
    } finally {
      if (mounted && gen == _generation) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = _summary;
    return Scaffold(
      appBar: AppBar(title: const Text('Reports')),
      body: _loading && s == null
          ? const LoadingView(label: 'Preparing your report…')
          : _error != null && s == null
              ? ErrorView(message: _error!.message, requestId: _error!.requestId, onRetry: _load)
              : s == null
                  ? const EmptyView(title: 'Nothing to show')
                  : RefreshIndicator(onRefresh: _load, child: _content(context, s)),
    );
  }

  Widget _content(BuildContext context, ReportSummary s) {
    final t = Theme.of(context).textTheme;
    final a = s.appointments;
    final net = s.net;
    final loss = net.startsWith('-');
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.all(AppSpacing.lg),
      children: [
        RangeChips(selectedDays: _days, onSelected: (d) {
          if (d == _days) return;
          setState(() => _days = d);
          _load();
        }),
        const SizedBox(height: AppSpacing.xs),
        Text('${shortDay(s.range.from)} to ${shortDay(s.range.to)} (${s.range.days} days, Pakistan time)', style: t.bodySmall),
        if (_loading) const Padding(padding: EdgeInsets.only(top: AppSpacing.sm), child: LinearProgressIndicator()),
        if (_error != null) Padding(padding: const EdgeInsets.only(top: AppSpacing.sm), child: Text(_error!.message, style: const TextStyle(color: AppColors.danger))),
        const SizedBox(height: AppSpacing.lg),
        StatGrid(tiles: [
          StatTile(label: 'Revenue', value: formatPkr(s.revenue), hint: _change(s.revenueChangePct)),
          StatTile(label: 'Expenses', value: formatPkr(s.expenses), hint: '${s.expenseCount} entries'),
          StatTile(label: 'Net result', value: formatPkr(net), valueColor: loss ? AppColors.danger : AppColors.emerald, hint: loss ? 'You spent more than you earned' : 'Revenue minus expenses'),
          StatTile(label: 'Average bill', value: formatPkr(s.averageTicket), hint: s.avgServiceMinutes == null ? null : 'About ${s.avgServiceMinutes} min per service'),
          StatTile(label: 'Appointments', value: '${a.total}', hint: '${a.online} online, ${a.walkIn} walk-in'),
          StatTile(label: 'Completed', value: '${a.completed}', hint: 'Completion ${pctText(s.rates.completionRate)}'),
          StatTile(label: 'Cancelled', value: '${a.cancelled}', hint: 'Rate ${pctText(s.rates.cancellationRate)}'),
          StatTile(label: 'No-shows', value: '${a.noShow}', hint: 'Rate ${pctText(s.rates.noShowRate)}'),
        ]),
        const SizedBox(height: AppSpacing.xs),
        Text('Revenue is the price of completed appointments only. Rates are taken over completed, cancelled and no-show appointments (${s.rates.resolved}); ${a.open} are still open.', style: t.bodySmall),
        const SizedBox(height: AppSpacing.lg),
        OutlinedButton.icon(
          onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => ExpensesScreen(api: widget.api))),
          icon: const Icon(Icons.receipt_long_outlined),
          label: const Text('Expenses'),
        ),
        if (_trend != null && _trend!.points.isNotEmpty) ...[
          const SizedBox(height: AppSpacing.xl),
          Text('Revenue over time', style: t.titleMedium),
          const SizedBox(height: AppSpacing.sm),
          MiniBars(
            title: 'Revenue per ${_trend!.group}',
            values: [for (final p in _trend!.points) moneyHeight(p.revenue)],
            labels: [for (final p in _trend!.points) shortDay(p.bucket)],
            valueTexts: [for (final p in _trend!.points) formatPkr(p.revenue)],
          ),
        ],
        const SizedBox(height: AppSpacing.xl),
        Text('Staff', style: t.titleMedium),
        const SizedBox(height: AppSpacing.sm),
        if (_staff.isEmpty) const Text('No staff yet.') else for (final m in _staff) _StaffCard(m: m),
        const SizedBox(height: AppSpacing.xl),
        Text('Popular services', style: t.titleMedium),
        const SizedBox(height: AppSpacing.sm),
        if (_services.isEmpty)
          const Text('Completed services will appear here.')
        else
          for (final v in _services)
            ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text(v.name),
              subtitle: Text('${v.times} time${v.times == 1 ? '' : 's'}'),
              trailing: Text(formatPkr(v.revenue)),
            ),
        if (_retention != null) ...[
          const SizedBox(height: AppSpacing.xl),
          Text('Customers', style: t.titleMedium),
          const SizedBox(height: AppSpacing.sm),
          StatGrid(tiles: [
            StatTile(label: 'Customers served', value: '${_retention!.served}', hint: '${_retention!.visits} visits'),
            StatTile(label: 'New customers', value: '${_retention!.newCustomers}', hint: 'First visit in this period'),
            StatTile(label: 'Returning', value: '${_retention!.returning}', hint: 'Came back: ${pctText(_retention!.returningRatePct)}'),
            StatTile(label: 'Walk-ins served', value: '${_retention!.walkIns}', hint: 'No account, not tracked over time'),
          ]),
        ],
        const SizedBox(height: AppSpacing.xxl),
      ],
    );
  }

  String? _change(num? pct) => pct == null ? 'No earlier period to compare' : '${pct > 0 ? '+' : ''}$pct% vs previous period';
}

class _StaffCard extends StatelessWidget {
  const _StaffCard({required this.m});

  final StaffStat m;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Card(
      margin: const EdgeInsets.only(bottom: AppSpacing.sm),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(children: [
              Expanded(child: Text(m.isOwner ? '${m.name} (you)' : m.name, style: t.titleSmall, overflow: TextOverflow.ellipsis)),
              if (!m.isActive) Text('Inactive', style: t.bodySmall),
            ]),
            const SizedBox(height: AppSpacing.xs),
            Text('${formatPkr(m.revenue)}${m.revenueSharePct == null ? '' : '  ·  ${pctText(m.revenueSharePct)} of revenue'}', style: t.bodyMedium),
            const SizedBox(height: AppSpacing.xs),
            Text('${m.completed} completed · ${m.noShow} no-show · ${m.cancelled} cancelled · ${m.walkIn} walk-in', style: t.bodySmall),
          ],
        ),
      ),
    );
  }
}
