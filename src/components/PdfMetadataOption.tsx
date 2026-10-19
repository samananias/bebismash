import { useSmashStore } from '../store/useSmashStore';

/** Settings only; the worker owns all inspection and document bytes. */
export function PdfMetadataOption({ editable }: { editable: boolean }) {
  const pdfMetadata = useSmashStore((state) => state.pdfMetadata);
  const setPdfMetadata = useSmashStore((state) => state.setPdfMetadata);
  return (
    <div className="pdf-cleanup">
      <label>
        <input
          type="checkbox"
          checked={pdfMetadata === 'remove-xmp'}
          disabled={!editable}
          aria-describedby="pdf-cleanup-help"
          onChange={(event) => setPdfMetadata(event.target.checked ? 'remove-xmp' : 'preserve')}
        />
        Remove embedded PDF metadata
      </label>
      <p id="pdf-cleanup-help">
        Applies to all supported PDFs in this batch. Removes XMP provenance, editing history and
        rights information while retaining page content. This is not a complete privacy sanitizer.
        Protected and conformance-sensitive PDFs stay unchanged.
      </p>
    </div>
  );
}
