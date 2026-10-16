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
      <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-slate-400">
        {stats && stats.total_files_smashed > 0 ? (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-slate-900 border border-slate-800 text-slate-300">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>
            Community-reported savings:{' '}
            <strong className="text-emerald-400 font-mono">
              {formatMB(stats.total_bytes_saved)} MB
            </strong>{' '}
            across {stats.total_files_smashed.toLocaleString()} files
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-slate-900 border border-slate-800 text-slate-400">
            <span className="h-1.5 w-1.5 rounded-full bg-sky-400"></span>
            Community-reported savings: Live ticker ready
          </span>
        )}

        <button
          type="button"
          onClick={() => setIsPrivacyOpen(true)}
          className="text-slate-400 hover:text-indigo-400 underline decoration-dotted transition-colors cursor-pointer"
        >
          [?] Privacy & Telemetry
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
