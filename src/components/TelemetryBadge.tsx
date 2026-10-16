import { lazy, Suspense, useEffect, useState } from 'react';

const PrivacyDialog = lazy(() =>
  import('./PrivacyDialog').then((m) => ({ default: m.PrivacyDialog }))
);

export function TelemetryBadge() {
  const [stats, setStats] = useState<{
    total_files_smashed: number;
    total_bytes_saved: number;
  } | null>(null);
  const [isPrivacyOpen, setIsPrivacyOpen] = useState(false);

  useEffect(() => {
    let isMounted = true;
    fetch('/api/stats', { headers: { Accept: 'application/json' } })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (isMounted && data) {
          setStats({
            total_files_smashed: data.total_files_smashed,
            total_bytes_saved: data.total_bytes_saved,
          });
        }
      })
      .catch(() => {});

    return () => {
      isMounted = false;
    };
  }, []);

  const formatMB = (bytes: number) => {
    return (bytes / (1024 * 1024)).toFixed(1);
  };

  return (
    <>
      <div className="telemetry">
        {stats ? (
          <span>
            Community-reported savings: <strong>{formatMB(stats.total_bytes_saved)} MB</strong>{' '}
            across {stats.total_files_smashed.toLocaleString()} files
          </span>
        ) : (
          <span>Community-reported savings: unavailable</span>
        )}

        <button type="button" onClick={() => setIsPrivacyOpen(true)} className="privacy-link">
          Privacy & telemetry
        </button>
      </div>

      {isPrivacyOpen && (
        <Suspense fallback={null}>
          <PrivacyDialog isOpen={isPrivacyOpen} onClose={() => setIsPrivacyOpen(false)} />
        </Suspense>
      )}
    </>
  );
}
