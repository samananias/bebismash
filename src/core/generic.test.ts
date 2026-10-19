import { describe, it, expect } from 'vitest';
import { Zip, ZipPassThrough, ZipDeflate, unzipSync } from 'fflate';

describe('M1 Generic Slice Independent Unzip Validation', () => {
  it('compresses and bundles generic files into valid ZIP matching original bytes', async () => {
    const file1Name = 'sample_document.txt';
    const file1Content = new TextEncoder().encode(
      'BebiSmash zero-upload in-browser compression test content. '.repeat(50)
    );

    const file2Name = 'binary_data.bin';
    const file2Content = new Uint8Array(2048);
    for (let i = 0; i < file2Content.length; i++) {
      file2Content[i] = (i * 31) & 0xff;
    }

    const archiveChunks: Uint8Array[] = [];

    // Bundle files using fflate.Zip as in zip.worker.ts
    await new Promise<void>((resolve, reject) => {
      const zip = new Zip((err, chunk, final) => {
        if (err) {
          reject(err);
          return;
        }
        archiveChunks.push(chunk);
        if (final) {
          resolve();
        }
      });

      // Entry 1: Deflate
      const entry1 = new ZipDeflate(file1Name, { level: 6 });
      zip.add(entry1);
      entry1.push(file1Content, true);

      // Entry 2: PassThrough (store)
      const entry2 = new ZipPassThrough(file2Name);
      zip.add(entry2);
      entry2.push(file2Content, true);

      zip.end();
    });

    // Concatenate ZIP archive bytes
    const totalLength = archiveChunks.reduce((acc, c) => acc + c.length, 0);
    const archiveBuffer = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of archiveChunks) {
      archiveBuffer.set(chunk, offset);
      offset += chunk.length;
    }

    // Independent unzipping and byte-for-byte validation
    const unzipped = unzipSync(archiveBuffer);

    expect(unzipped[file1Name]).toBeDefined();
    expect(unzipped[file2Name]).toBeDefined();

    // Verify file 1 content byte-for-byte
    expect(unzipped[file1Name]!.length).toBe(file1Content.length);
    for (let i = 0; i < file1Content.length; i++) {
      expect(unzipped[file1Name]![i]).toBe(file1Content[i]);
    }

    // Verify file 2 content byte-for-byte
    expect(unzipped[file2Name]!.length).toBe(file2Content.length);
    for (let i = 0; i < file2Content.length; i++) {
      expect(unzipped[file2Name]![i]).toBe(file2Content[i]);
    }
  });

  it('handles empty files without corrupting archive structure', async () => {
    const emptyFileName = 'empty.txt';
    const emptyContent = new Uint8Array(0);
    const archiveChunks: Uint8Array[] = [];

    await new Promise<void>((resolve, reject) => {
      const zip = new Zip((err, chunk, final) => {
        if (err) return reject(err);
        archiveChunks.push(chunk);
        if (final) resolve();
      });

      const entry = new ZipPassThrough(emptyFileName);
      zip.add(entry);
      entry.push(emptyContent, true);
      zip.end();
    });

    const totalLength = archiveChunks.reduce((acc, c) => acc + c.length, 0);
    const archiveBuffer = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of archiveChunks) {
      archiveBuffer.set(chunk, offset);
      offset += chunk.length;
    }

    const unzipped = unzipSync(archiveBuffer);
    expect(unzipped[emptyFileName]).toBeDefined();
    expect(unzipped[emptyFileName]!.length).toBe(0);
  });
});
