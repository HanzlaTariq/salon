/// Mirrors GET /salons/mine (apps/api, Phase 3). Parsing is defensive: unknown values never crash the UI.
class SalonProfile {
  const SalonProfile({
    required this.id,
    required this.name,
    required this.salonType,
    required this.city,
    required this.area,
    required this.addressLine,
    required this.phone,
    required this.status,
    this.contactEmail,
    this.description,
    this.rejectionReason,
    this.suspendedReason,
  });

  factory SalonProfile.fromJson(Map<String, dynamic> j) => SalonProfile(
        id: j['id'] as String,
        name: j['name'] as String,
        salonType: j['salonType'] as String,
        city: j['city'] as String,
        area: j['area'] as String,
        addressLine: j['addressLine'] as String,
        phone: j['phone'] as String,
        status: j['status'] as String,
        contactEmail: j['contactEmail'] as String?,
        description: j['description'] as String?,
        rejectionReason: j['rejectionReason'] as String?,
        suspendedReason: j['suspendedReason'] as String?,
      );

  final String id;
  final String name;
  final String salonType; // MEN | LADIES | UNISEX
  final String city;
  final String area;
  final String addressLine;
  final String phone;
  final String status; // DRAFT | PENDING | APPROVED | REJECTED | SUSPENDED
  final String? contactEmail;
  final String? description;
  final String? rejectionReason;
  final String? suspendedReason;
}

class SalonFile {
  const SalonFile({required this.id, required this.kind, required this.docType, required this.sizeBytes});

  factory SalonFile.fromJson(Map<String, dynamic> j) => SalonFile(
        id: j['id'] as String,
        kind: j['kind'] as String,
        docType: j['docType'] as String,
        sizeBytes: (j['sizeBytes'] as num?)?.toInt() ?? 0,
      );

  final String id;
  final String kind; // DOCUMENT | PHOTO
  final String docType;
  final int sizeBytes;
}

class SalonOverview {
  const SalonOverview({
    required this.salon,
    required this.files,
    required this.requiredDocuments,
    required this.minPhotos,
    required this.missingDocuments,
    required this.missingPhotos,
    required this.canEdit,
    required this.canEditProfile,
    required this.canSubmit,
  });

  factory SalonOverview.fromJson(Map<String, dynamic> j) {
    final req = j['requirements'] as Map<String, dynamic>;
    final missing = req['missing'] as Map<String, dynamic>;
    return SalonOverview(
      salon: SalonProfile.fromJson(j['salon'] as Map<String, dynamic>),
      files: (j['files'] as List<dynamic>).map((e) => SalonFile.fromJson(e as Map<String, dynamic>)).toList(),
      requiredDocuments: (req['requiredDocuments'] as List<dynamic>).whereType<String>().toList(),
      minPhotos: (req['minPhotos'] as num).toInt(),
      missingDocuments: (missing['documents'] as List<dynamic>).whereType<String>().toList(),
      missingPhotos: (missing['photos'] as num).toInt(),
      canEdit: j['canEdit'] as bool? ?? false,
      // Phase 4: a live (approved) salon can still edit its profile, photos, services and hours.
      canEditProfile: j['canEditProfile'] as bool? ?? (j['canEdit'] as bool? ?? false),
      canSubmit: j['canSubmit'] as bool? ?? false,
    );
  }

  final SalonProfile salon;
  final List<SalonFile> files;
  final List<String> requiredDocuments;
  final int minPhotos;
  final List<String> missingDocuments;
  final int missingPhotos;
  final bool canEdit;
  final bool canEditProfile;
  final bool canSubmit;

  SalonFile? fileOf(String docType) {
    for (final f in files) {
      if (f.docType == docType) return f;
    }
    return null;
  }

  int get photoCount => files.where((f) => f.kind == 'PHOTO').length;
}

const documentLabels = <String, String>{
  'CNIC_FRONT': 'CNIC (front)',
  'CNIC_BACK': 'CNIC (back)',
  'BUSINESS_LICENSE': 'Business licence',
  'OTHER_DOCUMENT': 'Other document',
};
