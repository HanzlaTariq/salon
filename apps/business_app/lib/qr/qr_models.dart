/// The salon's permanent link, as sent by `GET /salons/mine/qr`. The app never builds a link itself: the server owns the code and the base URL.
class SalonQrInfo {
  const SalonQrInfo({required this.code, required this.link, required this.salonName, required this.posterSizes, required this.posterThemes});

  final String code;
  final String link;
  final String salonName;
  final List<String> posterSizes;
  final List<String> posterThemes;

  factory SalonQrInfo.fromJson(Map<String, dynamic> j) {
    List<String> strings(Object? v, List<String> fallback) {
      final list = v is List ? v.whereType<String>().toList() : <String>[];
      return list.isEmpty ? fallback : list;
    }

    return SalonQrInfo(
      code: j['code'] is String ? j['code'] as String : '',
      link: j['link'] is String ? j['link'] as String : '',
      salonName: j['salonName'] is String ? j['salonName'] as String : '',
      posterSizes: strings(j['posterSizes'], const ['A4', 'A5']),
      posterThemes: strings(j['posterThemes'], const ['light', 'dark']),
    );
  }
}

/// File name used when sharing or saving the poster, e.g. `glow-studio-poster-a4.pdf`.
String posterFileName(String salonName, String size) {
  final slug = salonName.toLowerCase().replaceAll(RegExp(r'[^a-z0-9]+'), '-').replaceAll(RegExp(r'^-+|-+$'), '');
  return '${slug.isEmpty ? 'salon' : slug}-poster-${size.toLowerCase()}.pdf';
}
