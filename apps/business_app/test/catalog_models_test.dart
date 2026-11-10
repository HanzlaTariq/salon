import 'package:flutter_test/flutter_test.dart';
import 'package:salon_business/catalog/catalog_models.dart';

void main() {
  test('parses the catalogue and formats price labels', () {
    final o = CatalogOverview.fromJson({
      'canEdit': true,
      'categories': [
        {
          'id': 'c1', 'name': 'Hair', 'description': null, 'isActive': true,
          'services': [
            {'id': 's1', 'categoryId': 'c1', 'name': 'Haircut', 'description': null, 'durationMinutes': 30, 'pricingMode': 'STAFF_BASED', 'price': null, 'isActive': true,
             'staff': [{'staffId': 'a', 'price': '300.00'}, {'staffId': 'b', 'price': '500.00'}]},
            {'id': 's2', 'categoryId': 'c1', 'name': 'Beard', 'description': null, 'durationMinutes': 15, 'pricingMode': 'FIXED', 'price': '150.50', 'isActive': true, 'staff': []},
            {'id': 's3', 'categoryId': 'c1', 'name': 'Wash', 'description': null, 'durationMinutes': 10, 'pricingMode': 'FIXED', 'price': '100.00', 'isActive': false, 'staff': []},
          ],
        },
      ],
      'staff': [
        {'id': 'a', 'displayName': 'Ali', 'isOwner': true, 'isActive': true},
      ],
    });
    final s = o.categories.first.services;
    expect(s[0].priceLabel(), 'Rs 300 - 500');
    expect(s[1].priceLabel(), 'Rs 150.50');
    expect(s[2].priceLabel(), 'Rs 100');
    expect(o.staffById('a')!.isOwner, isTrue);
    expect(o.staffById('zzz'), isNull);
  });

  test('parsePrice accepts at most two decimals and a sane range', () {
    expect(parsePrice('300'), 300);
    expect(parsePrice(' 299.5 '), 299.5);
    expect(parsePrice('0'), 0);
    for (final bad in ['', '-5', '12.345', 'abc', '1e3', '1000001', '300,50']) {
      expect(parsePrice(bad), isNull, reason: bad);
    }
  });

  test('opening day serialises closed days without times', () {
    expect(const OpeningDay(weekday: 7, closed: true).toJson(), {'weekday': 7, 'closed': true});
    expect(const OpeningDay(weekday: 1, closed: false, opensAt: '10:00', closesAt: '21:00').toJson(),
        {'weekday': 1, 'closed': false, 'opensAt': '10:00', 'closesAt': '21:00'});
  });
}
