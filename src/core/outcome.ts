import type { PreservationReason } from './types';

const messages: Record<PreservationReason, string> = {
  conformance_document: 'Archival or print-conformance constraints require preserving this PDF.',
  memory_limit: 'Compression exceeds this device’s safe memory budget.',
  unsupported_content: 'Compression is not supported for this content.',
  unsupported_codec: 'The browser cannot encode this media configuration.',
  no_smaller_candidate: 'No smaller output was produced with these settings.',
  validation_failed: 'The candidate failed validation; the original was retained.',
  cleanup_unsupported:
    'Embedded metadata cleanup is unsupported for this PDF; the original was retained.',
  protected_document: 'Signed or encrypted documents are preserved unchanged.',
};
export function preservationMessage(reason?: PreservationReason): string {
  return reason ? messages[reason] : 'The original was retained unchanged.';
}
