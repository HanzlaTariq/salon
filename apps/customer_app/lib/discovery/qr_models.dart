/// Characters a salon code can contain (no i, l, o, 0, 1). Must match the server (`QR_CODE_RE`).
final RegExp _codeRe = RegExp(r'^[a-hj-km-np-z2-9]{10}$');

/// Extracts the salon code from what a QR scanner read or a person typed:
///   * a full link  `https://any.host/s/abcd2fgh3j`  (the last path segment after `/s/`),
///   * or the bare code, in any letter case.
/// Returns null for anything else. The host is NOT checked: the code is verified by the server, and the app never opens the link.
String? parseSalonCode(String raw) {
  final text = raw.trim();
  if (text.isEmpty || text.length > 300) return null;
  var candidate = text;
  final uri = Uri.tryParse(text);
  if (uri != null && uri.hasScheme) {
    if (uri.scheme != 'http' && uri.scheme != 'https') return null;
    final segs = uri.pathSegments.where((s) => s.isNotEmpty).toList();
    if (segs.length != 2 || segs[0] != 's') return null;
    candidate = segs[1];
  }
  candidate = candidate.toLowerCase();
  return _codeRe.hasMatch(candidate) ? candidate : null;
}

/// Answer of `GET /public/qr/:code`: just enough to open the salon; the full profile comes from the public salon endpoints.
class ScannedSalon {
  const ScannedSalon({required this.code, required this.salonId, required this.name, required this.salonType, required this.city, required this.area});

  final String code;
  final String salonId;
  final String name;
  final String salonType;
  final String city;
  final String area;

  factory ScannedSalon.fromJson(Map<String, dynamic> j) {
    String s(String k) => j[k] is String ? j[k] as String : '';
    return ScannedSalon(code: s('code'), salonId: s('salonId'), name: s('name'), salonType: s('salonType'), city: s('city'), area: s('area'));
  }
}
