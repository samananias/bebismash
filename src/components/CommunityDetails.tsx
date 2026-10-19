import type { StatisticsSnapshot } from '../services/statistics';
const bytes = (n: number) => {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const unit = n ? Math.min(4, Math.floor(Math.log(n) / Math.log(1024))) : 0;
  return `${(n / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[unit]}`;
};
const timestamp = (s: string) => new Date(s).toLocaleString();
export function CommunityDetails({ snapshot }: { snapshot: StatisticsSnapshot }) {
  const s = snapshot.stats;
  if (!s) return null;
  return (
    <>
      <p>
        {s.total_files_processed.toLocaleString()}{' '}
        {s.total_files_processed === 1 ? 'file' : 'files'} processed ·{' '}
        {s.weighted_savings_percent === null ? '—' : `${s.weighted_savings_percent.toFixed(1)}%`}{' '}
        weighted savings
      </p>
      <p>
        Input {bytes(s.input_bytes)} · Output {bytes(s.output_bytes)}
      </p>
      <p>
        Stats retrieved: <time dateTime={s.retrieved_at}>{timestamp(s.retrieved_at)}</time>
        {snapshot.stale ? ' · saved snapshot; refresh online for latest' : ''}
      </p>
      <p>
        Counters last changed: <time dateTime={s.updated_at}>{timestamp(s.updated_at)}</time>
      </p>
      <p>
        Tracking since {timestamp(s.tracking_since)}. Approximate, opt-in reports; output excludes
        ZIP overhead.
      </p>
      {s.formats.length > 0 && (
        <ul>
          {s.formats.map((b) => (
            <li key={`${b.format}:${b.outcome}`}>
              {b.format.toUpperCase()} · {b.file_count.toLocaleString()} {b.outcome}
            </li>
          ))}
        </ul>
      )}
      {s.legacy.files_processed > 0 && (
        <p>
          Earlier reports: {s.legacy.files_processed.toLocaleString()} files processed,{' '}
          {bytes(s.legacy.saved_bytes)} saved. Compression outcomes were not tracked.
        </p>
      )}
    </>
  );
}
