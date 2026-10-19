/// <reference lib="webworker" />
import type { WorkerCommand, WorkerEvent } from '../core/types';
import { streamPrepared } from './jobRuntime';
self.onmessage = ({ data: cmd }: MessageEvent<WorkerCommand>) => {
  if (cmd?.version !== 1 || cmd.type !== 'start') return;
  postMessage({
    version: 1,
    batchId: cmd.batchId,
    jobId: cmd.jobId,
    attemptId: cmd.attemptId,
    type: 'ready',
  } satisfies WorkerEvent);
  streamPrepared(cmd, cmd.source, {
    disposition: 'original',
    outputBytes: cmd.source.size,
    mime: cmd.source.type || 'application/octet-stream',
    extension: cmd.source.name.split('.').pop() || 'bin',
    durationMs: 0,
  });
};
