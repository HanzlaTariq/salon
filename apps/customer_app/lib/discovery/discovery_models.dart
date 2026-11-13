/// Response models for the public discovery API. Parsing is defensive: a missing optional field never crashes a screen.

String _s(Map<String, dynamic> j, String k, [String fallback = '']) => j[k] is String ? j[k] as String : fallback;
String? _sn(Map<String, dynamic> j, String k) => j[k] is String ? j[k] as String : null;
int _i(Map<String, dynamic> j, String k, [int fallback = 0]) => j[k] is num ? (j[k] as num).toInt() : fallback;
double? _dn(Map<String, dynamic> j, String k) {
  final v = j[k];
  if (v is num) return v.toDouble();
  if (v is String) return double.tryParse(v);
  return null;
}

List<Map<String, dynamic>> _list(Object? v) => v is List ? v.whereType<Map<String, dynamic>>().toList() : <Map<String, dynamic>>[];

class NextSlot {
  const NextSlot({required this.date, required this.time});
  final String date;
  final String time;

  static NextSlot? fromJson(Object? v) => v is Map<String, dynamic> ? NextSlot(date: _s(v, 'date'), time: _s(v, 'time')) : null;
}

class SalonCard {
  const SalonCard({
    required this.id,
    required this.name,
    required this.salonType,
    required this.city,
    required this.area,
    required this.addressLine,
    required this.priceFrom,
    required this.priceTo,
    required this.serviceCount,
    this.coverUrl,
    this.distanceKm,
    this.rating,
    this.ratingCount = 0,
    this.nextAvailable,
  });

  final String id;
  final String name;
  final String salonType;
  final String city;
  final String area;
  final String addressLine;
  final String? coverUrl;

  /// Null when the search carried no location or the salon has no coordinates.
  final double? distanceKm;

  /// Null until reviews exist (Phase 14). Never shown as a number the server did not send.
  final double? rating;
  final int ratingCount;
  final String priceFrom;
  final String priceTo;
  final int serviceCount;

  /// A preview from working hours, not a booking.
  final NextSlot? nextAvailable;

  factory SalonCard.fromJson(Map<String, dynamic> j) => SalonCard(
        id: _s(j, 'id'),
        name: _s(j, 'name'),
        salonType: _s(j, 'salonType'),
        city: _s(j, 'city'),
        area: _s(j, 'area'),
        addressLine: _s(j, 'addressLine'),
        coverUrl: _sn(j, 'coverUrl'),
        distanceKm: _dn(j, 'distanceKm'),
        rating: _dn(j, 'rating'),
        ratingCount: _i(j, 'ratingCount'),
        priceFrom: _s(j, 'priceFrom', '0'),
        priceTo: _s(j, 'priceTo', '0'),
        serviceCount: _i(j, 'serviceCount'),
        nextAvailable: NextSlot.fromJson(j['nextAvailable']),
      );
}

class SearchPage {
  const SearchPage({required this.items, required this.total, required this.page, required this.hasMore, required this.locationUsed});
  final List<SalonCard> items;
  final int total;
  final int page;
  final bool hasMore;
  final bool locationUsed;

  factory SearchPage.fromJson(Map<String, dynamic> j) => SearchPage(
        items: _list(j['items']).map(SalonCard.fromJson).toList(),
        total: _i(j, 'total'),
        page: _i(j, 'page', 1),
        hasMore: j['hasMore'] == true,
        locationUsed: j['locationUsed'] == true,
      );
}

class AreaOption {
  const AreaOption({required this.area, required this.salons});
  final String area;
  final int salons;
}

class CityOption {
  const CityOption({required this.city, required this.salons, required this.areas});
  final String city;
  final int salons;
  final List<AreaOption> areas;
}

class DiscoveryOptions {
  const DiscoveryOptions({required this.cities, required this.salonTypes, required this.sorts, required this.radiusDefaultKm, required this.radiusMaxKm, required this.horizonDays});
  final List<CityOption> cities;
  final List<String> salonTypes;

  /// Only the orders the server can answer truthfully (no rating / popularity yet).
  final List<String> sorts;
  final int radiusDefaultKm;
  final int radiusMaxKm;
  final int horizonDays;

  factory DiscoveryOptions.fromJson(Map<String, dynamic> j) {
    final radius = j['radiusKm'] is Map<String, dynamic> ? j['radiusKm'] as Map<String, dynamic> : <String, dynamic>{};
    return DiscoveryOptions(
      cities: _list(j['cities'])
          .map((c) => CityOption(
                city: _s(c, 'city'),
                salons: _i(c, 'salons'),
                areas: _list(c['areas']).map((a) => AreaOption(area: _s(a, 'area'), salons: _i(a, 'salons'))).toList(),
              ))
          .toList(),
      salonTypes: (j['salonTypes'] is List ? (j['salonTypes'] as List).whereType<String>().toList() : <String>[]),
      sorts: (j['sorts'] is List ? (j['sorts'] as List).whereType<String>().toList() : <String>['name']),
      radiusDefaultKm: _i(radius, 'default', 10),
      radiusMaxKm: _i(radius, 'max', 100),
      horizonDays: _i(j, 'availabilityHorizonDays', 14),
    );
  }
}

class DayHours {
  const DayHours({required this.weekday, required this.closed, this.opensAt, this.closesAt});
  final int weekday;
  final bool closed;
  final String? opensAt;
  final String? closesAt;
}

class SalonPhoto {
  const SalonPhoto({required this.id, required this.url, required this.isCover});
  final String id;
  final String url;
  final bool isCover;
}

class SalonProfile {
  const SalonProfile({
    required this.id,
    required this.name,
    required this.salonType,
    required this.city,
    required this.area,
    required this.addressLine,
    required this.phone,
    required this.photos,
    this.description,
    this.openingHours,
  });
  final String id;
  final String name;
  final String salonType;
  final String city;
  final String area;
  final String addressLine;
  final String phone;
  final String? description;

  /// Null while the owner has not entered hours (not "closed all week").
  final List<DayHours>? openingHours;
  final List<SalonPhoto> photos;

  factory SalonProfile.fromJson(Map<String, dynamic> j) {
    final hours = j['openingHours'];
    return SalonProfile(
      id: _s(j, 'id'),
      name: _s(j, 'name'),
      salonType: _s(j, 'salonType'),
      city: _s(j, 'city'),
      area: _s(j, 'area'),
      addressLine: _s(j, 'addressLine'),
      phone: _s(j, 'phone'),
      description: _sn(j, 'description'),
      openingHours: hours is List
          ? _list(hours).map((d) => DayHours(weekday: _i(d, 'weekday'), closed: d['closed'] == true, opensAt: _sn(d, 'opensAt'), closesAt: _sn(d, 'closesAt'))).toList()
          : null,
      photos: _list(j['photos']).map((p) => SalonPhoto(id: _s(p, 'id'), url: _s(p, 'url'), isCover: p['isCover'] == true)).where((p) => p.url.isNotEmpty).toList(),
    );
  }
}

class StaffPrice {
  const StaffPrice({required this.id, required this.name, required this.price});
  final String id;
  final String name;

  /// Exact price this staff member charges (decimal string).
  final String price;
}

class CatalogService {
  const CatalogService({required this.id, required this.name, required this.durationMinutes, required this.pricingMode, required this.staff, this.description, this.priceFrom, this.priceTo});
  final String id;
  final String name;
  final String? description;
  final int durationMinutes;
  final String pricingMode;
  final String? priceFrom;
  final String? priceTo;
  final List<StaffPrice> staff;

  /// Staff sorted by price, cheapest first (the price comparison).
  List<StaffPrice> get staffByPrice {
    final copy = [...staff];
    copy.sort((a, b) => (double.tryParse(a.price) ?? 0).compareTo(double.tryParse(b.price) ?? 0));
    return copy;
  }
}

class CatalogCategory {
  const CatalogCategory({required this.id, required this.name, required this.services});
  final String id;
  final String name;
  final List<CatalogService> services;
}

List<CatalogCategory> parseCatalog(Map<String, dynamic> j) => _list(j['categories'])
    .map((c) => CatalogCategory(
          id: _s(c, 'id'),
          name: _s(c, 'name'),
          services: _list(c['services'])
              .map((s) => CatalogService(
                    id: _s(s, 'id'),
                    name: _s(s, 'name'),
                    description: _sn(s, 'description'),
                    durationMinutes: _i(s, 'durationMinutes'),
                    pricingMode: _s(s, 'pricingMode', 'FIXED'),
                    priceFrom: _sn(s, 'priceFrom'),
                    priceTo: _sn(s, 'priceTo'),
                    staff: _list(s['staff']).where((x) => x['price'] is String).map((x) => StaffPrice(id: _s(x, 'id'), name: _s(x, 'name'), price: _s(x, 'price'))).toList(),
                  ))
              .toList(),
        ))
    .toList();

class StaffAvailability {
  const StaffAvailability({required this.staffId, required this.name, required this.totalPrice, required this.slots});
  final String staffId;
  final String name;
  final String totalPrice;

  /// "HH:MM" start times.
  final List<String> slots;
}

class AvailabilityResult {
  const AvailabilityResult({required this.date, required this.durationMinutes, required this.staff});
  final String date;
  final int durationMinutes;

  /// Sorted by price, lowest first.
  final List<StaffAvailability> staff;

  factory AvailabilityResult.fromJson(Map<String, dynamic> j) => AvailabilityResult(
        date: _s(j, 'date'),
        durationMinutes: _i(j, 'durationMinutes'),
        staff: _list(j['staff'])
            .map((s) => StaffAvailability(
                  staffId: _s(s, 'staffId'),
                  name: _s(s, 'name'),
                  totalPrice: _s(s, 'totalPrice', '0'),
                  slots: s['slots'] is List ? (s['slots'] as List).whereType<String>().toList() : <String>[],
                ))
            .toList(),
      );
}
