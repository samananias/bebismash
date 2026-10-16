import { useState, useEffect } from 'react';
import type { FileState } from '../store/useSmashStore';
import type { Stage } from '../core/types';
const labels: Record<Stage, string> = {
  inspect: 'Checking file',
  load: 'Loading compression engine',
  init: 'Initializing WASM / codecs',
  start: 'Starting worker',
  read: 'Preparing file',
  decode: 'Analyzing media',
  transform: 'Compressing',
  encode: 'Encoding output',
  output: 'Generating output',
  pack: 'Packaging ZIP',
  save: 'Finalizing archive',
};
const bytes = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`;
const duration = (ms: number) =>
  `${Math.floor(ms / 60000)
    .toString()
    .padStart(2, '0')}:${Math.floor((ms / 1000) % 60)
    .toString()
    .padStart(2, '0')}`;

export function JobStatus({
  file,
  batchComplete,
  singleFile,
  retry,
}: {
  file: FileState;
  batchComplete: boolean;
  singleFile: boolean;
  retry: () => void;
}) {
  const active = ['running', 'awaiting-pack'].includes(file.status);
  const [now, setNow] = useState(Date.now);
  const [waitUntil, setWaitUntil] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const quiet = active && file.lastProgressAt !== null ? Math.max(0, now - file.lastProgressAt) : 0;
  const stalled = quiet >= 30000 && now > waitUntil;
  const responsive = file.lastHeartbeatAt !== null && now - file.lastHeartbeatAt < 6000;
  const percent = batchComplete ? 100 : file.progress;
  const label = batchComplete
    ? 'Complete'
    : file.status === 'queued'
      ? 'Waiting for worker'
      : file.status === 'failed'
        ? 'Processing failed'
        : file.status === 'cancelled'
          ? 'Cancelled · ready to retry'
          : file.stage
            ? singleFile && file.stage === 'save' ? 'Saving file' : labels[file.stage]
            : 'Ready to start';
  const measure =
    file.total !== null && file.total > 0
      ? file.unit === 'bytes'
        ? `${bytes(file.completed)} / ${bytes(file.total)}`
        : file.unit === 'frames'
          ? `${file.completed.toLocaleString()} / ${file.total.toLocaleString()} frames`
          : `${((file.completed / file.total) * 100).toFixed(1)}% of media timeline`
      : file.completed > 0
        ? file.unit === 'bytes'
          ? `${bytes(file.completed)} processed · total unavailable`
          : `${file.completed.toLocaleString()} ${file.unit} processed`
        : null;
  return (
    <div className="job-status">
      <div className="job-status-line">
        <strong>{label}</strong>
        <span>
          {active && file.startedAt ? `Elapsed ${duration(Math.max(0, now - file.startedAt))}` : ''}
        </span>
      </div>
      <div
        className={`block-progress ${active && percent === null ? 'indeterminate' : ''}`}
        role="progressbar"
        aria-label={`${file.name} processing status`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent === null ? undefined : Math.round(percent)}
        aria-valuetext={measure ? `${label}: ${measure}` : `${label}; percentage unavailable`}
      >
        {Array.from({ length: 20 }, (_, i) => (
          <span key={i} className={percent !== null && i < percent / 5 ? 'filled' : ''} />
        ))}
      </div>
      <p className="job-detail">
        {measure ? `${measure} · ` : ''}
        {file.detail}
      </p>
      {active && (
        <p className="job-next">
          Next:{' '}
          {singleFile ? 'Prepare output → Ready to save' : file.stage === 'pack'
            ? 'Finalize archive → Ready to save'
            : 'Prepare output → Package ZIP → Ready to save'}
          . Files stay on your device.
        </p>
      )}
      {stalled && (
        <div className="stall-notice" role="status">
          <strong>Processing may be stalled</strong>
          <p>
            No measurable progress for {Math.floor(quiet / 1000)} seconds.{' '}
            {responsive
              ? 'Worker is responsive; this operation may still be active.'
              : 'No recent worker heartbeat. WASM may be busy or the worker may be unresponsive.'}{' '}
            Initialization, browser memory pressure, or codec work can take time.
          </p>
          <div className="job-actions">
            <button className="text-button" onClick={() => setWaitUntil(Date.now() + 30000)}>
              Wait 30 seconds
            </button>
            <button className="text-button" onClick={retry}>
              Cancel & retry batch
            </button>
          </div>
        </div>
      )}
      {file.startedAt && (
        <details className="job-details">
          <summary>
            What’s happening? <span className="sr-only">{file.name}</span>
          </summary>
          <dl>
            <dt>Engine</dt>
            <dd>{file.engine ?? 'Selecting engine'}</dd>
            {file.media && (
              <>
                <dt>Source media</dt>
                <dd>
                  {file.media.width} × {file.media.height} · {file.media.videoCodec} /{' '}
                  {file.media.audioCodec}
                </dd>
                <dt>Browser video codecs</dt>
                <dd>
                  {file.media.webCodecs
                    ? 'WebCodecs available; conversion probes the requested configurations'
                    : 'WebCodecs unavailable'}
                </dd>
              </>
            )}
            <dt>Worker / attempt</dt>
            <dd>
              {file.id} / {file.attemptId ?? 'Pending'}
            </dd>
            <dt>Status</dt>
            <dd>{label}</dd>
            <dt>Worker activity</dt>
            <dd>
              {active
                ? responsive
                  ? 'Responsive'
                  : 'No recent heartbeat; non-yielding operation possible'
                : file.status}
            </dd>
            <dt>Memory reservation</dt>
            <dd>{bytes(file.reservedBytes)} estimated; actual browser memory unavailable</dd>
            <dt>Measured progress</dt>
            <dd>{measure ?? 'Engine does not expose a percentage for this stage'}</dd>
            <dt>Last progress</dt>
            <dd>
              {file.lastProgressAt
                ? `${Math.max(0, Math.floor((now - file.lastProgressAt) / 1000))} seconds ago`
                : 'Pending'}
            </dd>
            <dt>Browser capabilities</dt>
            <dd>
              WebAssembly: {typeof WebAssembly === 'object' ? 'available' : 'unavailable'} · Secure
              context: {globalThis.isSecureContext ? 'yes' : 'no'} · Isolation:{' '}
              {globalThis.crossOriginIsolated ? 'yes' : 'no'}
            </dd>
          </dl>
          <p>
            Engine JavaScript uses browser-managed loading and caching; byte progress is
            unavailable. WebCodecs uses browser codecs. FFmpeg is not installed.
          </p>
          {!!Object.keys(file.assets).length && (
            <ul className="engine-assets" aria-label="Compression engine assets">
              {Object.entries(file.assets).map(([name, asset]) => (
                <li key={name}>
                  <strong>{name}</strong>
                  <span>
                    {asset.state === 'cached'
                      ? 'Cached locally (browser cache)'
                      : asset.state === 'ready'
                        ? 'Ready'
                        : asset.state === 'initializing'
                          ? 'Initializing WASM'
                          : asset.state === 'failed'
                            ? 'Download failed'
                            : `Downloading ${bytes(asset.completed)}${asset.total ? ` / ${bytes(asset.total)} (${Math.round((asset.completed / asset.total) * 100)}%)` : ' · total unavailable'}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {file.error && (
            <pre>
              {file.error.code}: {file.error.messageKey}
              {'\n'}
              {file.error.details}
            </pre>
          )}
          {file.status === 'failed' && <pre>{file.detail}</pre>}
        </details>
      )}
    </div>
  );
}
