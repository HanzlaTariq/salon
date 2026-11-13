import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';

import 'discovery_api.dart';
import 'discovery_controller.dart';
import 'discovery_filters.dart';
import 'discovery_models.dart';
import 'filters_sheet.dart';
import 'location_service.dart';
import 'salon_card.dart';
import 'salon_profile_screen.dart';

/// Customer home: search by text, city/area, "Near me" (optional location) and filters, with paged results.
class DiscoveryHomeScreen extends StatefulWidget {
  const DiscoveryHomeScreen({super.key, required this.api, required this.repository, this.location});

  final DiscoveryApi api;
  final AuthRepository repository;
  final LocationService? location;

  @override
  State<DiscoveryHomeScreen> createState() => _DiscoveryHomeScreenState();
}

class _DiscoveryHomeScreenState extends State<DiscoveryHomeScreen> {
  late final DiscoveryController _c = DiscoveryController(api: widget.api, location: widget.location ?? GeolocatorLocationService());
  final _scroll = ScrollController();
  final _search = TextEditingController();
  Timer? _debounce;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(() {
      if (_scroll.hasClients && _scroll.position.extentAfter < 400) _c.loadMore();
    });
    _c.start();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _scroll.dispose();
    _search.dispose();
    _c.dispose();
    super.dispose();
  }

  void _onSearchChanged(String text) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 450), () => _c.applyFilters(_c.filters.copyWith(query: text.trim().isEmpty ? null : text.trim())));
  }

  Future<void> _pickCity() async {
    final options = _c.options;
    final picked = await showModalBottomSheet<({String? city, String? area})>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      showDragHandle: true,
      builder: (_) => _CitySheet(options: options, selectedCity: _c.filters.city, selectedArea: _c.filters.area),
    );
    if (picked != null) await _c.applyFilters(_c.filters.copyWith(city: picked.city, area: picked.area));
  }

  Future<void> _openFilters() async {
    final next = await showFiltersSheet(context, current: _c.filters, options: _c.options);
    if (next != null) await _c.applyFilters(next);
  }

  String? _locationHint(LocationStatus s) => switch (s) {
        LocationStatus.denied => 'Location permission was not given. You can still search by city and area.',
        LocationStatus.deniedForever => 'Location is blocked for this app. Turn it on in phone settings, or search by city and area.',
        LocationStatus.serviceOff => 'Location is switched off on your phone. You can still search by city and area.',
        LocationStatus.unavailable => 'Could not get your location. You can still search by city and area.',
        _ => null,
      };

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: _c,
      builder: (context, _) {
        final f = _c.filters;
        final hint = _locationHint(_c.locationStatus);
        return Scaffold(
          appBar: AppBar(
            title: const Text('Find a salon'),
            actions: [IconButton(tooltip: 'Sign out', icon: const Icon(Icons.logout), onPressed: widget.repository.logout)],
          ),
          body: Column(children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(AppSpacing.lg, AppSpacing.sm, AppSpacing.lg, AppSpacing.sm),
              child: TextField(
                controller: _search,
                textInputAction: TextInputAction.search,
                maxLength: 80,
                onChanged: _onSearchChanged,
                decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Salon, area or service', counterText: ''),
              ),
            ),
            SizedBox(
              height: 48,
              child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg), children: [
                ActionChip(
                  avatar: const Icon(Icons.location_city, size: 18),
                  label: Text(f.city == null ? 'City' : (f.area == null ? f.city! : '${f.area}, ${f.city}')),
                  onPressed: _pickCity,
                ),
                const SizedBox(width: AppSpacing.sm),
                FilterChip(
                  avatar: _c.locating ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.near_me, size: 18),
                  label: const Text('Near me'),
                  selected: f.hasLocation,
                  onSelected: _c.locating ? null : (on) => on ? _c.useMyLocation() : _c.clearLocation(),
                ),
                const SizedBox(width: AppSpacing.sm),
                ActionChip(
                  avatar: const Icon(Icons.tune, size: 18),
                  label: Text(f.activeFilterCount == 0 ? 'Filters' : 'Filters (${f.activeFilterCount})'),
                  onPressed: _openFilters,
                ),
              ]),
            ),
            if (hint != null)
              Padding(padding: const EdgeInsets.fromLTRB(AppSpacing.lg, AppSpacing.sm, AppSpacing.lg, 0), child: Text(hint, style: Theme.of(context).textTheme.bodySmall?.copyWith(color: AppColors.warning))),
            Expanded(child: _results()),
          ]),
        );
      },
    );
  }

  Widget _results() {
    if (_c.loading && _c.items.isEmpty) return const LoadingView(label: 'Finding salons…');
    final error = _c.error;
    if (error != null) return ErrorView(message: error.message, requestId: error.requestId, onRetry: _c.refresh);
    if (_c.items.isEmpty) {
      return EmptyView(
        icon: Icons.search_off,
        title: 'No salons found',
        message: 'Try a different city, widen your filters or search another service.',
        action: OutlinedButton(
          onPressed: () {
            _search.clear();
            _c.applyFilters(DiscoveryFilters(lat: _c.filters.lat, lng: _c.filters.lng, radiusKm: _c.filters.radiusKm, sort: _c.filters.hasLocation ? 'nearest' : null));
          },
          child: const Text('Clear search and filters'),
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: _c.refresh,
      child: ListView.builder(
        controller: _scroll,
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.only(bottom: AppSpacing.xl),
        itemCount: _c.items.length + 1,
        itemBuilder: (context, i) {
          if (i == _c.items.length) return _footer();
          final salon = _c.items[i];
          return SalonCardTile(
            salon: salon,
            onTap: () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => SalonProfileScreen(api: widget.api, card: salon))),
          );
        },
      ),
    );
  }

  Widget _footer() {
    if (_c.loadingMore) return const Padding(padding: EdgeInsets.all(AppSpacing.xl), child: Center(child: CircularProgressIndicator(strokeWidth: 2.5)));
    if (_c.moreError != null) {
      return Padding(padding: const EdgeInsets.all(AppSpacing.lg), child: Center(child: OutlinedButton(onPressed: _c.loadMore, child: const Text('Could not load more. Try again'))));
    }
    return Padding(
      padding: const EdgeInsets.all(AppSpacing.lg),
      child: Center(child: Text(_c.hasMore ? '' : '${_c.total} ${_c.total == 1 ? 'salon' : 'salons'}', style: Theme.of(context).textTheme.bodySmall?.copyWith(color: AppColors.mutedText))),
    );
  }
}

class _CitySheet extends StatefulWidget {
  const _CitySheet({required this.options, required this.selectedCity, required this.selectedArea});
  final DiscoveryOptions? options;
  final String? selectedCity;
  final String? selectedArea;

  @override
  State<_CitySheet> createState() => _CitySheetState();
}

class _CitySheetState extends State<_CitySheet> {
  late String? _city = widget.selectedCity;

  @override
  Widget build(BuildContext context) {
    final cities = widget.options?.cities ?? const <CityOption>[];
    if (cities.isEmpty) {
      return const SizedBox(height: 220, child: EmptyView(icon: Icons.location_off, title: 'No cities yet', message: 'Salons will appear here as they join.'));
    }
    CityOption? current;
    for (final c in cities) {
      if (c.city.toLowerCase() == _city?.toLowerCase()) current = c;
    }
    return ListView(shrinkWrap: true, padding: const EdgeInsets.fromLTRB(AppSpacing.xl, 0, AppSpacing.xl, AppSpacing.xl), children: [
      Text('Choose a city', style: Theme.of(context).textTheme.titleLarge),
      const SizedBox(height: AppSpacing.md),
      Wrap(spacing: AppSpacing.sm, runSpacing: AppSpacing.sm, children: [
        ChoiceChip(label: const Text('All cities'), selected: _city == null, onSelected: (_) => Navigator.pop(context, (city: null, area: null))),
        for (final c in cities)
          ChoiceChip(label: Text('${c.city} (${c.salons})'), selected: c.city.toLowerCase() == _city?.toLowerCase(), onSelected: (_) => setState(() => _city = c.city)),
      ]),
      if (current != null) ...[
        const SizedBox(height: AppSpacing.xl),
        Text('Area in ${current.city}', style: Theme.of(context).textTheme.titleSmall),
        const SizedBox(height: AppSpacing.sm),
        Wrap(spacing: AppSpacing.sm, runSpacing: AppSpacing.sm, children: [
          ChoiceChip(label: const Text('Whole city'), selected: widget.selectedArea == null, onSelected: (_) => Navigator.pop(context, (city: current!.city, area: null))),
          for (final a in current.areas)
            ChoiceChip(
              label: Text('${a.area} (${a.salons})'),
              selected: a.area.toLowerCase() == widget.selectedArea?.toLowerCase(),
              onSelected: (_) => Navigator.pop(context, (city: current!.city, area: a.area)),
            ),
        ]),
      ],
    ]);
  }
}
