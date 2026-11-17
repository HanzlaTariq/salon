import 'package:flutter_test/flutter_test.dart';
import 'package:saloon/discovery/qr_models.dart';

void main() {
  group('parseSalonCode', () {
    test('reads the code from a salon link on any host, and from a bare code in any case', () {
      expect(parseSalonCode('https://book.example.com/s/abcd2fgh3j'), 'abcd2fgh3j');
      expect(parseSalonCode('http://localhost:3000/s/ABCD2FGH3J'), 'abcd2fgh3j');
      expect(parseSalonCode('https://book.example.com/s/abcd2fgh3j/'), 'abcd2fgh3j');
      expect(parseSalonCode('  ABCD2FGH3J '), 'abcd2fgh3j');
    });

    test('rejects everything that is not a salon code', () {
      for (final bad in [
        '', 'abc', 'abcd2fgh3jk', 'abcd2fgh3i', 'abcd2fgh30',
        'https://book.example.com/x/abcd2fgh3j', 'https://book.example.com/s/abcd2fgh3j/extra', 'https://book.example.com/s/',
        'javascript:alert(1)', 'ftp://host/s/abcd2fgh3j', 'WIFI:S:home;T:WPA;P:secret;;', 'abcd2fgh3j; drop table',
      ]) {
        expect(parseSalonCode(bad), isNull, reason: bad);
      }
      expect(parseSalonCode('a' * 400), isNull);
    });
  });

  test('ScannedSalon tolerates missing and wrong-typed fields', () {
    final s = ScannedSalon.fromJson({'code': 'abcd2fgh3j', 'salonId': 7, 'name': 'Glow'});
    expect(s.salonId, '');
    expect(s.name, 'Glow');
    expect(s.city, '');
  });
}
