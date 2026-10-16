import { useEffect } from 'react';
import { useSmashStore } from '../store/useSmashStore';

interface PrivacyDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function PrivacyDialog({ isOpen, onClose }: PrivacyDialogProps) {
  const { telemetryConsent, setTelemetryConsent } = useSmashStore();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="privacy-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl bg-slate-900 border border-slate-800 p-6 shadow-2xl text-slate-200 text-left"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between pb-3 border-b border-slate-800">
          <h2
            id="privacy-dialog-title"
            className="text-base font-bold text-white flex items-center gap-2"
          >
            <span>🛡️</span> Privacy & Anonymous Telemetry
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-white text-lg p-1"
            aria-label="Close dialog"
          >
            ×
          </button>
        </div>

        <div className="my-4 space-y-3 text-xs leading-relaxed text-slate-300">
          <div className="p-3 rounded-lg bg-emerald-950/40 border border-emerald-800/60">
            <h3 className="font-semibold text-emerald-400 mb-1">Zero-Upload Guarantee</h3>
            <p>
              Your files and their contents <strong>never leave your device</strong>. All decoding,
              encoding, and archiving happen locally in your browser memory inside Web Workers.
            </p>
          </div>

          <div>
            <h3 className="font-semibold text-slate-200 mb-1">What is NEVER transmitted:</h3>
            <ul className="list-disc list-inside space-y-0.5 text-slate-400">
              <li>No file names, paths, or file contents</li>
              <li>No cryptographic hashes or fingerprints</li>
              <li>No cookies, persistent IDs, or accounts</li>
              <li>No IP addresses are stored or logged in database records</li>
            </ul>
          </div>

          <div>
            <h3 className="font-semibold text-slate-200 mb-1">What is sent (only if opted in):</h3>
            <ul className="list-disc list-inside space-y-0.5 text-slate-400">
              <li>
                Allowlisted extension (e.g. <code>jpg</code>, <code>png</code>; unrecognized become{' '}
                <code>other</code>)
              </li>
              <li>
                Compression intensity (<code>gentle</code>, <code>balanced</code>,{' '}
                <code>heavy</code>)
              </li>
              <li>
                Original & compressed bytes <strong>rounded down to KiB</strong> (sub-KiB becomes
                zero)
              </li>
              <li>
                Duration <strong>rounded to nearest 100 ms</strong>
              </li>
              <li>
                Coarse hardware tier (<code>constrained</code>, <code>standard</code>,{' '}
                <code>high</code>)
              </li>
            </ul>
          </div>

          <div className="pt-3 border-t border-slate-800">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={telemetryConsent}
                onChange={(e) => setTelemetryConsent(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-700 bg-slate-950 text-indigo-600 focus:ring-indigo-500"
              />
              <span className="text-xs text-slate-200 font-medium">
                Share anonymous, rounded benchmark metrics to help power the public community
                savings ticker (Default: Off).
              </span>
            </label>
          </div>
        </div>

        <div className="flex justify-end pt-3 border-t border-slate-800">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
