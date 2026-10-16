import { useEffect, useRef, useState } from 'react';
import type { Intensity } from './core/types';
import { useSmashStore } from './store/useSmashStore';
import { TelemetryBadge } from './components/TelemetryBadge';

export default function App() {
  const {
    phase,
    order,
    files,
    intensity,
    queuedBytes,
    hardware,
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

  const [isDragOver, setIsDragOver] = useState(false);
  const [isSecure, setIsSecure] = useState(false);
  const [isIsolated, setIsIsolated] = useState(false);
  const [hasSab, setHasSab] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setIsSecure(window.isSecureContext);
    setIsIsolated(window.crossOriginIsolated);
    setHasSab(typeof SharedArrayBuffer !== 'undefined');
  }, []);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      stageFiles(Array.from(e.dataTransfer.files));
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      stageFiles(Array.from(e.target.files));
      e.target.value = '';
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-between p-6 sm:p-12">
      {/* Header */}
      <header className="w-full max-w-5xl flex items-center justify-between py-4 border-b border-slate-800">
        <div className="flex items-center space-x-3">
          <span className="text-2xl font-black tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 via-sky-400 to-emerald-400">
            BebiSmash
          </span>
          <span className="text-xs px-2.5 py-0.5 rounded-full font-mono bg-indigo-950/80 text-indigo-300 border border-indigo-800">
            v0.1.0 • M4 Edge & Release
          </span>
        </div>

        <div className="flex items-center space-x-2 text-xs font-mono">
          <span
            className={`inline-flex items-center px-2 py-1 rounded-md border ${
              isIsolated
                ? 'bg-emerald-950/60 border-emerald-800 text-emerald-400'
                : 'bg-amber-950/60 border-amber-800 text-amber-400'
            }`}
          >
            {isIsolated ? '● Isolated' : '○ Non-Isolated'}
          </span>
        </div>
      </header>

      {/* Main Container */}
      <div className="w-full max-w-5xl my-8 flex flex-col items-center">
        {/* Hero Title */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium bg-slate-900 border border-slate-800 text-slate-300 mb-4">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
            Private In-Memory Stream Packaging
          </div>
          <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white mb-2">
            Zero-Upload File Smasher & Bundler
          </h1>
          <p className="text-slate-400 text-sm max-w-lg mx-auto">
            Package and compress your files directly in your browser. All data remains inside your
            device memory and streams straight to disk or download.
          </p>
        </div>

        {/* Dropzone Area */}
        <section
          aria-label="File upload dropzone"
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragOver(true);
          }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`w-full max-w-3xl p-8 rounded-2xl border-2 border-dashed transition-all cursor-pointer flex flex-col items-center justify-center text-center ${
            isDragOver
              ? 'border-indigo-400 bg-indigo-950/30'
              : 'border-slate-800 bg-slate-900/40 hover:border-slate-700 hover:bg-slate-900/60'
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileChange}
          />
          <div className="h-12 w-12 rounded-full bg-indigo-950/80 border border-indigo-800 flex items-center justify-center text-indigo-400 text-xl mb-3">
            📦
          </div>
          <p className="text-sm font-semibold text-slate-200">
            Drag and drop files here, or click to browse
          </p>
          <p className="text-xs text-slate-500 mt-1">
            Zero upload. Files are processed locally using transferable Web Worker streams.
          </p>
        </section>

        {/* Controls and Queue */}
        {order.length > 0 && (
          <div className="w-full max-w-3xl mt-6 p-6 rounded-2xl bg-slate-900/60 border border-slate-800">
            {/* Header controls */}
            <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-800">
              <div>
                <span className="text-sm font-semibold text-slate-200">
                  Queue ({order.length} {order.length === 1 ? 'file' : 'files'})
                </span>
                <span className="text-xs text-slate-400 ml-2 font-mono">
                  Total: {formatBytes(queuedBytes)}
                </span>
              </div>

              {/* Intensity Picker */}
              <div className="flex items-center space-x-1 bg-slate-950 p-1 rounded-lg border border-slate-800 text-xs font-medium">
                {(['gentle', 'balanced', 'heavy'] as Intensity[]).map((level) => (
                  <button
                    key={level}
                    type="button"
                    onClick={() => setIntensity(level)}
                    className={`px-3 py-1 rounded-md capitalize transition-colors ${
                      intensity === level
                        ? 'bg-indigo-600 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {level}
                  </button>
                ))}
              </div>
            </div>

            {/* File List */}
            <ul className="divide-y divide-slate-800/60 my-4 max-h-60 overflow-y-auto pr-1">
              {order.map((id) => {
                const file = files[id];
                if (!file) return null;
                return (
                  <li key={id} className="py-2.5 flex items-center justify-between text-xs">
                    <div className="flex items-center space-x-3 truncate">
                      <span className="text-slate-400">📄</span>
                      <span className="font-medium text-slate-200 truncate max-w-xs sm:max-w-md">
                        {file.name}
                      </span>
                    </div>
                    <div className="flex items-center space-x-3 ml-4 shrink-0 font-mono text-slate-400">
                      <span>{formatBytes(file.originalBytes)}</span>
                      {phase === 'idle' && (
                        <button
                          type="button"
                          onClick={() => removeFile(id)}
                          className="text-rose-400 hover:text-rose-300 ml-2 text-base leading-none"
                          title="Remove file"
                        >
                          ×
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>

            {/* Actions Bar */}
            <div className="flex items-center justify-between pt-4 border-t border-slate-800">
              <button
                type="button"
                onClick={clearQueue}
                disabled={phase === 'running'}
                className="text-xs text-slate-400 hover:text-slate-200 disabled:opacity-50 transition-colors"
              >
                Clear All
              </button>

              <div className="flex items-center space-x-3">
                {phase === 'running' ? (
                  <button
                    type="button"
                    onClick={cancelSmash}
                    className="px-4 py-2 text-xs font-semibold rounded-lg bg-rose-600/80 hover:bg-rose-600 text-white transition-colors"
                  >
                    Cancel Batch
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={startSmash}
                    disabled={order.length === 0}
                    className="px-5 py-2 text-xs font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-500/20 disabled:opacity-50 transition-colors"
                  >
                    Pack into ZIP Archive
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Status / Error Notifications */}
        {errorMessage && (
          <div className="w-full max-w-3xl mt-4 p-4 rounded-xl bg-rose-950/60 border border-rose-800 text-rose-300 text-xs">
            <strong>Error:</strong> {errorMessage}
          </div>
        )}

        {/* Download Ready Card */}
        {download && download.ready && (
          <div className="w-full max-w-3xl mt-6 p-6 rounded-2xl bg-emerald-950/40 border border-emerald-800 flex flex-col sm:flex-row items-center justify-between gap-4">
            <div>
              <div className="flex items-center space-x-2">
                <span className="text-emerald-400 text-lg">✓</span>
                <span className="text-sm font-semibold text-emerald-300">
                  Archive Ready: {download.name}
                </span>
              </div>
              <p className="text-xs text-emerald-400/80 mt-1 font-mono">
                Total Archive Size: {formatBytes(download.bytes)}
              </p>
            </div>

            <div className="flex items-center space-x-3">
              <button
                type="button"
                onClick={reset}
                className="px-3 py-1.5 text-xs text-slate-300 hover:text-white"
              >
                New Batch
              </button>
              {download.url && (
                <a
                  href={download.url}
                  download={download.name}
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-600/20 transition-colors inline-flex items-center space-x-1"
                >
                  <span>Download ZIP</span>
                  <span>↓</span>
                </a>
              )}
            </div>
          </div>
        )}

        {/* Hardware Status Footer */}
        {hardware && (
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3 text-xs text-slate-400 font-mono">
            <span className="px-2.5 py-1 rounded bg-slate-900 border border-slate-800">
              Tier: <strong className="text-slate-200">{hardware.tier}</strong>
            </span>
            <span className="px-2.5 py-1 rounded bg-slate-900 border border-slate-800">
              Slots: <strong className="text-slate-200">{hardware.maxWorkers}</strong>
            </span>
            <span className="px-2.5 py-1 rounded bg-slate-900 border border-slate-800">
              Blob Cap:{' '}
              <strong className="text-slate-200">
                {(hardware.blobLimitBytes / (1024 * 1024)).toFixed(0)} MB
              </strong>
            </span>
            <span className="px-2.5 py-1 rounded bg-slate-900 border border-slate-800">
              FileSystem:{' '}
              <strong className="text-slate-200">
                {hardware.fileSystemSink ? 'Available' : 'Unsupported'}
              </strong>
            </span>
            <span className="px-2.5 py-1 rounded bg-slate-900 border border-slate-800">
              SecureContext: <strong className="text-slate-200">{isSecure ? 'Yes' : 'No'}</strong>
            </span>
            <span className="px-2.5 py-1 rounded bg-slate-900 border border-slate-800">
              SAB:{' '}
              <strong className="text-slate-200">{hasSab ? 'Available' : 'Unavailable'}</strong>
            </span>
          </div>
        )}
      </div>

      {/* Footer */}
      <footer className="w-full max-w-5xl py-6 border-t border-slate-800 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-500">
        <div>BebiSmash • Zero-Upload Architecture • In-Browser Processing</div>
        <TelemetryBadge />
      </footer>
    </main>
  );
}
