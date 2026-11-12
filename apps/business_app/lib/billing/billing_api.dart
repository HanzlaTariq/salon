import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_core/flutter_core.dart';
import 'package:http/http.dart' as http;

import 'billing_models.dart';

/// Client for the Phase 6 owner billing endpoints. Every call goes through [AuthRepository.authorized]
/// (single-flight token refresh). The salon id, prices, amounts and statuses are NEVER sent or trusted from the
/// app: the server derives the salon from the session and computes every amount itself.
class BillingApi {
  BillingApi({required this.repository, http.Client? client, String? baseUrl})
      : _client = client ?? http.Client(),
        _base = (baseUrl ?? AuthConfig.apiBaseUrl).replaceAll(RegExp(r'/+$'), '');

  final AuthRepository repository;
  final http.Client _client;
  final String _base;

  Map<String, String> _headers(String token, {bool json = true}) => {
        'Authorization': 'Bearer $token',
        'Accept': 'application/json',
        'X-Client-Type': 'mobile',
        if (json) 'Content-Type': 'application/json',
      };

  Future<BillingSummary> summary() async => BillingSummary.fromJson(await _json('GET', '/salons/mine/billing'));

  Future<List<InvoiceInfo>> invoices() async {
    final data = await _json('GET', '/salons/mine/billing/invoices');
    return (data['items'] as List<dynamic>).map((e) => InvoiceInfo.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<List<PaymentInfo>> payments() async {
    final data = await _json('GET', '/salons/mine/billing/payments');
    return (data['items'] as List<dynamic>).map((e) => PaymentInfo.fromJson(e as Map<String, dynamic>)).toList();
  }

  /// [cycle] is MONTHLY or YEARLY. The invoice amount is calculated by the server from the current team and price list.
  Future<InvoiceInfo> createInvoice(String cycle) async => InvoiceInfo.fromJson(await _json('POST', '/salons/mine/billing/invoices', {'cycle': cycle}));

  Future<void> cancelInvoice(String invoiceId) async {
    await _json('POST', '/salons/mine/billing/invoices/$invoiceId/cancel');
  }

  /// The amount must equal the invoice total (the server refuses anything else). The payment is PENDING until a
  /// reviewer verifies it: the subscription is never activated by this call.
  Future<PaymentInfo> submitPayment({
    required String invoiceId,
    required String method,
    required String transactionId,
    required String amount,
    required String paidOn,
    String? senderName,
    String? note,
    required Uint8List receiptBytes,
    required String receiptFilename,
  }) async {
    final data = await _multipart('/salons/mine/billing/invoices/$invoiceId/payments', {
      'method': method,
      'transactionId': transactionId,
      'claimedAmount': amount,
      'paidOn': paidOn,
      if (senderName != null && senderName.isNotEmpty) 'senderName': senderName,
      if (note != null && note.isNotEmpty) 'note': note,
    }, receiptBytes, receiptFilename);
    return PaymentInfo.fromJson(data);
  }

  /// Answers a "more information" request: new note, optional corrected transaction id, optional replacement receipt.
  Future<PaymentInfo> respond({
    required String paymentId,
    required String note,
    String? transactionId,
    Uint8List? receiptBytes,
    String? receiptFilename,
  }) async {
    final data = await _multipart('/salons/mine/billing/payments/$paymentId/respond', {
      'note': note,
      if (transactionId != null && transactionId.isNotEmpty) 'transactionId': transactionId,
    }, receiptBytes, receiptFilename);
    return PaymentInfo.fromJson(data);
  }

  Future<Map<String, dynamic>> _multipart(String path, Map<String, String> fields, Uint8List? file, String? filename) {
    return repository.authorized((token) async {
      final request = http.MultipartRequest('POST', Uri.parse('$_base$path'))
        ..headers.addAll(_headers(token, json: false))
        ..fields.addAll(fields);
      if (file != null) request.files.add(http.MultipartFile.fromBytes('receipt', file, filename: filename ?? 'receipt.jpg'));
      final res = await _send(() async => http.Response.fromStream(await _client.send(request)), timeout: const Duration(seconds: 90));
      return _decode(res);
    });
  }

  Future<Map<String, dynamic>> _json(String method, String path, [Map<String, dynamic>? body]) {
    return repository.authorized((token) async {
      final uri = Uri.parse('$_base$path');
      final res = await _send(() async {
        final request = http.Request(method, uri)..headers.addAll(_headers(token));
        if (body != null) request.body = jsonEncode(body);
        return http.Response.fromStream(await _client.send(request));
      });
      return _decode(res);
    });
  }

  Map<String, dynamic> _decode(http.Response res) {
    if (res.statusCode < 200 || res.statusCode >= 300) throw ApiException.fromResponse(res.statusCode, res.body);
    final decoded = jsonDecode(res.body);
    final data = decoded is Map<String, dynamic> ? decoded['data'] : null;
    if (data is! Map<String, dynamic>) throw ApiException.fromResponse(500, '');
    return data;
  }

  Future<http.Response> _send(Future<http.Response> Function() call, {Duration timeout = const Duration(seconds: 20)}) async {
    try {
      return await call().timeout(timeout);
    } on ApiException {
      rethrow;
    } catch (_) {
      throw ApiException.network();
    }
  }

  void close() => _client.close();
}
