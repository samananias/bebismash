"""Independent, local PDF regression checks (requires pypdf, pypdfium2 and Pillow).

Never writes source text, metadata values, names or hashes to its JSON report.
App processing remains in browser workers; this is a developer validation utility.
"""

import argparse
import hashlib
import json
import logging
import math
from pathlib import Path

import pypdf
import pypdfium2 as pdfium
from PIL import ImageChops, ImageStat
from pypdf.generic import ArrayObject, DictionaryObject, IndirectObject, NullObject, StreamObject


logging.getLogger("pypdf").setLevel(logging.ERROR)


def resolve(value):
    return value.get_object() if isinstance(value, IndirectObject) else value


def recognized_metadata(value):
    value = resolve(value)
    return isinstance(value, StreamObject) and value.get("/Type") == "/Metadata" and value.get("/Subtype") == "/XML"


def reachable_streams(reader, allow_metadata_removal):
    stack = [reader.trailer]
    seen = set()
    streams = {}
    steps = 0
    while stack:
        steps += 1
        if steps > 1_000_000:
            raise AssertionError("Independent graph limit")
        value = stack.pop()
        reference = None
        if isinstance(value, IndirectObject):
            reference = (value.idnum, value.generation)
            if reference in seen:
                continue
            seen.add(reference)
            value = value.get_object()
        if value is None or isinstance(value, NullObject):
            continue
        if isinstance(value, StreamObject) and reference:
            streams[reference] = value
        if isinstance(value, DictionaryObject):
            for key, child in value.items():
                if key in ("/Prev", "/XRefStm"):
                    continue
                if key == "/Metadata" and allow_metadata_removal and recognized_metadata(child):
                    continue
                stack.append(child)
        elif isinstance(value, ArrayObject):
            stack.extend(value)
    return streams


def canonical(value):
    if isinstance(value, IndirectObject):
        target = value.get_object()
        return None if target is None or isinstance(target, NullObject) else ("ref", value.idnum, value.generation)
    if value is None or isinstance(value, NullObject):
        return None
    if isinstance(value, (DictionaryObject, dict)):
        return tuple(sorted((str(key), canonical(child)) for key, child in value.items() if key not in ("/Length", "/Filter", "/DecodeParms")))
    if isinstance(value, (ArrayObject, list)):
        return tuple(canonical(item) for item in value)
    return value


def jpeg_packets(data):
    """Preserved APP1/APP13 payloads, compared locally without exposing their values."""
    if not data.startswith(b"\xff\xd8"):
        return []
    output = []
    offset = 2
    while offset + 4 <= len(data):
        marker = data[offset + 1]
        if marker == 0xDA:
            break
        if marker == 0xFF:
            offset += 1
            continue
        length = int.from_bytes(data[offset + 2:offset + 4], "big")
        if length < 2 or offset + length + 2 > len(data):
            break
        if marker in (0xE1, 0xED):
            output.append(hashlib.sha256(data[offset:offset + length + 2]).digest())
        offset += length + 2
    return output


def verify(source_path, candidate_path, allow_image_changes=False, allow_metadata_removal=False, render_pages=(), render_dir=None):
    source = pypdf.PdfReader(source_path)
    candidate = pypdf.PdfReader(candidate_path)
    report = {"source_bytes": Path(source_path).stat().st_size, "output_bytes": Path(candidate_path).stat().st_size}
    assert len(source.pages) == len(candidate.pages), "Page count changed"
    report["pages"] = len(source.pages)
    for old, new in zip(source.pages, candidate.pages):
        for box in ("mediabox", "cropbox"):
            assert tuple(float(item) for item in getattr(old, box)) == tuple(float(item) for item in getattr(new, box)), "Page geometry changed"
        for key, default in (("/Rotate", 0), ("/UserUnit", 1)):
            assert canonical(old.get(key, default)) == canonical(new.get(key, default)), "Page geometry changed"
        old_contents, new_contents = old.get_contents(), new.get_contents()
        assert (old_contents.get_data() if old_contents else b"") == (new_contents.get_data() if new_contents else b""), "Decoded page content changed"
        assert canonical(old.get("/Annots")) == canonical(new.get("/Annots")), "Annotation references changed"
    assert canonical(source.metadata) == canonical(candidate.metadata), "Document Info changed"
    assert canonical(source.get_fields()) == canonical(candidate.get_fields()), "Canonical form fields changed"
    assert set(source.attachments) == set(candidate.attachments), "Attachment names changed"
    for name in source.attachments:
        assert list(source.attachments[name]) == list(candidate.attachments[name]), "Attachment bytes changed"

    before = reachable_streams(source, allow_metadata_removal)
    after = reachable_streams(candidate, False)
    non_images = changed_images = preserved_images = 0
    for reference, stream in before.items():
        assert reference in after, "Retained stream missing"
        output = after[reference]
        if stream.get("/Subtype") == "/Image":
            if stream.get_data() == output.get_data():
                preserved_images += 1
            else:
                assert allow_image_changes, "Unexpected image payload change"
                assert output.get("/Subtype") == "/Image", "Image type changed"
                assert output.get("/ColorSpace") == "/DeviceRGB", "Unexpected output color space"
                assert output.get("/BitsPerComponent") == 8, "Unexpected output bit depth"
                assert int(output["/Width"]) <= int(stream["/Width"]) and int(output["/Height"]) <= int(stream["/Height"]), "Image upscaled"
                assert jpeg_packets(stream.get_data()) == jpeg_packets(output.get_data()), "JPEG metadata packets changed"
                changed_images += 1
        else:
            assert stream.get_data() == output.get_data(), "Retained non-image stream changed"
            non_images += 1
    report.update({"decoded_page_content": "match", "geometry": "match", "fields_annotations_attachments_info": "match", "retained_non_image_streams": non_images, "preserved_images": preserved_images, "changed_images": changed_images})

    old_doc = pdfium.PdfDocument(source_path)
    new_doc = pdfium.PdfDocument(candidate_path)
    try:
        old_doc.init_forms()
        new_doc.init_forms()
        for index in range(len(old_doc)):
            old_page, new_page = old_doc[index], new_doc[index]
            old_text, new_text = old_page.get_textpage(), new_page.get_textpage()
            try:
                assert old_text.get_text_range() == new_text.get_text_range(), "Independent extracted page text changed"
            finally:
                old_text.close()
                new_text.close()
                old_page.close()
                new_page.close()
        report["pdfium_text_pages_matched"] = len(old_doc)
        renders = []
        for number in render_pages:
            old_page, new_page = old_doc[number - 1], new_doc[number - 1]
            old_bitmap = old_page.render(scale=1.25, may_draw_forms=True)
            new_bitmap = new_page.render(scale=1.25, may_draw_forms=True)
            try:
                old_image = old_bitmap.to_pil().convert("RGB")
                new_image = new_bitmap.to_pil().convert("RGB")
                assert old_image.size == new_image.size, "Rendered geometry changed"
                difference = ImageChops.difference(old_image, new_image)
                identical = difference.getbbox() is None
                rms = math.sqrt(sum(value * value for value in ImageStat.Stat(difference).rms) / 3)
                if not allow_image_changes:
                    assert identical, "Lossless rendered sample changed"
                renders.append({"page": number, "pixels_identical": identical, "rms_0_255": round(rms, 4)})
                if render_dir:
                    folder = Path(render_dir)
                    folder.mkdir(parents=True, exist_ok=True)
                    stem = Path(candidate_path).stem
                    old_image.save(folder / f"{stem}-page-{number}-source.png")
                    new_image.save(folder / f"{stem}-page-{number}-output.png")
            finally:
                old_bitmap.close()
                new_bitmap.close()
                old_page.close()
                new_page.close()
        report["render_samples"] = renders
    finally:
        old_doc.close()
        new_doc.close()
        source.close()
        candidate.close()
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--allow-image-changes", action="store_true")
    parser.add_argument("--allow-metadata-removal", action="store_true")
    parser.add_argument("--render-pages", default="")
    parser.add_argument("--render-dir")
    args = parser.parse_args()
    result = verify(args.source, args.candidate, args.allow_image_changes, args.allow_metadata_removal, [int(value) for value in args.render_pages.split(",") if value], args.render_dir)
    print(json.dumps(result))
