import { DEFAULT_REQUIREMENTS, computeMissing, isComplete, parseRequirements } from './salon.types';

describe('salon application requirements', () => {
  it('reports exactly what is missing', () => {
    const req = { requiredDocuments: ['CNIC_FRONT', 'CNIC_BACK', 'BUSINESS_LICENSE'] as const, minPhotos: 2 };
    const m = computeMissing({ requiredDocuments: [...req.requiredDocuments], minPhotos: req.minPhotos }, [
      { kind: 'DOCUMENT', docType: 'CNIC_FRONT' },
      { kind: 'PHOTO', docType: 'COVER' },
    ]);
    expect(m).toEqual({ documents: ['CNIC_BACK', 'BUSINESS_LICENSE'], photos: 1 });
    expect(isComplete(m)).toBe(false);
  });

  it('is complete when everything required is present (extra files do not matter)', () => {
    const m = computeMissing(DEFAULT_REQUIREMENTS, [
      { kind: 'DOCUMENT', docType: 'CNIC_FRONT' },
      { kind: 'DOCUMENT', docType: 'CNIC_BACK' },
      { kind: 'DOCUMENT', docType: 'OTHER_DOCUMENT' },
      { kind: 'PHOTO', docType: 'GALLERY' },
      { kind: 'PHOTO', docType: 'COVER' },
    ]);
    expect(isComplete(m)).toBe(true);
  });

  it('a photo does not satisfy a document requirement and vice versa', () => {
    const m = computeMissing(DEFAULT_REQUIREMENTS, [{ kind: 'PHOTO', docType: 'COVER' }]);
    expect(m.documents).toEqual(['CNIC_FRONT', 'CNIC_BACK']);
    expect(computeMissing(DEFAULT_REQUIREMENTS, [{ kind: 'DOCUMENT', docType: 'CNIC_FRONT' }]).photos).toBe(1);
  });

  it('parseRequirements accepts valid settings and falls back safely on garbage', () => {
    expect(parseRequirements({ requiredDocuments: ['CNIC_FRONT', 'BUSINESS_LICENSE', 'CNIC_FRONT'], minPhotos: 3 })).toEqual({
      requiredDocuments: ['CNIC_FRONT', 'BUSINESS_LICENSE'],
      minPhotos: 3,
    });
    expect(parseRequirements({ requiredDocuments: ['COVER', 'nope', 42], minPhotos: -1 })).toEqual({ requiredDocuments: [], minPhotos: 1 });
    for (const junk of [null, undefined, 'x', 7, [], { requiredDocuments: 'all' }]) {
      expect(parseRequirements(junk).minPhotos).toBeGreaterThanOrEqual(0);
    }
    expect(parseRequirements(null)).toEqual(DEFAULT_REQUIREMENTS);
  });
});
