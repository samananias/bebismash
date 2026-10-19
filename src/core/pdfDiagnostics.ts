import type { DocumentPolicy, PdfDiagnostics } from './types';

/** Explicit bounded shape; worker diagnostics never become a free-form content channel. */
export function validPdfDiagnostics(value: unknown): value is PdfDiagnostics {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    if (JSON.stringify(value).length > 4096) return false;
  } catch {
    return false;
  }
  const data = value as Record<string, unknown>;
  const numbers = [
    'pages',
    'objects',
    'streams',
    'compressedStreams',
    'images',
    'imageBytes',
    'metadataBytes',
    'fontBytes',
    'otherStreamBytes',
    'jpegImages',
    'flateImages',
    'monochromeImages',
    'otherImages',
    'rgbImages',
    'grayImages',
    'cmykImages',
    'otherColorImages',
    'largestImageWidth',
    'largestImageHeight',
    'imagesAttempted',
    'imagesOptimized',
    'imagesDownsampled',
    'imageBytesSaved',
    'streamsRecompressed',
    'streamBytesSaved',
    'objectsRemoved',
    'nullReferencesNormalized',
    'metadataRemoved',
    'metadataPreserved',
    'placementUnknown',
    'streamSkips',
  ];
  const allowed = new Set([
    'version',
    ...numbers,
    'targetDpi',
    'jpegQuality',
    'metadata',
    'imageSkips',
    'validation',
    'failure',
  ]);
  if (
    Object.keys(data).length !== allowed.size ||
    Object.keys(data).some((key) => !allowed.has(key))
  )
    return false;
  if (
    data.version !== 1 ||
    numbers.some(
      (key) =>
        !Number.isSafeInteger(data[key]) ||
        (data[key] as number) < 0 ||
        (data[key] as number) > Number.MAX_SAFE_INTEGER
    )
  )
    return false;
  if (
    ![null, 150, 96].includes(data.targetDpi as number | null) ||
    !(
      data.jpegQuality === null ||
      (Number.isInteger(data.jpegQuality) &&
        (data.jpegQuality as number) >= 1 &&
        (data.jpegQuality as number) <= 100)
    )
  )
    return false;
  if (
    !['preserved', 'removed', 'partial', 'skipped'].includes(data.metadata as string) ||
    !['not-run', 'passed', 'failed'].includes(data.validation as string) ||
    ![
      'none',
      'parse',
      'graph',
      'conformance',
      'conformance-unknown',
      'serialize',
      'validation',
      'deadline',
    ].includes(data.failure as string)
  )
    return false;
  if (!data.imageSkips || typeof data.imageSkips !== 'object' || Array.isArray(data.imageSkips))
    return false;
  return Object.entries(data.imageSkips).every(
    ([key, count]) =>
      [
        'gentle',
        'filter',
        'color',
        'mask',
        'features',
        'memory',
        'jpeg_profile',
        'codec',
        'not_smaller',
      ].includes(key) &&
      Number.isSafeInteger(count) &&
      count >= 0 &&
      count <= 100_000
  );
}

export function createPdfReport(policy: DocumentPolicy): PdfDiagnostics {
  return {
    version: 1,
    pages: 0,
    objects: 0,
    streams: 0,
    compressedStreams: 0,
    images: 0,
    imageBytes: 0,
    metadataBytes: 0,
    fontBytes: 0,
    otherStreamBytes: 0,
    jpegImages: 0,
    flateImages: 0,
    monochromeImages: 0,
    otherImages: 0,
    rgbImages: 0,
    grayImages: 0,
    cmykImages: 0,
    otherColorImages: 0,
    largestImageWidth: 0,
    largestImageHeight: 0,
    targetDpi: policy.targetDpi,
    jpegQuality: policy.pdfMode === 'image-adapter' ? policy.image.quality : null,
    imagesAttempted: 0,
    imagesOptimized: 0,
    imagesDownsampled: 0,
    imageBytesSaved: 0,
    streamsRecompressed: 0,
    streamBytesSaved: 0,
    objectsRemoved: 0,
    nullReferencesNormalized: 0,
    metadataRemoved: 0,
    metadataPreserved: 0,
    metadata: 'preserved',
    imageSkips: {},
    placementUnknown: 0,
    streamSkips: 0,
    validation: 'not-run',
    failure: 'none',
  };
}
