/// <reference lib="webworker" />
import { Zip, ZipPassThrough, ZipDeflate } from 'fflate';
import type { ZipCommand, ZipEvent, EntryData, EntryControl } from '../core/types';

const CHUNK_SIZE = 256 * 1024; // 256 KiB max chunk size
const BURST_LIMIT = 2 * 1024 * 1024; // 2 MiB burst allowance

let currentZip: Zip | null = null;
let currentBatchId: string | null = null;
let activeEntryPort: MessagePort | null = null;
let outSeq = 0;
let totalArchiveBytes = 0;
let packedEntriesCount = 0;
let _expectedEntriesCount = 0;

// Sink backpressure queue
let inFlightBytes = 0;
const burstQueue: { buffer: ArrayBuffer; final: boolean }[] = [];

function emitZipEvent(event: ZipEvent, transfer?: Transferable[]): void {
  if (transfer && transfer.length > 0) {
    postMessage(event, transfer);
  } else {
    postMessage(event);
  }
}

function flushBurstQueue(): void {
  while (burstQueue.length > 0 && inFlightBytes < BURST_LIMIT) {
    const item = burstQueue.shift()!;
    inFlightBytes += item.buffer.byteLength;
    outSeq++;

    const chunkEvent: ZipEvent = {
      version: 1,
      batchId: currentBatchId!,
      type: 'zip-chunk',
      seq: outSeq,
      chunk: {
        buffer: item.buffer,
        byteLength: item.buffer.byteLength,
      },
      final: item.final,
    };

    emitZipEvent(chunkEvent, [item.buffer]);
  }
}

function handleZipChunk(err: Error | null, data: Uint8Array, final: boolean): void {
  if (err) {
    emitZipEvent({
      version: 1,
      batchId: currentBatchId || 'unknown',
      type: 'zip-error',
      error: {
        code: 'INTERNAL',
        retryable: false,
        messageKey: 'zip_compression_failed',
      },
    });
    return;
  }

  totalArchiveBytes += data.byteLength;

  // Split into at most 256 KiB owned standalone ArrayBuffers
  let offset = 0;
  do {
    const sliceLen = Math.min(data.byteLength - offset, CHUNK_SIZE);
    const buffer = new ArrayBuffer(sliceLen);
    new Uint8Array(buffer).set(data.subarray(offset, offset + sliceLen));
    offset += sliceLen;

    const isLastSlice = final && offset >= data.byteLength;
    burstQueue.push({ buffer, final: isLastSlice });
  } while (offset < data.byteLength);

  flushBurstQueue();

  if (final) {
    emitZipEvent({
      version: 1,
      batchId: currentBatchId!,
      type: 'zip-complete',
      archiveBytes: totalArchiveBytes,
      entries: packedEntriesCount,
    });
  }
}

self.onmessage = (e: MessageEvent<ZipCommand>) => {
  const cmd = e.data;
  if (!cmd || cmd.version !== 1) return;

  switch (cmd.type) {
    case 'open': {
      currentBatchId = cmd.batchId;
      _expectedEntriesCount = cmd.expectedEntries;
      packedEntriesCount = 0;
      totalArchiveBytes = 0;
      outSeq = 0;
      inFlightBytes = 0;
      burstQueue.length = 0;

      currentZip = new Zip((err, chunk, final) => {
        handleZipChunk(err, chunk, final);
      });

      emitZipEvent({
        version: 1,
        batchId: currentBatchId,
        type: 'zip-ready',
      });
      break;
    }

    case 'add': {
      if (!currentZip || !currentBatchId) {
        emitZipEvent({
          version: 1,
          batchId: cmd.batchId,
          type: 'zip-error',
          error: {
            code: 'PROTOCOL_ERROR',
            retryable: false,
            messageKey: 'zip_not_open',
          },
        });
        return;
      }

      const { entry, entryPort } = cmd;
      activeEntryPort = entryPort;

      const zipFile =
        entry.method === 'deflate'
          ? new ZipDeflate(entry.path, { level: entry.level })
          : new ZipPassThrough(entry.path);

      currentZip.add(zipFile);

      let entrySeq = 0;
      let totalEntryBytes = 0;

      entryPort.onmessage = (entryEvent: MessageEvent<EntryData>) => {
        const msg = entryEvent.data;
        if (!msg || msg.version !== 1) return;

        if (msg.type === 'entry-chunk') {
          const chunkData = new Uint8Array(msg.chunk.buffer);
          totalEntryBytes += chunkData.byteLength;
          zipFile.push(chunkData, msg.final);

          if (msg.final) {
            packedEntriesCount++;
            emitZipEvent({
              version: 1,
              batchId: currentBatchId!,
              type: 'entry-packed',
              entryId: entry.entryId,
              inputBytes: totalEntryBytes,
            });

            activeEntryPort?.close();
            activeEntryPort = null;
          } else {
            entrySeq++;
            // Grant credit for next slice
            const creditMsg: EntryControl = {
              version: 1,
              batchId: currentBatchId!,
              type: 'credit',
              entryId: entry.entryId,
              seq: entrySeq,
              maxBytes: CHUNK_SIZE,
            };
            entryPort.postMessage(creditMsg);
          }
        } else if (msg.type === 'entry-abort') {
          activeEntryPort?.close();
          activeEntryPort = null;
        }
      };

      entryPort.start();

      // Grant initial credit
      const initialCredit: EntryControl = {
        version: 1,
        batchId: currentBatchId,
        type: 'credit',
        entryId: entry.entryId,
        seq: 0,
        maxBytes: CHUNK_SIZE,
      };
      entryPort.postMessage(initialCredit);
      break;
    }

    case 'sink-ack': {
      // Main thread acknowledges chunk receipt; decrement in-flight bytes
      inFlightBytes = Math.max(0, inFlightBytes - CHUNK_SIZE);
      flushBurstQueue();
      break;
    }

    case 'finish': {
      if (currentZip) {
        currentZip.end();
      }
      break;
    }

    case 'abort': {
      if (activeEntryPort) {
        activeEntryPort.close();
        activeEntryPort = null;
      }
      currentZip = null;
      burstQueue.length = 0;
      break;
    }
  }
};
