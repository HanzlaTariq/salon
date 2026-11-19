import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter_core/flutter_core.dart';
import 'package:http/http.dart' as http;

import 'reports_models.dart';

/// Client for the Phase 13 report endpoints. Every call goes through [AuthRepository.authorized] (single-flight token refresh).
/// The salon id and staff id are NEVER sent: the server derives them from the session. Reports need a connection (they are
/// computed on the server); the offline-first screens of Phase 12 are unaffected.
class ReportsApi {
  ReportsApi({required this.repository, http.Client? client, String? baseUrl})
      : _client = client ?? http.Client(),
        _base = (baseUrl ?? AuthConfig.apiBaseUrl).replaceAll(RegExp(r'/+$'), '');

  final AuthRepository repository;
  final http.Client _client;
  final String _base;

  String _q(String from, String to) => 'from=$from&to=$to';

  // ---- owner reports
  Future<ReportSummary> summary(String from, String to) async => ReportSummary.fromJson(await _json('GET', '/salons/mine/reports/summary?${_q(from, to)}'));

  Future<TrendData> trend(String from, String to) async => TrendData.fromJson(await _json('GET', '/salons/mine/reports/trend?${_q(from, to)}'));

  Future<List<StaffStat>> staff(String from, String to) async {
    final d = await _json('GET', '/salons/mine/reports/staff?${_q(from, to)}');
    return (d['items'] as List<dynamic>).map((e) => StaffStat.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<List<ServiceStat>> services(String from, String to) async {
    final d = await _json('GET', '/salons/mine/reports/services?${_q(from, to)}&limit=10');
    return (d['items'] as List<dynamic>).map((e) => ServiceStat.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<RetentionData> retention(String from, String to) async => RetentionData.fromJson(await _json('GET', '/salons/mine/reports/retention?${_q(from, to)}'));

  Future<ExpenseSummary> expenseSummary(String from, String to) async => ExpenseSummary.fromJson(await _json('GET', '/salons/mine/reports/expenses?${_q(from, to)}'));

  // ---- owner expenses
  Future<ExpensePage> expenses(String from, String to, {int page = 1, String? category}) async => ExpensePage.fromJson(
        await _json('GET', '/salons/mine/expenses?${_q(from, to)}&page=$page${category == null ? '' : '&category=$category'}'),
      );

  /// [idempotencyKey] must stay the same for retries of the SAME form submission, so a bad network never records an expense twice.
  Future<ExpenseItem> addExpense({required String category, required String amount, required String expenseDate, String? description, required String idempotencyKey}) async {
    final d = await _json('POST', '/salons/mine/expenses', {
      'category': category,
      'amount': amount,
      'expenseDate': expenseDate,
      if (description != null && description.trim().isNotEmpty) 'description': description.trim(),
    }, {'Idempotency-Key': idempotencyKey});
    return ExpenseItem.fromJson(d['expense'] as Map<String, dynamic>);
  }

  Future<ExpenseItem> updateExpense(String id, {required String category, required String amount, required String expenseDate, String? description}) async {
    final d = await _json('PATCH', '/salons/mine/expenses/$id', {
      'category': category,
      'amount': amount,
      'expenseDate': expenseDate,
      'description': (description == null || description.trim().isEmpty) ? null : description.trim(),
    });
    return ExpenseItem.fromJson(d);
  }

  Future<void> deleteExpense(String id) async {
    await _json('DELETE', '/salons/mine/expenses/$id');
  }

  // ---- staff: own performance
  Future<MyPerformance> myPerformance(String from, String to) async => MyPerformance.fromJson(await _json('GET', '/staff/me/reports/performance?${_q(from, to)}'));

  /// A fresh key for one "add expense" form submission.
  static String newIdempotencyKey() {
    final r = Random.secure();
    final tail = List.generate(12, (_) => r.nextInt(36).toRadixString(36)).join();
    return 'exp-${DateTime.now().microsecondsSinceEpoch.toRadixString(36)}-$tail';
  }

  // ---- plumbing
  Map<String, String> _headers(String token, bool hasBody, Map<String, String>? extra) => {
        'Authorization': 'Bearer $token',
        'Accept': 'application/json',
        'X-Client-Type': 'mobile',
        if (hasBody) 'Content-Type': 'application/json',
        ...?extra,
      };

  Future<Map<String, dynamic>> _json(String method, String path, [Map<String, dynamic>? body, Map<String, String>? headers]) {
    return repository.authorized((token) async {
      final res = await _send(() async {
        final request = http.Request(method, Uri.parse('$_base$path'))..headers.addAll(_headers(token, body != null, headers));
        if (body != null) request.body = jsonEncode(body);
        return http.Response.fromStream(await _client.send(request));
      });
      return _decode(res);
    });
  }

  Map<String, dynamic> _decode(http.Response res) {
    if (res.statusCode < 200 || res.statusCode >= 300) throw ApiException.fromResponse(res.statusCode, res.body);
    if (res.statusCode == 204 || res.body.isEmpty) return const <String, dynamic>{};
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
