const mimeByExtension: Record<string, string> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  pdf: 'application/pdf',
  zip: 'application/zip',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
/** Current engines retain the source format. Do not trust arbitrary File.type in picker filters. */
export function saveOptions(filename: string) {
  let name = filename
    .normalize('NFC')
    .replace(/^.*[\\/]/, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069:]/g, '_');
  const extension = name.match(/\.([a-z0-9]{1,16})$/i)?.[1]?.toLowerCase() ?? 'bin';
  if (!/\.[a-z0-9]{1,16}$/i.test(name)) name = `${name || 'file'}.bin`;
  // Keep the proposed filename bounded while retaining its extension.
  const suffix = name.slice(name.lastIndexOf('.'));
  let stem = name.slice(0, -suffix.length);
  while (new TextEncoder().encode(stem + suffix).length > 220)
    stem = Array.from(stem).slice(0, -1).join('');
  name = stem + suffix;
  return {
    suggestedName: name,
    types: [
      {
        description: `${extension.toUpperCase()} file`,
        accept: { [mimeByExtension[extension] ?? 'application/octet-stream']: [`.${extension}`] },
      },
    ],
  };
}
