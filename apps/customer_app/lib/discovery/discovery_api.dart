import 'dart:async';
import 'dart:convert';

import 'package:flutter_core/flutter_core.dart';
import 'package:http/http.dart' as http;

import 'discovery_filters.dart';
import 'discovery_models.dart';

/// Read-only client for the PUBLIC discovery endpoints (no sign-in needed, nothing is cached on disk).
/// Errors use the same [ApiException] as the auth client, so screens show consistent messages.
class DiscoveryApi {
  DiscoveryApi({http.Client? client, String? baseUrl, this.timeout = const Duration(seconds: 15)})
      : _client = client ?? http.Client(),
        _baseUrl = (baseUrl ?? AuthConfig.apiBaseUrl).replaceAll(RegExp(r'/+$'), '');

  final http.Client _client;
  final String _baseUrl;
  final Duration timeout;

  Future<DiscoveryOptions> options() async => DiscoveryOptions.fromJson(await _get('/public/discovery/options'));

  Future<SearchPage> search(DiscoveryFilters filters, {int page = 1, int pageSize = 20}) async =>
      SearchPage.fromJson(await _get('/public/discovery/salons', filters.toQuery(page: page, pageSize: pageSize)));

  Future<SalonProfile> salon(String id) async => SalonProfile.fromJson(await _get('/public/salons/$id'));

  Future<List<CatalogCategory>> catalog(String id) async => parseCatalog(await _get('/public/salons/$id/catalog'));

  Future<AvailabilityResult> availability({required String salonId, required String date, required List<String> serviceIds}) async =>
      AvailabilityResult.fromJson(await _get('/public/discovery/salons/$salonId/availability', {'date': date, 'serviceIds': serviceIds.join(',')}));

  Future<Map<String, dynamic>> _get(String path, [Map<String, String>? query]) async {
    final uri = Uri.parse('$_baseUrl$path').replace(queryParameters: query == null || query.isEmpty ? null : query);
    final http.Response response;
    try {
      response = await _client.get(uri, headers: const {'Accept': 'application/json', 'X-Client-Type': 'mobile'}).timeout(timeout);
    } catch (_) {
      throw ApiException.network();
    }
    if (response.statusCode >= 200 && response.statusCode < 300) {
      final decoded = jsonDecode(response.body);
      final data = decoded is Map<String, dynamic> ? decoded['data'] : null;
      if (data is Map<String, dynamic>) return data;
      throw ApiException.fromResponse(500, '');
    }
    throw ApiException.fromResponse(response.statusCode, response.body);
  }

  void close() => _client.close();
}
