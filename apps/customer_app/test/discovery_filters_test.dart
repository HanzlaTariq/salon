import 'package:saloon/discovery/discovery_filters.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('an empty filter sends only paging', () {
    expect(const DiscoveryFilters().toQuery(), {'page': '1', 'pageSize': '20'});
  });

  test('text is trimmed and blank values are omitted', () {
    final q = const DiscoveryFilters(query: '  rose ', city: 'Lahore', area: '   ', service: '').toQuery();
    expect(q['q'], 'rose');
    expect(q['city'], 'Lahore');
    expect(q.containsKey('area'), isFalse);
    expect(q.containsKey('service'), isFalse);
  });

  test('prices are sent as plain numbers', () {
    final q = const DiscoveryFilters(minPrice: 500, maxPrice: 1500.5).toQuery();
    expect(q['minPrice'], '500');
    expect(q['maxPrice'], '1500.5');
  });

  test('location is sent only as a pair, with radius and nearest sort', () {
    final located = const DiscoveryFilters(lat: 31.5204, lng: 74.3587, radiusKm: 10, sort: 'nearest').toQuery();
    expect(located['lat'], '31.520');
    expect(located['lng'], '74.359');
    expect(located['radiusKm'], '10');
    expect(located['sort'], 'nearest');

    final half = const DiscoveryFilters(lat: 31.5, radiusKm: 10, sort: 'nearest').toQuery();
    expect(half.containsKey('lat'), isFalse);
    expect(half.containsKey('radiusKm'), isFalse);
    expect(half.containsKey('sort'), isFalse, reason: 'the server rejects sort=nearest without a location');
  });

  test('time needs a date', () {
    expect(const DiscoveryFilters(time: '10:00').toQuery().containsKey('time'), isFalse);
    final q = const DiscoveryFilters(date: '2026-11-16', time: '10:00').toQuery();
    expect(q['date'], '2026-11-16');
    expect(q['time'], '10:00');
  });

  test('copyWith can set and clear nullable fields', () {
    const base = DiscoveryFilters(city: 'Lahore', lat: 1, lng: 2, sort: 'nearest');
    final cleared = base.copyWith(lat: null, lng: null, sort: null);
    expect(cleared.city, 'Lahore');
    expect(cleared.hasLocation, isFalse);
    expect(cleared.sort, isNull);
    expect(base.copyWith(city: 'Karachi').city, 'Karachi');
    expect(base.copyWith().city, 'Lahore');
  });

  test('activeFilterCount counts filters but not city, text or location', () {
    expect(const DiscoveryFilters(city: 'Lahore', query: 'x', lat: 1, lng: 2).activeFilterCount, 0);
    expect(const DiscoveryFilters(type: 'MEN', maxPrice: 900, date: '2026-11-16').activeFilterCount, 3);
  });
}
