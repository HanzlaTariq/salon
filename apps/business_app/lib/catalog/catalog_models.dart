/// Mirrors GET /salons/mine/catalog and /salons/mine/opening-hours (apps/api, Phase 4).
/// Money is always a decimal STRING ("300.00") on the wire; it is never parsed into a double for storage.
class StaffMember {
  const StaffMember({required this.id, required this.displayName, required this.isOwner, required this.isActive});

  factory StaffMember.fromJson(Map<String, dynamic> j) => StaffMember(
        id: j['id'] as String,
        displayName: j['displayName'] as String,
        isOwner: j['isOwner'] as bool? ?? false,
        isActive: j['isActive'] as bool? ?? true,
      );

  final String id;
  final String displayName;
  final bool isOwner;
  final bool isActive;
}

class Assignment {
  const Assignment({required this.staffId, this.price});

  factory Assignment.fromJson(Map<String, dynamic> j) => Assignment(staffId: j['staffId'] as String, price: j['price'] as String?);

  final String staffId;
  final String? price;
}

class CatalogService {
  const CatalogService({
    required this.id,
    required this.categoryId,
    required this.name,
    required this.durationMinutes,
    required this.pricingMode,
    required this.isActive,
    required this.staff,
    this.description,
    this.price,
  });

  factory CatalogService.fromJson(Map<String, dynamic> j) => CatalogService(
        id: j['id'] as String,
        categoryId: j['categoryId'] as String,
        name: j['name'] as String,
        description: j['description'] as String?,
        durationMinutes: (j['durationMinutes'] as num).toInt(),
        pricingMode: j['pricingMode'] as String,
        price: j['price'] as String?,
        isActive: j['isActive'] as bool? ?? true,
        staff: (j['staff'] as List<dynamic>? ?? const []).map((e) => Assignment.fromJson(e as Map<String, dynamic>)).toList(),
      );

  final String id;
  final String categoryId;
  final String name;
  final String? description;
  final int durationMinutes;
  final String pricingMode; // FIXED | STAFF_BASED
  final String? price; // FIXED only
  final bool isActive;
  final List<Assignment> staff;

  bool get isStaffBased => pricingMode == 'STAFF_BASED';

  /// "Rs 300", "Rs 300 - 500" or "No staff assigned".
  String priceLabel() {
    final values = isStaffBased ? staff.map((a) => a.price).whereType<String>().toList() : [if (price != null) price!];
    if (values.isEmpty) return 'No price yet';
    final nums = values.map(double.parse).toList()..sort();
    String fmt(double v) => v == v.roundToDouble() ? v.toStringAsFixed(0) : v.toStringAsFixed(2);
    return nums.first == nums.last ? 'Rs ${fmt(nums.first)}' : 'Rs ${fmt(nums.first)} - ${fmt(nums.last)}';
  }
}

class CatalogCategory {
  const CatalogCategory({required this.id, required this.name, required this.isActive, required this.services, this.description});

  factory CatalogCategory.fromJson(Map<String, dynamic> j) => CatalogCategory(
        id: j['id'] as String,
        name: j['name'] as String,
        description: j['description'] as String?,
        isActive: j['isActive'] as bool? ?? true,
        services: (j['services'] as List<dynamic>? ?? const []).map((e) => CatalogService.fromJson(e as Map<String, dynamic>)).toList(),
      );

  final String id;
  final String name;
  final String? description;
  final bool isActive;
  final List<CatalogService> services;
}

class CatalogOverview {
  const CatalogOverview({required this.canEdit, required this.categories, required this.staff});

  factory CatalogOverview.fromJson(Map<String, dynamic> j) => CatalogOverview(
        canEdit: j['canEdit'] as bool? ?? false,
        categories: (j['categories'] as List<dynamic>).map((e) => CatalogCategory.fromJson(e as Map<String, dynamic>)).toList(),
        staff: (j['staff'] as List<dynamic>).map((e) => StaffMember.fromJson(e as Map<String, dynamic>)).toList(),
      );

  final bool canEdit;
  final List<CatalogCategory> categories;
  final List<StaffMember> staff;

  StaffMember? staffById(String id) {
    for (final s in staff) {
      if (s.id == id) return s;
    }
    return null;
  }
}

/// One weekday of the opening hours. weekday: 1 = Monday ... 7 = Sunday. Times are "HH:MM".
class OpeningDay {
  const OpeningDay({required this.weekday, required this.closed, this.opensAt, this.closesAt});

  factory OpeningDay.fromJson(Map<String, dynamic> j) => OpeningDay(
        weekday: (j['weekday'] as num).toInt(),
        closed: j['closed'] as bool? ?? true,
        opensAt: j['opensAt'] as String?,
        closesAt: j['closesAt'] as String?,
      );

  final int weekday;
  final bool closed;
  final String? opensAt;
  final String? closesAt;

  Map<String, dynamic> toJson() => {
        'weekday': weekday,
        'closed': closed,
        if (!closed) 'opensAt': opensAt,
        if (!closed) 'closesAt': closesAt,
      };

  OpeningDay copyWith({bool? closed, String? opensAt, String? closesAt}) => OpeningDay(
        weekday: weekday,
        closed: closed ?? this.closed,
        opensAt: opensAt ?? this.opensAt,
        closesAt: closesAt ?? this.closesAt,
      );
}

const weekdayNames = <int, String>{1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday', 6: 'Saturday', 7: 'Sunday'};

/// Parses a price typed by the owner ("300", "299.5"). Returns null when invalid (max two decimals, 0 .. 1,000,000).
num? parsePrice(String input) {
  final t = input.trim();
  if (!RegExp(r'^\d{1,7}(\.\d{1,2})?$').hasMatch(t)) return null;
  final v = num.parse(t);
  return v <= 1000000 ? v : null;
}
