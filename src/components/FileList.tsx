import { formatBytes } from '../core/formatBytes';
import { lazy, Suspense } from 'react';
import type { SmashState } from '../store/useSmashStore';
import { LazyBoundary } from './LazyBoundary';
const JobStatus = lazy(() =>
  import('./JobStatus').then((module) => ({ default: module.JobStatus }))
);
type Props = Pick<SmashState, 'order' | 'files' | 'removeFile' | 'cancelSmash' | 'startSmash'> & {
  editable: boolean;
  singleFile: boolean;
  complete: boolean;
};
/** Queue UI loads only after files are selected, keeping the empty shell small. */
export function FileList({
  order,
  files,
  editable,
  singleFile,
  complete,
  removeFile,
  cancelSmash,
  startSmash,
}: Props) {
  return (
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
                  {packed && file.outputBytes !== null ? formatBytes(file.outputBytes) : '—'}
                </strong>
                {packed && (
                  <span className="saving">
                    {reduction ? `−${reduction}%` : singleFile ? 'READY' : 'PACKED'}
                  </span>
                )}
              </div>
              <LazyBoundary>
                <Suspense fallback={<p className="file-caption">Preparing status details…</p>}>
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
              </LazyBoundary>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
