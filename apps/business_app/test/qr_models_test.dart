import 'package:flutter_test/flutter_test.dart';
import 'package:salon_business/qr/qr_models.dart';

void main() {
  test('parses the server answer and keeps the server link as is', () {
    final i = SalonQrInfo.fromJson({
      'code': 'abcd2fgh3j', 'link': 'https://book.example.com/s/abcd2fgh3j', 'salonName': 'Glow Studio',
      'posterSizes': ['A4', 'A5'], 'posterThemes': ['light', 'dark'],
    });
    expect(i.code, 'abcd2fgh3j');
    expect(i.link, 'https://book.example.com/s/abcd2fgh3j');
    expect(i.posterSizes, ['A4', 'A5']);
  });

  test('missing or wrong-typed fields fall back safely', () {
    final i = SalonQrInfo.fromJson({'code': 5, 'posterSizes': 'x'});
    expect(i.code, '');
    expect(i.link, '');
    expect(i.posterSizes, ['A4', 'A5']);
    expect(i.posterThemes, ['light', 'dark']);
  });

  test('poster file names are safe ASCII', () {
    expect(posterFileName('Glow Studio & Spa!', 'A4'), 'glow-studio-spa-poster-a4.pdf');
    expect(posterFileName('سیلون', 'A5'), 'salon-poster-a5.pdf');
    expect(posterFileName('../../x', 'A4'), 'x-poster-a4.pdf');
  });
}
