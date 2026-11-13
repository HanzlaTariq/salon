import 'package:saloon/discovery/discovery_models.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('a search card keeps nulls as nulls (no invented rating or distance)', () {
    final card = SalonCard.fromJson({
      'id': 'a', 'name': 'Rose', 'salonType': 'LADIES', 'city': 'Lahore', 'area': 'DHA', 'addressLine': '1 Road',
      'coverUrl': null, 'distanceKm': null, 'rating': null, 'ratingCount': 0, 'priceFrom': '150.00', 'priceTo': '1000.00',
      'serviceCount': 3, 'nextAvailable': {'date': '2026-11-16', 'time': '10:00'},
    });
    expect(card.rating, isNull);
    expect(card.distanceKm, isNull);
    expect(card.coverUrl, isNull);
    expect(card.nextAvailable?.time, '10:00');
    expect(card.serviceCount, 3);
  });

  test('missing optional fields do not crash parsing', () {
    final card = SalonCard.fromJson({'id': 'a'});
    expect(card.name, '');
    expect(card.priceFrom, '0');
    expect(SearchPage.fromJson({}).items, isEmpty);
    expect(DiscoveryOptions.fromJson({}).radiusMaxKm, 100);
  });

  test('options keep the server sort list (rating is not offered)', () {
    final o = DiscoveryOptions.fromJson({
      'cities': [
        {'city': 'Lahore', 'salons': 3, 'areas': [{'area': 'DHA', 'salons': 1}]},
      ],
      'salonTypes': ['MEN', 'LADIES', 'UNISEX'],
      'sorts': ['nearest', 'price_low', 'newest', 'name'],
      'radiusKm': {'default': 10, 'max': 100},
      'availabilityHorizonDays': 14,
    });
    expect(o.cities.single.areas.single.area, 'DHA');
    expect(o.sorts, isNot(contains('rating')));
    expect(o.radiusDefaultKm, 10);
  });

  test('catalog staff are compared cheapest first', () {
    final cats = parseCatalog({
      'categories': [
        {
          'id': 'c', 'name': 'Hair',
          'services': [
            {
              'id': 's', 'name': 'Haircut', 'durationMinutes': 30, 'pricingMode': 'STAFF_BASED', 'priceFrom': '300.00', 'priceTo': '500.00',
              'staff': [
                {'id': '1', 'name': 'Ahmed', 'price': '500.00'},
                {'id': '2', 'name': 'Ali', 'price': '300.00'},
              ],
            },
          ],
        },
      ],
    });
    expect(cats.single.services.single.staffByPrice.map((s) => s.name), ['Ali', 'Ahmed']);
  });

  test('availability result parses slots and totals', () {
    final r = AvailabilityResult.fromJson({
      'date': '2026-11-16', 'durationMinutes': 45,
      'staff': [
        {'staffId': 'x', 'name': 'Ali', 'totalPrice': '450.00', 'slots': ['10:00', '10:15']},
      ],
    });
    expect(r.durationMinutes, 45);
    expect(r.staff.single.slots, ['10:00', '10:15']);
  });
}
