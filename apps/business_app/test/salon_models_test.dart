import 'package:flutter_test/flutter_test.dart';
import 'package:salon_business/salon/salon_models.dart';

void main() {
  final json = {
    'salon': {
      'id': 's1', 'name': 'Glow', 'salonType': 'LADIES', 'city': 'Lahore', 'area': 'Gulberg',
      'addressLine': '12 Main', 'phone': '+923001234567', 'status': 'REJECTED',
      'rejectionReason': 'Blurry CNIC', 'suspendedReason': null,
    },
    'files': [
      {'id': 'f1', 'kind': 'DOCUMENT', 'docType': 'CNIC_FRONT', 'sizeBytes': 1000},
      {'id': 'f2', 'kind': 'PHOTO', 'docType': 'COVER', 'sizeBytes': 2000},
    ],
    'requirements': {
      'requiredDocuments': ['CNIC_FRONT', 'CNIC_BACK'],
      'minPhotos': 1,
      'missing': {'documents': ['CNIC_BACK'], 'photos': 0},
    },
    'canEdit': true,
    'canSubmit': false,
  };

  test('parses the owner overview and exposes what is missing', () {
    final o = SalonOverview.fromJson(json);
    expect(o.salon.status, 'REJECTED');
    expect(o.salon.rejectionReason, 'Blurry CNIC');
    expect(o.fileOf('CNIC_FRONT')?.id, 'f1');
    expect(o.fileOf('CNIC_BACK'), isNull);
    expect(o.photoCount, 1);
    expect(o.missingDocuments, ['CNIC_BACK']);
    expect(o.canSubmit, isFalse);
  });
}
