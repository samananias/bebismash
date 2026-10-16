import type { OwnedChunk } from '../core/types';

export interface ArchiveSinkResult {
  kind: 'blob' | 'disk';
  name: string;
  bytes: number;
  url?: string | undefined;
}

export interface IArchiveSink {
  open(filename: string, mime?: string): Promise<void>;
  write(chunk: OwnedChunk): Promise<void>;
  close(): Promise<ArchiveSinkResult>;
  abort(): Promise<void>;
}

/**
 * Memory-backed Blob sink with strict memory cap.
 * Follows Section 1.2 and Section 3.1 of Master Engineering Blueprint.
 */
export class BlobArchiveSink implements IArchiveSink {
  private chunks: ArrayBuffer[] = [];
  private totalBytes = 0;
  private filename = 'BebiSmash_archive.zip';
  private mime = 'application/zip';
  private objectUrl: string | null = null;
  private revokeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private maxBytes: number) {}

  async open(filename: string, mime = 'application/zip'): Promise<void> {
    this.filename = filename;
    this.mime = mime;
    this.chunks = [];
    this.totalBytes = 0;
    this.cleanupUrl();
  }

  async write(chunk: OwnedChunk): Promise<void> {
    if (this.totalBytes + chunk.byteLength > this.maxBytes) {
      throw new Error(`Blob limit exceeded: archive exceeds cap of ${this.maxBytes} bytes`);
    }
    this.chunks.push(chunk.buffer);
    this.totalBytes += chunk.byteLength;
  }

  async close(): Promise<ArchiveSinkResult> {
    const blob = new Blob(this.chunks, { type: this.mime });
    this.chunks = []; // release array references
    this.objectUrl = URL.createObjectURL(blob);

    // Schedule URL revocation after 60 seconds grace period
    this.revokeTimer = setTimeout(() => {
      this.cleanupUrl();
    }, 60_000);

    return {
      kind: 'blob',
      name: this.filename,
      bytes: this.totalBytes,
      url: this.objectUrl,
    };
  }

  async abort(): Promise<void> {
    this.chunks = [];
    this.totalBytes = 0;
    this.cleanupUrl();
  }

  private cleanupUrl(): void {
    if (this.revokeTimer) {
      clearTimeout(this.revokeTimer);
      this.revokeTimer = null;
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }
}

/**
 * Direct-to-disk streaming sink using File System Access API.
 */
export class FileSystemArchiveSink implements IArchiveSink {
  private writable: FileSystemWritableFileStream | null = null;
  private totalBytes = 0;
  private filename = 'BebiSmash_archive.zip';

  constructor(private handle: FileSystemFileHandle) {}

  async open(filename: string): Promise<void> {
    this.filename = filename;
    this.totalBytes = 0;
    this.writable = await this.handle.createWritable();
  }

  async write(chunk: OwnedChunk): Promise<void> {
    if (!this.writable) {
      throw new Error('FileSystem sink is not open');
    }
    await this.writable.write(chunk.buffer);
    this.totalBytes += chunk.byteLength;
  }

  async close(): Promise<ArchiveSinkResult> {
    if (this.writable) {
      await this.writable.close();
      this.writable = null;
    }
    return {
      kind: 'disk',
      name: this.filename,
      bytes: this.totalBytes,
    };
  }

  async abort(): Promise<void> {
    if (this.writable) {
      try {
        await this.writable.abort();
      } catch {
        // ignore abort errors on closed stream
      }
      this.writable = null;
    }
  }
}
