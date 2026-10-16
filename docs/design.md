# Monoterm interface

The user selected Crisp Monoterm from the three pixel-lab variants on 2026-10-16. It is now the main application interface; the exploratory pages and picker have been removed.

Use a cream paper workspace (`#E8ECD7`), charcoal ink (`#1E2328`), cobalt actions (`#214DCC`), and pale sage separators and summaries. Silkscreen is the display face; Space Mono carries filenames, sizes and body text. Fonts are self-hosted in `public/fonts`; the adjacent manifest records original URLs, SHA-256 hashes and OFL licenses.

Keep the wide dropzone, inline preset controls, compact file rows and modest static pixel artwork. Buttons use hard offset shadows and 120 ms transform feedback, with reduced-motion support. File contents are not decoded for decorative thumbnails. Filenames truncate visually while remaining available to assistive technology and the title tooltip.

The queue starts empty. All output sizes come from scheduler results; batch savings include ZIP overhead. Batch processing is indeterminate because the existing scheduler does not expose progress with stable store IDs. Do not substitute illustrative percentages. Failed/cancelled batches retain original files for retry; start a new batch after success to release the prior archive URL and file registry.

Processing remains local and telemetry remains optional and off by default. The privacy dialog uses native modal behavior for focus containment and restoration. Test the built entry through `playwright.config.ts`, including a real ZIP round trip and no-upload network assertions.
