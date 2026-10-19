import type { PdfDiagnostics } from '../core/types';
import { formatBytes } from '../core/formatBytes';

const skipLabels: Record<keyof PdfDiagnostics['imageSkips'], string> = {
  gentle: 'Gentle preserves image samples',
  filter: 'unsupported image filter',
  color: 'CMYK/ICC or unsupported color space',
  mask: 'image mask or transparency',
  features: 'unsupported image features or bit depth',
  memory: 'image working-memory or pixel cap',
  jpeg_profile: 'JPEG profile/header requires unsupported handling',
  codec: 'image codec failed',
  not_smaller: 'encoded image was not smaller',
};

/** Numeric candidate diagnostics only; no file contents or extracted properties. */
export function PdfProcessingDetails({ report }: { report: PdfDiagnostics }) {
  return (
    <>
      <dt>PDF profile</dt>
      <dd>
        {report.targetDpi
          ? `${report.targetDpi} DPI / JPEG Q${report.jpegQuality}`
          : 'Gentle: lossless stream and object compression; images retained'}
      </dd>
      <dt>PDF inventory</dt>
      <dd>
        {report.pages} pages · {report.objects} objects · {report.streams} streams (
        {report.compressedStreams} already filtered)
      </dd>
      <dt>Stored stream bytes</dt>
      <dd>
        Images {formatBytes(report.imageBytes)} · metadata {formatBytes(report.metadataBytes)} ·
        fonts {formatBytes(report.fontBytes)} · other {formatBytes(report.otherStreamBytes)}
      </dd>
      <dt>Image inventory</dt>
      <dd>
        {report.images} images: {report.jpegImages} JPEG, {report.flateImages} Flate,{' '}
        {report.monochromeImages} monochrome, {report.otherImages} other. RGB {report.rgbImages},
        gray {report.grayImages}, CMYK {report.cmykImages}, other color {report.otherColorImages}.
        Largest {report.largestImageWidth} × {report.largestImageHeight} px.
      </dd>
      <dt>Candidate image operations</dt>
      <dd>
        {report.imagesAttempted} attempted · {report.imagesOptimized} smaller images ·{' '}
        {report.imagesDownsampled} downsampled · {formatBytes(report.imageBytesSaved)} saved.{' '}
        {report.placementUnknown > 0 &&
          `${report.placementUnknown} images used quality-only encoding because complete placement was uncertain.`}
      </dd>
      <dt>Image operations skipped</dt>
      <dd>
        {Object.entries(report.imageSkips)
          .filter(([, count]) => count > 0)
          .map(([reason, count]) => `${count}: ${skipLabels[reason as keyof typeof skipLabels]}`)
          .join('; ') || 'None'}
      </dd>
      <dt>Candidate lossless operations</dt>
      <dd>
        {report.streamsRecompressed} streams recompressed ({formatBytes(report.streamBytesSaved)}{' '}
        saved) · {report.objectsRemoved} unreachable objects removed ·{' '}
        {report.nullReferencesNormalized} null references normalized. {report.streamSkips} streams
        retained because their filter or expansion exceeded supported limits.
      </dd>
      <dt>PDF metadata</dt>
      <dd>
        {report.metadata} · {report.metadataRemoved} supported associations removed ·{' '}
        {report.metadataPreserved} unsupported associations retained
      </dd>
      <dt>PDF validation</dt>
      <dd>
        {report.failure === 'conformance-unknown'
          ? 'Document conformance metadata could not be inspected; the original was retained'
          : report.validation}
        {report.failure !== 'none' && report.failure !== 'conformance-unknown'
          ? ` · stopped during ${report.failure}`
          : ''}
        . Candidate changes are delivered only when validation passes and the final PDF is smaller.
        Fonts, text, vectors, forms and annotations are retained; font subsetting, image
        deduplication and monochrome transcoding are not implemented.
      </dd>
    </>
  );
}
