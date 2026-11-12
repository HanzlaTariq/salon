import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_core/flutter_core.dart';
import 'package:image_picker/image_picker.dart';

import 'billing_api.dart';
import 'billing_models.dart';

final _txnPattern = RegExp(r'^[A-Za-z0-9][A-Za-z0-9._/-]{3,39}$');

String _isoDate(DateTime d) => '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

/// Owner reports a manual payment: pick the method, send the money from JazzCash / Easypaisa / the bank, then enter
/// the transaction ID and attach the receipt. The payment stays "waiting for verification" until Super Admin or
/// Finance approves it; nothing here ever activates a subscription by itself.
class PaymentFormScreen extends StatefulWidget {
  const PaymentFormScreen({super.key, required this.api, required this.invoice, required this.methods});

  final BillingApi api;
  final InvoiceInfo invoice;
  final List<PaymentMethodInfo> methods;

  @override
  State<PaymentFormScreen> createState() => _PaymentFormScreenState();
}

class _PaymentFormScreenState extends State<PaymentFormScreen> {
  final _formKey = GlobalKey<FormState>();
  final _txn = TextEditingController();
  final _sender = TextEditingController();
  final _note = TextEditingController();
  final _picker = ImagePicker();
  late PaymentMethodInfo _method = widget.methods.first;
  DateTime _paidOn = DateTime.now();
  Uint8List? _receipt;
  String _receiptName = 'receipt.jpg';
  bool _busy = false;
  String? _error;
  String? _receiptError;

  @override
  void dispose() {
    _txn.dispose();
    _sender.dispose();
    _note.dispose();
    super.dispose();
  }

  Future<void> _pickReceipt() async {
    try {
      final file = await _picker.pickImage(source: ImageSource.gallery, maxWidth: 2200, imageQuality: 88);
      if (file == null) return;
      final bytes = await file.readAsBytes();
      if (!mounted) return;
      setState(() {
        _receipt = bytes;
        _receiptName = file.name.isEmpty ? 'receipt.jpg' : file.name;
        _receiptError = null;
      });
    } catch (_) {
      if (mounted) setState(() => _receiptError = 'Could not open your photos. Check the app permission and try again.');
    }
  }

  Future<void> _pickDate() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: _paidOn,
      firstDate: now.subtract(const Duration(days: 60)),
      lastDate: now,
      helpText: 'Date you sent the money',
    );
    if (picked != null && mounted) setState(() => _paidOn = picked);
  }

  Future<void> _submit() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    if (_receipt == null) {
      setState(() => _receiptError = 'Attach a clear photo or screenshot of the receipt.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.api.submitPayment(
        invoiceId: widget.invoice.id,
        method: _method.method,
        transactionId: _txn.text.trim(),
        amount: widget.invoice.total,
        paidOn: _isoDate(_paidOn),
        senderName: _sender.text.trim(),
        note: _note.text.trim(),
        receiptBytes: _receipt!,
        receiptFilename: _receiptName,
      );
      if (mounted) Navigator.of(context).pop(true);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final inv = widget.invoice;
    return Scaffold(
      appBar: AppBar(title: const Text('Report your payment')),
      body: SafeArea(
        child: Form(
          key: _formKey,
          child: ListView(
            padding: const EdgeInsets.all(AppSpacing.lg),
            children: [
              Text('Invoice ${inv.invoiceNo}', style: theme.textTheme.titleMedium),
              const SizedBox(height: AppSpacing.xs),
              Text(formatPkr(inv.total), style: theme.textTheme.headlineMedium),
              const SizedBox(height: AppSpacing.xs),
              Text('Send exactly this amount. Partial payments are not accepted.', style: theme.textTheme.bodySmall),
              const SizedBox(height: AppSpacing.lg),
              DropdownButtonFormField<PaymentMethodInfo>(
                value: _method,
                decoration: const InputDecoration(labelText: 'How did you pay?'),
                items: [for (final m in widget.methods) DropdownMenuItem(value: m, child: Text(m.label))],
                onChanged: _busy ? null : (m) => setState(() => _method = m ?? _method),
              ),
              const SizedBox(height: AppSpacing.md),
              _MethodCard(method: _method),
              const SizedBox(height: AppSpacing.lg),
              TextFormField(
                controller: _txn,
                enabled: !_busy,
                textCapitalization: TextCapitalization.characters,
                decoration: const InputDecoration(labelText: 'Transaction ID', helperText: 'From the SMS or the receipt, e.g. 12345678901'),
                maxLength: 40,
                validator: (v) => _txnPattern.hasMatch((v ?? '').trim()) ? null : 'Enter the transaction ID (4 to 40 letters or digits).',
              ),
              InkWell(
                onTap: _busy ? null : _pickDate,
                child: InputDecorator(
                  decoration: const InputDecoration(labelText: 'Date paid'),
                  child: Row(children: [Expanded(child: Text(formatDay(_isoDate(_paidOn)))), const Icon(Icons.calendar_today_outlined, size: 18)]),
                ),
              ),
              const SizedBox(height: AppSpacing.md),
              TextFormField(
                controller: _sender,
                enabled: !_busy,
                decoration: const InputDecoration(labelText: 'Sender name (optional)', helperText: 'The name on the account you paid from'),
                maxLength: 80,
              ),
              TextFormField(controller: _note, enabled: !_busy, decoration: const InputDecoration(labelText: 'Note (optional)'), maxLength: 300, maxLines: 2),
              const SizedBox(height: AppSpacing.md),
              OutlinedButton.icon(
                onPressed: _busy ? null : _pickReceipt,
                icon: const Icon(Icons.receipt_long_outlined),
                label: Text(_receipt == null ? 'Attach receipt photo' : 'Receipt attached: replace'),
              ),
              if (_receipt != null) ...[
                const SizedBox(height: AppSpacing.sm),
                ClipRRect(borderRadius: BorderRadius.circular(AppRadius.input), child: Image.memory(_receipt!, height: 180, fit: BoxFit.cover, semanticLabel: 'Receipt preview')),
              ],
              if (_receiptError != null) Padding(padding: const EdgeInsets.only(top: AppSpacing.sm), child: Text(_receiptError!, style: const TextStyle(color: AppColors.danger))),
              if (_error != null) Padding(padding: const EdgeInsets.only(top: AppSpacing.md), child: Text(_error!, style: const TextStyle(color: AppColors.danger))),
              const SizedBox(height: AppSpacing.xl),
              FilledButton(
                onPressed: _busy ? null : _submit,
                child: _busy ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2)) : const Text('Submit for verification'),
              ),
              const SizedBox(height: AppSpacing.sm),
              Text('Your subscription starts only after our team verifies the payment. We never ask for your PIN or password.', style: theme.textTheme.bodySmall),
            ],
          ),
        ),
      ),
    );
  }
}

/// Where to send the money (configured by the platform, never hardcoded in the app).
class _MethodCard extends StatelessWidget {
  const _MethodCard({required this.method});

  final PaymentMethodInfo method;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Send the money to', style: theme.textTheme.labelLarge),
          const SizedBox(height: AppSpacing.xs),
          Text(method.accountTitle, style: theme.textTheme.titleMedium),
          if (method.bankName != null) Text(method.bankName!, style: theme.textTheme.bodyMedium),
          Row(children: [
            Expanded(child: SelectableText(method.accountNumber, style: theme.textTheme.titleLarge)),
            IconButton(
              tooltip: 'Copy account number',
              icon: const Icon(Icons.copy_outlined),
              onPressed: () async {
                await Clipboard.setData(ClipboardData(text: method.accountNumber));
                if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Account number copied')));
              },
            ),
          ]),
          if (method.instructions != null) Text(method.instructions!, style: theme.textTheme.bodySmall),
        ]),
      ),
    );
  }
}
