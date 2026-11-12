import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';
import 'package:image_picker/image_picker.dart';

import 'billing_api.dart';
import 'billing_models.dart';
import 'payment_form_screen.dart';

/// Owner screen: subscription status, the team you are billed for, invoices and manual payments.
/// Everything shown is computed by the server; this screen never calculates or edits an amount.
class BillingScreen extends StatefulWidget {
  const BillingScreen({super.key, required this.api});

  final BillingApi api;

  @override
  State<BillingScreen> createState() => _BillingScreenState();
}

class _BillingScreenState extends State<BillingScreen> {
  BillingSummary? _data;
  List<PaymentInfo> _payments = const [];
  List<InvoiceInfo> _invoices = const [];
  bool _loading = true;
  bool _busy = false;
  ApiException? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final summary = await widget.api.summary();
      final payments = summary.eligible ? await widget.api.payments() : <PaymentInfo>[];
      final invoices = summary.eligible ? await widget.api.invoices() : <InvoiceInfo>[];
      if (mounted) {
        setState(() {
          _data = summary;
          _payments = payments;
          _invoices = invoices;
        });
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _toast(String message) => ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));

  Future<void> _guard(Future<void> Function() action) async {
    setState(() => _busy = true);
    try {
      await action();
      await _load();
    } on ApiException catch (e) {
      if (mounted) _toast(e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _create(Quote q) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: Text('Create a ${q.cycle == 'MONTHLY' ? 'monthly' : 'yearly'} invoice?'),
        content: Text('${q.staff} team member${q.staff == 1 ? '' : 's'} × ${formatPkr(q.unitPrice)}'
            '${q.promotionName != null ? '\n${q.promotionName}: -${formatPkr(q.discountAmount)}' : ''}'
            '${q.creditApplied != '0.00' ? '\nCredit used: -${formatPkr(q.creditApplied)}' : ''}'
            '\n\nTotal to pay: ${formatPkr(q.total)}'),
        actions: [
          TextButton(onPressed: () => Navigator.of(c).pop(false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.of(c).pop(true), child: const Text('Create invoice')),
        ],
      ),
    );
    if (ok != true) return;
    await _guard(() async {
      await widget.api.createInvoice(q.cycle);
    });
  }

  Future<void> _cancel(InvoiceInfo inv) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Cancel this invoice?'),
        content: const Text('You can create a new invoice afterwards, based on your current team.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(c).pop(false), child: const Text('Keep it')),
          FilledButton(onPressed: () => Navigator.of(c).pop(true), child: const Text('Cancel invoice')),
        ],
      ),
    );
    if (ok != true) return;
    await _guard(() => widget.api.cancelInvoice(inv.id));
  }

  Future<void> _pay(InvoiceInfo inv, List<PaymentMethodInfo> methods) async {
    if (methods.isEmpty) {
      _toast('No payment method is available yet. Please contact support.');
      return;
    }
    final done = await Navigator.of(context).push<bool>(MaterialPageRoute(builder: (_) => PaymentFormScreen(api: widget.api, invoice: inv, methods: methods)));
    if (done == true) {
      if (mounted) _toast('Submitted. We will verify your payment shortly.');
      await _load();
    }
  }

  Future<void> _answer(PaymentInfo p) async {
    final note = TextEditingController();
    final txn = TextEditingController();
    Uint8List? bytes;
    String? name;
    final send = await showDialog<bool>(
      context: context,
      builder: (c) => StatefulBuilder(
        builder: (c, setLocal) => AlertDialog(
          title: const Text('Answer the reviewer'),
          content: SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              if (p.message != null) Text(p.message!, style: Theme.of(c).textTheme.bodyMedium),
              const SizedBox(height: AppSpacing.md),
              TextField(controller: note, maxLength: 300, maxLines: 3, decoration: const InputDecoration(labelText: 'Your answer')),
              TextField(controller: txn, maxLength: 40, decoration: const InputDecoration(labelText: 'Correct transaction ID (only if it was wrong)')),
              OutlinedButton.icon(
                onPressed: () async {
                  final f = await ImagePicker().pickImage(source: ImageSource.gallery, maxWidth: 2200, imageQuality: 88);
                  if (f == null) return;
                  final b = await f.readAsBytes();
                  setLocal(() {
                    bytes = b;
                    name = f.name;
                  });
                },
                icon: const Icon(Icons.receipt_long_outlined),
                label: Text(bytes == null ? 'Attach a new receipt (optional)' : 'New receipt attached'),
              ),
            ]),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.of(c).pop(false), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.of(c).pop(note.text.trim().length >= 3), child: const Text('Send')),
          ],
        ),
      ),
    );
    final text = note.text.trim();
    final txnText = txn.text.trim();
    note.dispose();
    txn.dispose();
    if (send != true) return;
    await _guard(() async {
      await widget.api.respond(paymentId: p.id, note: text, transactionId: txnText, receiptBytes: bytes, receiptFilename: name);
      if (mounted) _toast('Sent. The reviewer will look at it again.');
    });
  }

  @override
  Widget build(BuildContext context) {
    final d = _data;
    return Scaffold(
      appBar: AppBar(title: const Text('Subscription')),
      body: _loading && d == null
          ? const LoadingView(label: 'Loading your subscription…')
          : _error != null
              ? ErrorView(message: _error!.message, requestId: _error!.requestId, onRetry: _load)
              : d == null
                  ? const EmptyView(title: 'Nothing to show')
                  : !d.eligible
                      ? EmptyView(title: 'Billing starts after approval', message: d.message, icon: Icons.hourglass_empty)
                      : RefreshIndicator(onRefresh: _load, child: _content(context, d)),
    );
  }

  Widget _content(BuildContext context, BillingSummary d) {
    final theme = Theme.of(context);
    final sub = d.subscription;
    return AbsorbPointer(
      absorbing: _busy,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(AppSpacing.lg),
        children: [
          _StatusCard(sub: sub),
          const SizedBox(height: AppSpacing.md),
          Card(
            child: ListTile(
              leading: const Icon(Icons.groups_outlined),
              title: Text('${d.billableStaff} billable team member${d.billableStaff == 1 ? '' : 's'}'),
              subtitle: Text(sub.phase == 'NONE'
                  ? 'You are billed for each active team member who performs services. The owner counts once, only when they perform services.'
                  : '${sub.coveredStaff} covered by your current payment. Changes to your team are billed fairly for the days left (extra invoice) or credited.'),
            ),
          ),
          if (d.hasCredit)
            Card(child: ListTile(leading: const Icon(Icons.savings_outlined), title: Text('Credit: ${formatPkr(d.creditBalance)}'), subtitle: const Text('Used automatically on your next invoice.'))),
          if (d.openTopUp != null) ...[
            const SizedBox(height: AppSpacing.md),
            _InvoiceCard(invoice: d.openTopUp!, heading: 'Staff added: pay the difference', onPay: () => _pay(d.openTopUp!, d.paymentMethods), onAnswer: () => _answerFor(d.openTopUp!)),
          ],
          if (d.openInvoice != null) ...[
            const SizedBox(height: AppSpacing.md),
            _InvoiceCard(
              invoice: d.openInvoice!,
              heading: 'Invoice to pay',
              onPay: () => _pay(d.openInvoice!, d.paymentMethods),
              onCancel: d.openInvoice!.paymentStatus == null ? () => _cancel(d.openInvoice!) : null,
              onAnswer: () => _answerFor(d.openInvoice!),
            ),
          ] else ...[
            const SizedBox(height: AppSpacing.lg),
            Text(sub.phase == 'NONE' ? 'Choose your plan' : 'Renew', style: theme.textTheme.titleMedium),
            const SizedBox(height: AppSpacing.sm),
            if (!d.pricingConfigured)
              const Text('Pricing has not been set up yet. Please check back soon.')
            else if (!d.canCreate.allowed)
              Text(d.canCreate.reason ?? 'You cannot create an invoice right now.', style: theme.textTheme.bodyMedium)
            else
              for (final cycle in const ['MONTHLY', 'YEARLY'])
                if (d.quotes[cycle] != null) _PlanCard(quote: d.quotes[cycle]!, onChoose: () => _create(d.quotes[cycle]!)),
          ],
          const SizedBox(height: AppSpacing.xl),
          Text('Payments', style: theme.textTheme.titleMedium),
          const SizedBox(height: AppSpacing.sm),
          if (_payments.isEmpty)
            Text('No payments submitted yet.', style: theme.textTheme.bodyMedium)
          else
            for (final p in _payments)
              Card(
                child: ListTile(
                  title: Text('${formatPkr(p.amount)} · ${kMethodLabels[p.method] ?? p.method}'),
                  subtitle: Text('${p.statusLabel}${p.message != null ? '\n${p.message}' : ''}\nID ${p.transactionId} · ${formatDay(p.paidOn)}'),
                  isThreeLine: true,
                  trailing: p.status == 'NEEDS_INFO' ? TextButton(onPressed: () => _answer(p), child: const Text('Answer')) : _StatusDot(status: p.status),
                ),
              ),
          const SizedBox(height: AppSpacing.xl),
          Text('Invoice history', style: theme.textTheme.titleMedium),
          const SizedBox(height: AppSpacing.sm),
          if (_invoices.isEmpty)
            Text('No invoices yet.', style: theme.textTheme.bodyMedium)
          else
            for (final i in _invoices)
              Card(
                child: ListTile(
                  title: Text('${i.invoiceNo} · ${i.kindLabel}'),
                  subtitle: Text('${formatPkr(i.total)} · ${i.staffCount} staff${i.periodStart != null ? '\n${formatDay(i.periodStart)} to ${formatDay(i.periodEnd)}' : ''}'),
                  isThreeLine: i.periodStart != null,
                  trailing: Text(i.status == 'PAID' ? 'Paid' : i.status == 'VOID' ? 'Cancelled' : 'Open'),
                ),
              ),
          const SizedBox(height: AppSpacing.xxl),
        ],
      ),
    );
  }

  /// Opens the answer dialog for the payment attached to an invoice that is waiting for the owner.
  void _answerFor(InvoiceInfo inv) {
    for (final p in _payments) {
      if (p.invoiceId == inv.id && p.status == 'NEEDS_INFO') {
        _answer(p);
        return;
      }
    }
  }
}

class _StatusCard extends StatelessWidget {
  const _StatusCard({required this.sub});

  final SubscriptionInfo sub;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    late final String title;
    late final String body;
    late final Color color;
    switch (sub.phase) {
      case 'ACTIVE':
        title = 'Active';
        body = 'Paid until ${formatDay(sub.paidThrough)}${sub.daysLeft > 0 ? ' · ${sub.daysLeft} day${sub.daysLeft == 1 ? '' : 's'} left' : ''}';
        color = AppColors.emerald;
      case 'GRACE':
        title = 'Payment overdue: grace period';
        body = 'Please renew by ${formatDay(sub.accessThrough)} to avoid interruption.';
        color = AppColors.warning;
      case 'EXPIRED':
        title = 'Expired';
        body = 'Your subscription ended on ${formatDay(sub.paidThrough)}. Renew to continue.';
        color = AppColors.danger;
      case 'SUSPENDED':
        title = 'Suspended';
        body = sub.suspendedReason ?? 'Please contact support.';
        color = AppColors.danger;
      default:
        title = 'Not subscribed yet';
        body = 'Choose a plan below. Your subscription starts after we verify your payment.';
        color = AppColors.info;
    }
    return Card(
      color: color.withValues(alpha: 0.10),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(title, style: theme.textTheme.titleLarge?.copyWith(color: color)),
          const SizedBox(height: AppSpacing.xs),
          Text(body, style: theme.textTheme.bodyMedium),
          if (sub.billingCycle != null) Padding(padding: const EdgeInsets.only(top: AppSpacing.xs), child: Text('${sub.billingCycle == 'MONTHLY' ? 'Monthly' : 'Yearly'} plan', style: theme.textTheme.bodySmall)),
        ]),
      ),
    );
  }
}

class _PlanCard extends StatelessWidget {
  const _PlanCard({required this.quote, required this.onChoose});

  final Quote quote;
  final VoidCallback onChoose;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final monthly = quote.cycle == 'MONTHLY';
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(monthly ? 'Monthly' : 'Yearly', style: theme.textTheme.titleMedium),
          const SizedBox(height: AppSpacing.xs),
          Text(formatPkr(quote.total), style: theme.textTheme.headlineSmall),
          Text('${quote.staff} × ${formatPkr(quote.unitPrice)} per ${monthly ? 'month' : 'year'}', style: theme.textTheme.bodySmall),
          if (quote.promotionName != null) Text('${quote.promotionName}: -${formatPkr(quote.discountAmount)}', style: theme.textTheme.bodySmall?.copyWith(color: AppColors.emerald)),
          if (quote.creditApplied != '0.00') Text('Credit used: -${formatPkr(quote.creditApplied)}', style: theme.textTheme.bodySmall),
          const SizedBox(height: AppSpacing.md),
          FilledButton(onPressed: onChoose, child: Text('Choose ${monthly ? 'monthly' : 'yearly'}')),
        ]),
      ),
    );
  }
}

class _InvoiceCard extends StatelessWidget {
  const _InvoiceCard({required this.invoice, required this.heading, required this.onPay, this.onCancel, required this.onAnswer});

  final InvoiceInfo invoice;
  final String heading;
  final VoidCallback onPay;
  final VoidCallback? onCancel;
  final VoidCallback onAnswer;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final i = invoice;
    final status = i.paymentStatus;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(heading, style: theme.textTheme.labelLarge),
          const SizedBox(height: AppSpacing.xs),
          Text(formatPkr(i.total), style: theme.textTheme.headlineMedium),
          Text('${i.invoiceNo} · ${i.kindLabel}', style: theme.textTheme.bodySmall),
          const SizedBox(height: AppSpacing.sm),
          Text('${i.staffCount} team member${i.staffCount == 1 ? '' : 's'} × ${formatPkr(i.unitPrice)}'
              '${i.remainingDays != null ? '\nFor ${i.remainingDays} of ${i.totalDays} days left in your period' : ''}'
              '${i.discountAmount != '0.00' ? '\n${i.promotionName ?? 'Discount'}: -${formatPkr(i.discountAmount)}' : ''}'
              '${i.creditApplied != '0.00' ? '\nCredit used: -${formatPkr(i.creditApplied)}' : ''}'),
          if (i.stale) ...[
            const SizedBox(height: AppSpacing.sm),
            Text('Your team changed after this invoice was made. Cancel it and create a new one to match your current team.', style: theme.textTheme.bodySmall?.copyWith(color: AppColors.warning)),
          ],
          const SizedBox(height: AppSpacing.md),
          if (status == null) ...[
            FilledButton.icon(onPressed: onPay, icon: const Icon(Icons.payments_outlined), label: const Text('I have paid: add receipt')),
            if (onCancel != null) TextButton(onPressed: onCancel, child: const Text('Cancel this invoice')),
          ] else if (status == 'PENDING')
            Row(children: [
              const Icon(Icons.hourglass_top, size: 18, color: AppColors.warning),
              const SizedBox(width: AppSpacing.sm),
              Expanded(child: Text('Waiting for verification. It counts as paid only after we verify it.', style: theme.textTheme.bodyMedium)),
            ])
          else if (status == 'NEEDS_INFO')
            FilledButton(onPressed: onAnswer, child: const Text('Answer the reviewer')),
        ]),
      ),
    );
  }
}

class _StatusDot extends StatelessWidget {
  const _StatusDot({required this.status});

  final String status;

  @override
  Widget build(BuildContext context) {
    final color = status == 'APPROVED' ? AppColors.emerald : status == 'REJECTED' ? AppColors.danger : AppColors.warning;
    final icon = status == 'APPROVED' ? Icons.check_circle : status == 'REJECTED' ? Icons.cancel : Icons.hourglass_top;
    return Icon(icon, color: color, semanticLabel: kPaymentLabels[status]);
  }
}
