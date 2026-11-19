import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';

import '../billing/billing_models.dart' show formatDay, formatPkr;
import 'reports_api.dart';
import 'reports_models.dart';
import 'reports_widgets.dart';

/// Owner screen: the salon's own costs. Needs a connection (expenses are not part of offline sync). Deleting an expense hides it
/// from the reports but the record and an audit entry are kept by the server.
class ExpensesScreen extends StatefulWidget {
  const ExpensesScreen({super.key, required this.api});

  final ReportsApi api;

  @override
  State<ExpensesScreen> createState() => _ExpensesScreenState();
}

class _ExpensesScreenState extends State<ExpensesScreen> {
  int _days = 30;
  bool _loading = true;
  bool _more = false;
  ApiException? _error;
  ExpensePage? _page;
  final List<ExpenseItem> _items = [];
  ExpenseSummary? _summary;
  int _generation = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  ({String from, String to}) get _range => presetRange(karachiToday(), _days);

  Future<void> _load() async {
    final gen = ++_generation;
    setState(() {
      _loading = true;
      _error = null;
    });
    final r = _range;
    try {
      final page = await widget.api.expenses(r.from, r.to);
      final summary = await widget.api.expenseSummary(r.from, r.to);
      if (!mounted || gen != _generation) return;
      setState(() {
        _page = page;
        _summary = summary;
        _items
          ..clear()
          ..addAll(page.items);
      });
    } on ApiException catch (e) {
      if (mounted && gen == _generation) setState(() => _error = e);
    } finally {
      if (mounted && gen == _generation) setState(() => _loading = false);
    }
  }

  Future<void> _loadMore() async {
    final p = _page;
    if (p == null || !p.hasMore || _more) return;
    setState(() => _more = true);
    final r = _range;
    try {
      final next = await widget.api.expenses(r.from, r.to, page: p.page + 1);
      if (!mounted) return;
      setState(() {
        _page = next;
        _items.addAll(next.items);
      });
    } on ApiException catch (e) {
      _toast(e.message);
    } finally {
      if (mounted) setState(() => _more = false);
    }
  }

  void _toast(String m) => ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));

  Future<void> _edit([ExpenseItem? existing]) async {
    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _ExpenseForm(api: widget.api, existing: existing),
    );
    if (saved == true) {
      _toast(existing == null ? 'Expense added' : 'Expense updated');
      await _load();
    }
  }

  Future<void> _delete(ExpenseItem e) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Delete this expense?'),
        content: Text('${e.label}, ${formatPkr(e.amount)} on ${formatDay(e.expenseDate)}. It will no longer count in your reports.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(c).pop(false), child: const Text('Keep')),
          FilledButton(onPressed: () => Navigator.of(c).pop(true), child: const Text('Delete')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await widget.api.deleteExpense(e.id);
      _toast('Expense deleted');
      await _load();
    } on ApiException catch (x) {
      _toast(x.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: const Text('Expenses')),
      floatingActionButton: FloatingActionButton.extended(onPressed: () => _edit(), icon: const Icon(Icons.add), label: const Text('Add expense')),
      body: _loading && _page == null
          ? const LoadingView(label: 'Loading expenses…')
          : _error != null && _page == null
              ? ErrorView(message: _error!.message, requestId: _error!.requestId, onRetry: _load)
              : RefreshIndicator(
                  onRefresh: _load,
                  child: ListView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: const EdgeInsets.fromLTRB(AppSpacing.lg, AppSpacing.lg, AppSpacing.lg, 96),
                    children: [
                      RangeChips(selectedDays: _days, onSelected: (d) {
                        if (d == _days) return;
                        setState(() => _days = d);
                        _load();
                      }),
                      const SizedBox(height: AppSpacing.md),
                      if (_loading) const LinearProgressIndicator(),
                      if (_summary != null) ...[
                        StatTile(label: 'Total in this period', value: formatPkr(_summary!.total), hint: '${_summary!.count} entries'),
                        const SizedBox(height: AppSpacing.sm),
                        for (final c in _summary!.byCategory)
                          Padding(
                            padding: const EdgeInsets.symmetric(vertical: 2),
                            child: Row(children: [
                              Expanded(child: Text(c.label, style: t.bodyMedium)),
                              Text('${formatPkr(c.total)}  ·  ${pctText(c.sharePct)}', style: t.bodySmall),
                            ]),
                          ),
                        const SizedBox(height: AppSpacing.lg),
                      ],
                      if (_items.isEmpty && !_loading)
                        const EmptyView(title: 'No expenses in this period', message: 'Add rent, salaries, supplies and other costs to see your net result in Reports.', icon: Icons.receipt_long_outlined)
                      else
                        for (final e in _items)
                          Card(
                            margin: const EdgeInsets.only(bottom: AppSpacing.sm),
                            child: ListTile(
                              title: Text('${e.label}  ·  ${formatPkr(e.amount)}'),
                              subtitle: Text('${formatDay(e.expenseDate)}${e.description == null ? '' : '\n${e.description}'}'),
                              isThreeLine: e.description != null,
                              onTap: () => _edit(e),
                              trailing: IconButton(tooltip: 'Delete', icon: const Icon(Icons.delete_outline), onPressed: () => _delete(e)),
                            ),
                          ),
                      if (_page?.hasMore == true)
                        Padding(
                          padding: const EdgeInsets.only(top: AppSpacing.sm),
                          child: OutlinedButton(onPressed: _more ? null : _loadMore, child: Text(_more ? 'Loading…' : 'Show more')),
                        ),
                    ],
                  ),
                ),
    );
  }
}

/// Add / edit sheet. The amount is validated here for a quick answer and again by the server.
class _ExpenseForm extends StatefulWidget {
  const _ExpenseForm({required this.api, this.existing});

  final ReportsApi api;
  final ExpenseItem? existing;

  @override
  State<_ExpenseForm> createState() => _ExpenseFormState();
}

class _ExpenseFormState extends State<_ExpenseForm> {
  final _form = GlobalKey<FormState>();
  late String _category = widget.existing?.category ?? 'SUPPLIES';
  late String _date = widget.existing?.expenseDate ?? karachiToday();
  late final TextEditingController _amount = TextEditingController(text: widget.existing?.amount ?? '');
  late final TextEditingController _note = TextEditingController(text: widget.existing?.description ?? '');
  // One key per opened form: a retry after a network error can never record the expense twice.
  final String _key = ReportsApi.newIdempotencyKey();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _amount.dispose();
    _note.dispose();
    super.dispose();
  }

  Future<void> _pickDate() async {
    final today = karachiToday();
    final p = _date.split('-').map(int.parse).toList();
    final t = today.split('-').map(int.parse).toList();
    final picked = await showDatePicker(
      context: context,
      initialDate: DateTime(p[0], p[1], p[2]),
      firstDate: DateTime(2020, 1, 1),
      lastDate: DateTime(t[0], t[1], t[2]),
    );
    if (picked != null) {
      setState(() => _date = '${picked.year.toString().padLeft(4, '0')}-${picked.month.toString().padLeft(2, '0')}-${picked.day.toString().padLeft(2, '0')}');
    }
  }

  Future<void> _save() async {
    if (!_form.currentState!.validate()) return;
    final amount = parseAmount(_amount.text)!;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final e = widget.existing;
      if (e == null) {
        await widget.api.addExpense(category: _category, amount: amount, expenseDate: _date, description: _note.text, idempotencyKey: _key);
      } else {
        await widget.api.updateExpense(e.id, category: _category, amount: amount, expenseDate: _date, description: _note.text);
      }
      if (mounted) Navigator.of(context).pop(true);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(AppSpacing.lg, 0, AppSpacing.lg, MediaQuery.of(context).viewInsets.bottom + AppSpacing.lg),
      child: SingleChildScrollView(
        child: Form(
          key: _form,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(widget.existing == null ? 'Add expense' : 'Edit expense', style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: AppSpacing.lg),
              DropdownButtonFormField<String>(
                initialValue: _category,
                decoration: const InputDecoration(labelText: 'Category'),
                items: [for (final c in kExpenseCategories.entries) DropdownMenuItem(value: c.key, child: Text(c.value))],
                onChanged: _busy ? null : (v) => setState(() => _category = v ?? _category),
              ),
              const SizedBox(height: AppSpacing.md),
              TextFormField(
                controller: _amount,
                enabled: !_busy,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                decoration: const InputDecoration(labelText: 'Amount (Rs.)'),
                validator: (v) => parseAmount(v ?? '') == null ? 'Enter an amount like 1500 or 1500.50' : null,
              ),
              const SizedBox(height: AppSpacing.md),
              OutlinedButton.icon(onPressed: _busy ? null : _pickDate, icon: const Icon(Icons.event), label: Text('Date: ${formatDay(_date)}')),
              const SizedBox(height: AppSpacing.md),
              TextFormField(
                controller: _note,
                enabled: !_busy,
                maxLength: 200,
                decoration: InputDecoration(labelText: _category == 'OTHER' ? 'What was it for?' : 'Note (optional)'),
                validator: (v) {
                  final t = (v ?? '').trim();
                  if (_category == 'OTHER' && t.isEmpty) return 'Please describe this expense';
                  if (t.contains('<') || t.contains('>')) return 'Remove the < and > characters';
                  return null;
                },
              ),
              if (_error != null) Padding(padding: const EdgeInsets.only(bottom: AppSpacing.sm), child: Text(_error!, style: const TextStyle(color: AppColors.danger))),
              FilledButton(onPressed: _busy ? null : _save, child: Text(_busy ? 'Saving…' : 'Save')),
            ],
          ),
        ),
      ),
    );
  }
}
