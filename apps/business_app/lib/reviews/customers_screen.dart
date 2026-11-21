import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';

import 'reviews_api.dart';
import 'reviews_models.dart';
import 'reviews_widgets.dart';

/// Owner: customers of this salon (registered customers who booked) with visits, spending, cancellations and no-shows.
/// Walk-ins without an account are not listed here (they have no customer record).
class CustomersScreen extends StatefulWidget {
  const CustomersScreen({super.key, required this.api});
  final ReviewsApi api;

  @override
  State<CustomersScreen> createState() => _CustomersScreenState();
}

const _sorts = {'recent': 'Last visit', 'visits': 'Most visits', 'spent': 'Most spent'};

class _CustomersScreenState extends State<CustomersScreen> {
  String _sort = 'recent';
  String _query = '';
  Timer? _debounce;
  final List<CustomerSummary> _items = [];
  int _page = 0;
  int _total = 0;
  bool _hasMore = false;
  bool _loading = true;
  bool _loadingMore = false;
  ApiException? _error;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    super.dispose();
  }

  Future<void> _reload() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final p = await widget.api.customers(query: _query, sort: _sort);
      if (!mounted) return;
      setState(() {
        _items
          ..clear()
          ..addAll(p.items);
        _page = p.page;
        _total = p.total;
        _hasMore = p.hasMore;
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e);
    } catch (_) {
      if (mounted) setState(() => _error = ApiException.network());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _more() async {
    setState(() => _loadingMore = true);
    try {
      final p = await widget.api.customers(page: _page + 1, query: _query, sort: _sort);
      if (!mounted) return;
      setState(() {
        _items.addAll(p.items);
        _page = p.page;
        _hasMore = p.hasMore;
      });
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    } finally {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Customers')),
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(AppSpacing.lg, AppSpacing.md, AppSpacing.lg, AppSpacing.sm),
          child: TextField(
            maxLength: 80,
            decoration: const InputDecoration(prefixIcon: Icon(Icons.search), labelText: 'Search by name', counterText: ''),
            onChanged: (v) {
              _debounce?.cancel();
              _debounce = Timer(const Duration(milliseconds: 350), () {
                _query = v.trim();
                _reload();
              });
            },
          ),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
          child: Align(
            alignment: Alignment.centerLeft,
            child: Wrap(spacing: AppSpacing.sm, children: [
              for (final e in _sorts.entries) ChoiceChip(label: Text(e.value), selected: _sort == e.key, onSelected: (_) { _sort = e.key; _reload(); }),
            ]),
          ),
        ),
        Expanded(
          child: _loading && _items.isEmpty
              ? const LoadingView(label: 'Loading customers…')
              : _error != null && _items.isEmpty
                  ? ErrorView(message: _error!.message, requestId: _error!.requestId, onRetry: _reload)
                  : _items.isEmpty
                      ? const EmptyView(icon: Icons.people_outline, title: 'No customers yet', message: 'Customers who book online appear here with their history.')
                      : RefreshIndicator(
                          onRefresh: _reload,
                          child: ListView.separated(
                            padding: const EdgeInsets.all(AppSpacing.lg),
                            itemCount: _items.length + 1,
                            separatorBuilder: (_, __) => const SizedBox(height: AppSpacing.sm),
                            itemBuilder: (_, i) {
                              if (i == _items.length) {
                                return _hasMore
                                    ? OutlinedButton(onPressed: _loadingMore ? null : _more, child: Text(_loadingMore ? 'Loading…' : 'Show more'))
                                    : Center(child: Text('$_total ${_total == 1 ? 'customer' : 'customers'}', style: theme.textTheme.bodySmall));
                              }
                              final c = _items[i];
                              return Card(
                                child: ListTile(
                                  onTap: () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => CustomerDetailScreen(api: widget.api, summary: c))),
                                  title: Text(c.name, overflow: TextOverflow.ellipsis),
                                  subtitle: Text('${c.visits} ${c.visits == 1 ? 'visit' : 'visits'} · ${pkrText(c.totalSpent)} · last ${dateText(c.lastVisitAt)}${c.noShows > 0 ? ' · ${c.noShows} no-show' : ''}'),
                                  trailing: const Icon(Icons.chevron_right),
                                ),
                              );
                            },
                          ),
                        ),
        ),
      ]),
    );
  }
}

/// One customer's history at THIS salon. Another salon's visits are never part of it.
class CustomerDetailScreen extends StatefulWidget {
  const CustomerDetailScreen({super.key, required this.api, required this.summary});
  final ReviewsApi api;
  final CustomerSummary summary;

  @override
  State<CustomerDetailScreen> createState() => _CustomerDetailScreenState();
}

class _CustomerDetailScreenState extends State<CustomerDetailScreen> {
  late Future<CustomerDetail> _load = widget.api.customer(widget.summary.customerId);

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(widget.summary.name, overflow: TextOverflow.ellipsis)),
      body: AsyncBody<CustomerDetail>(
        future: _load,
        loadingLabel: 'Loading history…',
        onRetry: () => setState(() => _load = widget.api.customer(widget.summary.customerId)),
        builder: (d) => ListView(padding: const EdgeInsets.all(AppSpacing.lg), children: [
          Card(
            child: Padding(
              padding: const EdgeInsets.all(AppSpacing.lg),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                if (d.summary.phone != null) Text(d.summary.phone!, style: theme.textTheme.titleMedium),
                const SizedBox(height: AppSpacing.sm),
                Wrap(spacing: AppSpacing.xl, runSpacing: AppSpacing.sm, children: [
                  _Stat('Visits', '${d.summary.visits}'),
                  _Stat('Spent', pkrText(d.summary.totalSpent)),
                  _Stat('Cancelled', '${d.summary.cancelled}'),
                  _Stat('No-shows', '${d.summary.noShows}'),
                  _Stat('First visit', dateText(d.summary.firstVisitAt)),
                  _Stat('Last visit', dateText(d.summary.lastVisitAt)),
                ]),
              ]),
            ),
          ),
          if (d.reviews.isNotEmpty) ...[
            const SizedBox(height: AppSpacing.lg),
            Text('Their reviews of your salon', style: theme.textTheme.titleMedium),
            for (final r in d.reviews)
              ListTile(contentPadding: EdgeInsets.zero, title: Stars(rating: r.rating.toDouble()), subtitle: r.comment == null ? null : Text(r.comment!), trailing: Text(dateText(r.createdAt), style: theme.textTheme.bodySmall)),
          ],
          const SizedBox(height: AppSpacing.lg),
          Text('Appointments', style: theme.textTheme.titleMedium),
          for (final h in d.history)
            ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text(h.services.isEmpty ? 'Appointment' : h.services.join(', ')),
              subtitle: Text('${dateText(h.startsAt)} · ${h.staffName}'),
              trailing: Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.end, children: [Text(pkrText(h.totalPrice)), Text(_statusLabel(h.status), style: theme.textTheme.bodySmall)]),
            ),
        ]),
      ),
    );
  }
}

String _statusLabel(String s) => switch (s) {
      'COMPLETED' => 'Completed',
      'CANCELLED' => 'Cancelled',
      'NO_SHOW' => 'No-show',
      'CONFIRMED' => 'Confirmed',
      'IN_PROGRESS' => 'In progress',
      'DELAYED' => 'Delayed',
      'PENDING' => 'Pending',
      _ => s,
    };

class _Stat extends StatelessWidget {
  const _Stat(this.label, this.value);
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
        Text(label, style: Theme.of(context).textTheme.bodySmall?.copyWith(color: AppColors.mutedText)),
        Text(value, style: Theme.of(context).textTheme.titleSmall),
      ]);
}
