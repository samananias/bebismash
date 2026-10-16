import { lazy, Suspense, useEffect, useState } from 'react';
import { loadStatisticsOnce, readStatisticsCache } from '../services/statistics';
import type { StatisticsSnapshot } from '../services/statistics';
import { LazyBoundary } from './LazyBoundary';
const PrivacyDialog = lazy(() =>
  import('./PrivacyDialog').then((m) => ({ default: m.PrivacyDialog }))
);
const bytes = (n: number) => {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const i = n ? Math.min(4, Math.floor(Math.log(n) / Math.log(1024))) : 0;
  return `${(n / 1024 ** i).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[i]}`;
};
const CommunityDetails = lazy(() =>
  import('./CommunityDetails').then((m) => ({ default: m.CommunityDetails }))
);

export function TelemetryBadge() {
  const [snapshot, setSnapshot] = useState<StatisticsSnapshot>(() => ({
    stats: readStatisticsCache(),
    stale: true,
  }));
  const [isPrivacyOpen, setIsPrivacyOpen] = useState(false);
  const [offline, setOffline] = useState('');
  const [preparing, setPreparing] = useState(false);
  useEffect(() => {
    let mounted = true;
    void loadStatisticsOnce().then((value) => {
      if (mounted) setSnapshot(value);
    });
    return () => {
      mounted = false;
    };
  }, []);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const stats = snapshot.stats;
  return (
    <>
      <section className="telemetry" aria-label="Community statistics">
        {stats ? (
          <>
            <p>
              Community-reported savings: <strong>{bytes(stats.saved_bytes)}</strong> ·{' '}
              {stats.total_files_compressed.toLocaleString()}{' '}
              {stats.total_files_compressed === 1 ? 'file' : 'files'} compressed
            </p>
            <details onToggle={(event) => setDetailsOpen(event.currentTarget.open)}>
              <summary>Statistics & freshness</summary>
              {detailsOpen && (
                <LazyBoundary>
                  <Suspense fallback={<p>Opening statistics…</p>}>
                    <CommunityDetails snapshot={snapshot} />
                  </Suspense>
                </LazyBoundary>
              )}
            </details>
          </>
        ) : (
          <p>Community-reported savings: unavailable. File processing stays local.</p>
        )}
        <div className="footer-actions">
          <button type="button" onClick={() => setIsPrivacyOpen(true)} className="privacy-link">
            Privacy & telemetry
          </button>
          <button
            type="button"
            className="privacy-link"
            disabled={preparing}
            onClick={() => {
              setPreparing(true);
              setOffline('Saving app and engine assets for offline use…');
              void import('../services/offline')
                .then((m) => m.prepareOffline())
                .then(() => {
                  setOffline(
                    'Offline assets saved. Browser storage may be cleared; prepare again after an update.'
                  );
                })
                .catch(() =>
                  setOffline(
                    'Could not prepare offline assets. Connect to the internet and try again.'
                  )
                )
                .finally(() => setPreparing(false));
            }}
          >
            {preparing ? 'Preparing offline use…' : 'Prepare offline use'}
          </button>
        </div>
        <p className="offline-status" role="status">
          {offline || 'Offline use needs saved app and engine assets. Your files are never cached.'}
        </p>
      </section>
      {isPrivacyOpen && (
        <LazyBoundary>
          <Suspense fallback={<p>Opening privacy settings…</p>}>
            <PrivacyDialog isOpen={isPrivacyOpen} onClose={() => setIsPrivacyOpen(false)} />
          </Suspense>
        </LazyBoundary>
      )}
    </>
  );
}
