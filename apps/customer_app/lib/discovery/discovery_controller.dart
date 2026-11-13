import 'package:flutter/foundation.dart';
import 'package:flutter_core/flutter_core.dart';

import 'discovery_api.dart';
import 'discovery_filters.dart';
import 'discovery_models.dart';
import 'location_service.dart';

/// State of the discovery list: options (cities), filters, paged results and the OPTIONAL location.
/// Responses of an older request are dropped (the user may change filters while one is in flight).
class DiscoveryController extends ChangeNotifier {
  DiscoveryController({required DiscoveryApi api, required LocationService location})
      : _api = api,
        _location = location;

  final DiscoveryApi _api;
  final LocationService _location;

  DiscoveryOptions? options;
  ApiException? optionsError;
  DiscoveryFilters filters = const DiscoveryFilters();

  List<SalonCard> items = const [];
  int total = 0;
  bool hasMore = false;
  bool loading = false;
  bool loadingMore = false;
  ApiException? error;
  ApiException? moreError;

  LocationStatus locationStatus = LocationStatus.unknown;
  bool locating = false;

  int _page = 1;
  int _generation = 0;

  Future<void> start() => Future.wait([_loadOptions(), refresh()]);

  Future<void> _loadOptions() async {
    try {
      options = await _api.options();
      optionsError = null;
    } on ApiException catch (e) {
      optionsError = e;
    }
    notifyListeners();
  }

  Future<void> applyFilters(DiscoveryFilters next) {
    filters = next;
    return refresh();
  }

  Future<void> refresh() async {
    final generation = ++_generation;
    loading = true;
    loadingMore = false;
    error = null;
    moreError = null;
    notifyListeners();
    try {
      final page = await _api.search(filters);
      if (generation != _generation) return;
      items = page.items;
      total = page.total;
      hasMore = page.hasMore;
      _page = page.page;
    } on ApiException catch (e) {
      if (generation != _generation) return;
      error = e;
      items = const [];
      total = 0;
      hasMore = false;
    }
    loading = false;
    notifyListeners();
  }

  Future<void> loadMore() async {
    if (loading || loadingMore || !hasMore) return;
    final generation = _generation;
    loadingMore = true;
    moreError = null;
    notifyListeners();
    try {
      final page = await _api.search(filters, page: _page + 1);
      if (generation != _generation) return;
      items = [...items, ...page.items];
      total = page.total;
      hasMore = page.hasMore;
      _page = page.page;
    } on ApiException catch (e) {
      if (generation != _generation) return;
      moreError = e;
    }
    loadingMore = false;
    notifyListeners();
  }

  /// Asks for location permission (only now, on the customer's tap). If it is refused the list keeps working by city.
  Future<void> useMyLocation() async {
    locating = true;
    notifyListeners();
    final result = await _location.current();
    locating = false;
    locationStatus = result.status;
    if (!result.ok) {
      notifyListeners();
      return;
    }
    await applyFilters(filters.copyWith(
      lat: result.lat,
      lng: result.lng,
      radiusKm: (options?.radiusDefaultKm ?? 10).toDouble(),
      sort: 'nearest',
    ));
  }

  Future<void> clearLocation() => applyFilters(filters.copyWith(
        lat: null,
        lng: null,
        radiusKm: null,
        sort: filters.sort == 'nearest' ? null : filters.sort,
      ));
}
