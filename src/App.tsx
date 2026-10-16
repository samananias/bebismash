import { useRef, useState, lazy, Suspense } from 'react';
import type { DragEvent } from 'react';
import type { Intensity } from './core/types';
import { useSmashStore } from './store/useSmashStore';
import { TelemetryBadge } from './components/TelemetryBadge';
const JobStatus = lazy(() =>
  import('./components/JobStatus').then((module) => ({ default: module.JobStatus }))
);
import { PixelArt } from './components/PixelArt';

function formatBytes(bytes: number) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index ? 2 : 0)} ${units[index]}`;
}

function UploadIcon() {
  return (
    <svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <path
        d="M24 8h16v8h8v8h8v24h-8v8H16v-8H8V24h8v-8h8V8Z"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path d="M32 44V24m-8 8 8-8 8 8" stroke="currentColor" strokeWidth="4" />
    </svg>
  );
}

export default function App() {
  const {
    phase,
    order,
    files,
    intensity,
    queuedBytes,
    download,
    errorMessage,
    stageFiles,
    removeFile,
    clearQueue,
    setIntensity,
    startSmash,
    cancelSmash,
    reset,
  } = useSmashStore();
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const busy = [
    'validating',
    'awaiting-confirmation',
    'running',
    'finalizing',
    'cancelling',
  ].includes(phase);
  const singleFile = order.length === 1;
  const outputLabel = singleFile ? 'file' : 'ZIP';
  const complete = phase === 'complete';
  const editable = !busy && !complete;
  const drop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    if (editable) stageFiles(Array.from(event.dataTransfer.files));
  };
  const phaseLabel =
    phase === 'running'
      ? 'Processing locally…'
      : phase === 'cancelling'
        ? 'Cancelling batch…'
        : phase === 'cancelled'
          ? 'Batch cancelled. Your files are ready to retry.'
          : phase === 'failed'
            ? 'Batch stopped. Review the error below and retry.'
            : complete
              ? singleFile ? 'Your file is ready.' : 'Your archive is ready.'
              : order.length
                ? `${order.length} ${order.length === 1 ? 'file' : 'files'} ready to smash.`
                : 'Ready when you are.';
  const savings = complete && download ? queuedBytes - download.bytes : null;
  return (
    <div className="workspace">
      <a href="#workspace" className="skip-link">
        Skip to files
      </a>
      <header className="topbar">
        <a className="brand" href="/" aria-label="BebiSmash home">
          <span className="brand-mark" aria-hidden="true">
            b.
          </span>
          <span>
            bebismash<small>LESS BYTES. MORE PLAY.</small>
          </span>
        </a>
        <span className="top-status">
          <span className="status-dot" /> LOCAL BY DESIGN
        </span>
      </header>
      <main id="workspace">
        <section className="intro">
          <div>
            <h1>
              A little lighter.
              <br />
              <em>A lot more room.</em>
            </h1>
            <p>A tidy space for smaller files. All on your device.</p>
          </div>
          <div className="intro-art">
            <PixelArt scene={2} />
            <span>A FEW PIXELS OF PEACE.</span>
          </div>
        </section>
        <section
          aria-label="Add files"
          className={`upload-panel ${dragging ? 'dragging' : ''}`}
          onDragOver={(event) => {
            event.preventDefault();
            if (editable) setDragging(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null))
              setDragging(false);
          }}
          onDrop={drop}
        >
          <div className="panel-top">
            <span>DROP ZONE</span>
            <span>IMAGES / VIDEO / DOCUMENTS / MORE</span>
          </div>
          <div className="drop-content">
            <div className="upload-icon">
              <UploadIcon />
            </div>
            <h2>{dragging ? 'Let those files go.' : 'Room for your files.'}</h2>
            <p>Drag files here, or pick a few.</p>
            <button
              className="pixel-button primary"
              disabled={!editable}
              onClick={() => fileInput.current?.click()}
            >
              Choose files <span aria-hidden="true">↗</span>
            </button>
            <small>
              {complete
                ? 'Start a new batch to add more files.'
                : 'Compress supported files. Package the rest.'}
            </small>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              aria-label="Choose files"
              disabled={!editable}
              onChange={(event) => {
                if (event.target.files) stageFiles(Array.from(event.target.files));
                event.target.value = '';
              }}
            />
          </div>
          <p className="privacy-line">Your files stay on your device.</p>
        </section>
        <section className="controls" aria-label="Compression settings">
          <div className="preset-group" role="group" aria-label="Compression intensity">
            {(['gentle', 'balanced', 'heavy'] as Intensity[]).map((level) => (
              <button
                key={level}
                aria-pressed={level === intensity}
                disabled={!editable}
                onClick={() => setIntensity(level)}
              >
                {level.charAt(0).toUpperCase() + level.slice(1)}
              </button>
            ))}
          </div>
          <p className="preset-note">
            {intensity === 'gentle'
              ? 'Fidelity first. A softer squeeze.'
              : intensity === 'heavy'
                ? 'Smaller files. More visible tradeoffs.'
                : 'A happy medium of quality and size.'}
          </p>
          {!busy && !complete && order.length > 0 && 'showSaveFilePicker' in window && (
            <button
              className="text-button"
              onClick={() => {
                void (async () => {
                  try {
                    const handle = await (
                      window as unknown as {
                        showSaveFilePicker: (options: unknown) => Promise<FileSystemFileHandle>;
                      }
                    ).showSaveFilePicker({
                      suggestedName: singleFile ? files[order[0]!]!.name : 'BebiSmash.zip',
                      ...(singleFile ? {} : { types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }] }),
                    });
                    const { FileSystemArchiveSink } = await import('./services/sink');
                    await startSmash(new FileSystemArchiveSink(handle));
                  } catch (error) {
                    if (!(error instanceof DOMException && error.name === 'AbortError'))
                      useSmashStore.setState({
                        errorMessage:
                          error instanceof Error
                            ? error.message
                            : 'Could not open local output file',
                      });
                  }
                })();
              }}
            >
              Save {outputLabel} to disk
            </button>
          )}
          {complete ? (
            <button className="pixel-button" onClick={reset}>
              New batch <span aria-hidden="true">↻</span>
            </button>
          ) : busy ? (
            <button
              className="pixel-button"
              disabled={phase === 'cancelling'}
              onClick={() => void cancelSmash()}
            >
              Cancel batch <span aria-hidden="true">×</span>
            </button>
          ) : (
            <button
              className="pixel-button"
              disabled={!order.length}
              onClick={() => void startSmash()}
            >
              {phase === 'failed' || phase === 'cancelled' ? 'Retry batch' : singleFile ? 'Compress file' : 'Smash into ZIP'}{' '}
              <span aria-hidden="true">→</span>
            </button>
          )}
          <small className="capability-note">
            Lossy formats may change appearance. PNG uses lossless optimization.
          </small>
        </section>
        <section className="results" aria-labelledby="files-heading" aria-busy={busy}>
          <div className="results-heading">
            <h2 id="files-heading">
              Your files <span className="count">{String(order.length).padStart(2, '0')}</span>
            </h2>
            <button
              className="text-button"
              disabled={!editable || !order.length}
              onClick={clearQueue}
            >
              Clear files <span aria-hidden="true">×</span>
            </button>
          </div>
          {order.length ? (
            <ul className="file-list">
              {order.map((id) => {
                const file = files[id];
                if (!file) return null;
                const packed = file.status === 'packed';
                const reduction =
                  packed && file.outputBytes !== null && file.originalBytes > 0
                    ? Math.max(0, Math.round((1 - file.outputBytes / file.originalBytes) * 100))
                    : 0;
                const extension = file.name.includes('.')
                  ? file.name.split('.').pop()?.slice(0, 7).toUpperCase()
                  : 'FILE';
                return (
                  <li className="file-row" key={id}>
                    <div className="file-symbol" aria-hidden="true">
                      <svg viewBox="0 0 40 48" fill="none">
                        <path
                          d="M6 2h20l10 10v34H6V2Zm20 0v12h10M13 24h16M13 31h16"
                          stroke="currentColor"
                          strokeWidth="2"
                        />
                      </svg>
                      <span>{extension || 'FILE'}</span>
                    </div>
                    <div className="file-details">
                      <div className="file-title">
                        <h3 title={file.name}>{file.name}</h3>
                        {editable && (
                          <button
                            className="remove-button"
                            aria-label={`Remove ${file.name}`}
                            onClick={() => removeFile(id)}
                          >
                            ×
                          </button>
                        )}
                      </div>
                      <div className="file-metrics">
                        <span>{formatBytes(file.originalBytes)}</span>
                        <span aria-hidden="true">→</span>
                        <strong>
                          {packed && file.outputBytes !== null
                            ? formatBytes(file.outputBytes)
                            : '—'}
                        </strong>
                        {packed && (
                          <span className="saving">{reduction ? `−${reduction}%` : 'PACKED'}</span>
                        )}
                      </div>
                      <Suspense
                        fallback={<p className="file-caption">Preparing status details…</p>}
                      >
                        <JobStatus
                          file={file}
                          batchComplete={complete}
                          singleFile={singleFile}
                          retry={() => {
                            void (async () => {
                              await cancelSmash();
                              await startSmash();
                            })();
                          }}
                        />
                      </Suspense>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="empty-state">
              <span className="empty-pixels" aria-hidden="true">
                [ ]
              </span>
              <p>A clean slate. Add a few files to get started.</p>
              <small>Nothing is uploaded. No account needed.</small>
            </div>
          )}
        </section>
        <section className="batch-summary" aria-label="Batch summary">
          <div>
            <span className="summary-icon" aria-hidden="true">
              ↘
            </span>
            <div>
              <strong>
                {savings !== null
                  ? savings > 0
                    ? `${formatBytes(savings)} less to carry.`
                    : singleFile ? 'Your file is ready.' : 'Your files, neatly packaged.'
                  : order.length
                    ? `${formatBytes(queuedBytes)} in your queue.`
                    : 'Make a little room.'}
              </strong>
              <p>
                {download?.ready
                  ? download.packaging === 'file' ? `${formatBytes(download.bytes)} · ${download.name}` : `${formatBytes(download.bytes)} ZIP · ${savings !== null && savings < 0 ? `${formatBytes(-savings)} archive overhead` : 'includes archive overhead'}`
                  : singleFile ? 'Actual savings appear when your file is ready.' : 'Actual savings appear when your archive is ready.'}
              </p>
            </div>
          </div>
          {download?.ready && download.url ? (
            <a
              className="pixel-button primary download-button"
              href={download.url}
              download={download.name}
            >
              Download {outputLabel} <span aria-hidden="true">↓</span>
            </a>
          ) : (
            <button className="pixel-button primary download-button" disabled>
              {download?.kind === 'disk' ? 'Saved to disk' : `Download ${outputLabel}`}{' '}
              <span aria-hidden="true">↓</span>
            </button>
          )}
        </section>
        <p className="live-message" role="status">
          {phaseLabel}
        </p>
        {errorMessage && (
          <div className="error-message" role="alert">
            <strong>Couldn’t finish this batch.</strong>
            <p>{errorMessage}</p>
            <span>Your original files are still available. Remove a file or retry.</span>
          </div>
        )}
      </main>
      <footer>
        <span>BUILT FOR YOUR FILES. KEPT ON YOUR DEVICE.</span>
        <TelemetryBadge />
      </footer>
    </div>
  );
}
