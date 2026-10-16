/// <reference lib="webworker" />
import type { ZipCommand, ZipEvent, EntryData, EntryControl } from '../core/types';

const CHUNK = 256 * 1024;
self.onmessage = async ({ data: open }: MessageEvent<ZipCommand>) => {
  if (open?.type !== 'open' || open.version !== 1) return;
  const { Zip, ZipPassThrough, ZipDeflate } = await import('fflate');
  const batchId = open.batchId;
  const send = (event: ZipEvent, transfer: Transferable[] = []) => postMessage(event, transfer);
  const queue: { buffer: ArrayBuffer; final: boolean }[] = [];
  let seq = 0;
  let outstanding: number | null = null;
  let archiveBytes = 0;
  let entries = 0;
  let stopped = false;
  let finalSeen = false;
  let entryPort: MessagePort | null = null;
  let grant: (() => void) | null = null;
  const fail = (messageKey: string) => {
    if (stopped) return;
    stopped = true;
    entryPort?.close();
    queue.length = 0;
    send({
      version: 1,
      batchId,
      type: 'zip-error',
      error: { code: 'PROTOCOL_ERROR', retryable: true, messageKey },
    });
  };
  const flush = () => {
    if (stopped || outstanding !== null) return;
    const item = queue.shift();
    if (item) {
      outstanding = ++seq;
      send(
        {
          version: 1,
          batchId,
          type: 'zip-chunk',
          seq,
          chunk: { buffer: item.buffer, byteLength: item.buffer.byteLength },
          final: item.final,
        },
        [item.buffer]
      );
    } else if (finalSeen) {
      stopped = true;
      send({ version: 1, batchId, type: 'zip-complete', archiveBytes, entries });
    } else {
      const next = grant;
      grant = null;
      next?.();
    }
  };
  const zip = new Zip((error, data, final) => {
    if (error) {
      fail('zip_compression_failed');
      return;
    }
    archiveBytes += data.byteLength;
    if (archiveBytes > open.maxArchiveBytes) {
      fail('archive_output_limit_exceeded');
      return;
    }
    for (let offset = 0; offset < data.length; offset += CHUNK) {
      const buffer = data.slice(offset, offset + CHUNK).buffer;
      queue.push({ buffer, final: final && offset + CHUNK >= data.length });
    }
    if (final) finalSeen = true;
    flush();
  });
  self.onmessage = ({ data: cmd }: MessageEvent<ZipCommand>) => {
    if (stopped || cmd.batchId !== batchId) return;
    if (cmd.version !== 1) {
      fail('invalid_zip_protocol');
      return;
    }
    try {
      if (cmd.type === 'sink-ack') {
        if (cmd.seq !== outstanding) {
          fail('invalid_sink_ack');
          return;
        }
        outstanding = null;
        flush();
      } else if (cmd.type === 'add') {
        if (entryPort || entries >= open.expectedEntries) {
          fail('unexpected_entry');
          return;
        }
        const { entry, entryPort: port } = cmd;
        entryPort = port;
        const zipFile =
          entry.method === 'store'
            ? new ZipPassThrough(entry.path)
            : new ZipDeflate(entry.path, { level: entry.level });
        let bytes = 0;
        let entrySeq = 0;
        let creditOutstanding = false;
        const credit = () => {
          creditOutstanding = true;
          port.postMessage({
            version: 1,
            batchId,
            type: 'credit',
            entryId: entry.entryId,
            seq: entrySeq,
            maxBytes: CHUNK,
          } satisfies EntryControl);
        };
        port.onmessageerror = () => fail('entry_message_error');
        port.onmessage = ({ data: msg }: MessageEvent<EntryData>) => {
          if (stopped) return;
          if (msg.type === 'entry-abort') {
            fail(msg.error.messageKey);
            return;
          }
          if (
            msg.version !== 1 ||
            msg.batchId !== batchId ||
            msg.jobId !== entry.jobId ||
            msg.entryId !== entry.entryId ||
            !creditOutstanding ||
            msg.seq !== entrySeq ||
            !(msg.chunk.buffer instanceof ArrayBuffer) ||
            msg.chunk.byteLength !== msg.chunk.buffer.byteLength ||
            msg.chunk.byteLength > CHUNK ||
            bytes + msg.chunk.byteLength > entry.maxBytes
          ) {
            fail('invalid_entry_chunk');
            return;
          }
          creditOutstanding = false;
          entrySeq++;
          bytes += msg.chunk.byteLength;
          if (msg.final && bytes !== entry.maxBytes) {
            fail('entry_size_mismatch');
            return;
          }
          try {
            zipFile.push(new Uint8Array(msg.chunk.buffer), msg.final);
          } catch {
            fail('zip_compression_failed');
            return;
          }
          if (msg.final) {
            entries++;
            port.close();
            entryPort = null;
            send({
              version: 1,
              batchId,
              type: 'entry-packed',
              entryId: entry.entryId,
              inputBytes: bytes,
            });
          } else {
            // No producer credit until every callback chunk has reached the sink.
            grant = credit;
            flush();
          }
        };
        port.start();
        zip.add(zipFile);
        grant = credit;
        flush();
      } else if (cmd.type === 'finish') {
        if (entries !== open.expectedEntries || entryPort) {
          fail('archive_entries_missing');
          return;
        }
        zip.end();
      } else if (cmd.type === 'abort') {
        stopped = true;
        entryPort?.close();
        queue.length = 0;
      }
    } catch {
      fail('zip_processing_failed');
    }
  };
  send({ version: 1, batchId, type: 'zip-ready' });
};
