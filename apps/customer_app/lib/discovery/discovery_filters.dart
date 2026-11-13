const Object _unset = Object();

/// Everything the customer can narrow a search by. Coordinates are rounded to 3 decimals (about 110 m) before sending.
/// Immutable; [toQuery] builds exactly the query string the API
/// validates (see apps/api discovery DTO). Location is OPTIONAL and only ever sent with the request, never stored.
class DiscoveryFilters {
  const DiscoveryFilters({
    this.query,
    this.city,
    this.area,
    this.type,
    this.service,
    this.staff,
    this.minPrice,
    this.maxPrice,
    this.date,
    this.time,
    this.lat,
    this.lng,
    this.radiusKm,
    this.sort,
  });

  final String? query;
  final String? city;
  final String? area;

  /// MEN, LADIES or UNISEX.
  final String? type;
  final String? service;
  final String? staff;
  final double? minPrice;
  final double? maxPrice;

  /// YYYY-MM-DD and HH:MM.
  final String? date;
  final String? time;
  final double? lat;
  final double? lng;
  final double? radiusKm;

  /// One of the sorts the server offers; null = server default (nearest with a location, otherwise by name).
  final String? sort;

  bool get hasLocation => lat != null && lng != null;

  /// Filters beyond city and the search text, for the badge on the filter button.
  int get activeFilterCount => [type, service, staff, minPrice, maxPrice, date, sort].where((v) => v != null).length + (area != null ? 1 : 0);

  DiscoveryFilters copyWith({
    Object? query = _unset,
    Object? city = _unset,
    Object? area = _unset,
    Object? type = _unset,
    Object? service = _unset,
    Object? staff = _unset,
    Object? minPrice = _unset,
    Object? maxPrice = _unset,
    Object? date = _unset,
    Object? time = _unset,
    Object? lat = _unset,
    Object? lng = _unset,
    Object? radiusKm = _unset,
    Object? sort = _unset,
  }) {
    return DiscoveryFilters(
      query: identical(query, _unset) ? this.query : query as String?,
      city: identical(city, _unset) ? this.city : city as String?,
      area: identical(area, _unset) ? this.area : area as String?,
      type: identical(type, _unset) ? this.type : type as String?,
      service: identical(service, _unset) ? this.service : service as String?,
      staff: identical(staff, _unset) ? this.staff : staff as String?,
      minPrice: identical(minPrice, _unset) ? this.minPrice : minPrice as double?,
      maxPrice: identical(maxPrice, _unset) ? this.maxPrice : maxPrice as double?,
      date: identical(date, _unset) ? this.date : date as String?,
      time: identical(time, _unset) ? this.time : time as String?,
      lat: identical(lat, _unset) ? this.lat : lat as double?,
      lng: identical(lng, _unset) ? this.lng : lng as double?,
      radiusKm: identical(radiusKm, _unset) ? this.radiusKm : radiusKm as double?,
      sort: identical(sort, _unset) ? this.sort : sort as String?,
    );
  }

  /// Query parameters for GET /public/discovery/salons. Empty values are omitted; rules the server enforces
  /// (coordinates together, radius and distance sort need a location, time needs a date) are applied here too so the
  /// app never sends a request it knows will be rejected.
  Map<String, String> toQuery({int page = 1, int pageSize = 20}) {
    String? clean(String? v) => (v == null || v.trim().isEmpty) ? null : v.trim();
    String num(double v) => v == v.truncateToDouble() ? v.toStringAsFixed(0) : v.toString();
    final located = hasLocation;
    final out = <String, String>{
      if (clean(query) != null) 'q': clean(query)!,
      if (clean(city) != null) 'city': clean(city)!,
      if (clean(area) != null) 'area': clean(area)!,
      if (type != null) 'type': type!,
      if (clean(service) != null) 'service': clean(service)!,
      if (clean(staff) != null) 'staff': clean(staff)!,
      if (minPrice != null) 'minPrice': num(minPrice!),
      if (maxPrice != null) 'maxPrice': num(maxPrice!),
      if (date != null) 'date': date!,
      if (date != null && time != null) 'time': time!,
      if (located) 'lat': lat!.toStringAsFixed(3),
      if (located) 'lng': lng!.toStringAsFixed(3),
      if (located && radiusKm != null) 'radiusKm': num(radiusKm!),
      if (sort != null && (sort != 'nearest' || located)) 'sort': sort!,
      'page': '$page',
      'pageSize': '$pageSize',
    };
    return out;
  }
}
