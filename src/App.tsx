import { useEffect, useState } from 'react';
import type { HardwareProfile } from './core/types';
import { detectHardwareProfile } from './core/hardware';

export default function App() {
  const [profile, setProfile] = useState<HardwareProfile | null>(null);
  const [isSecure, setIsSecure] = useState(false);
  const [isIsolated, setIsIsolated] = useState(false);
  const [hasSab, setHasSab] = useState(false);

  useEffect(() => {
    setIsSecure(window.isSecureContext);
    setIsIsolated(window.crossOriginIsolated);
    setHasSab(typeof SharedArrayBuffer !== 'undefined');
    setProfile(detectHardwareProfile());
  }, []);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-between p-6 sm:p-12">
      {/* Header */}
      <header className="w-full max-w-4xl flex items-center justify-between py-4 border-b border-slate-800">
        <div className="flex items-center space-x-3">
          <span className="text-2xl font-black tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 via-sky-400 to-emerald-400">
            BebiSmash
          </span>
          <span className="text-xs px-2 py-0.5 rounded-full font-mono bg-indigo-950 text-indigo-300 border border-indigo-800">
            v0.1.0 • M0
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

      {/* Hero / Main Area */}
      <div className="w-full max-w-4xl my-auto flex flex-col items-center text-center py-12">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium bg-slate-900 border border-slate-800 text-slate-300 mb-6">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
          Zero-Upload In-Memory Compression Pipeline
        </div>

        <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight text-white mb-4">
          Compress everything locally. <br />
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-cyan-400">
            Not a single byte leaves your device.
          </span>
        </h1>

        <p className="max-w-xl text-slate-400 text-base sm:text-lg mb-10">
          Private, in-browser file smasher powered by WebAssembly and WebCodecs. Images, videos,
          documents, and archives packed directly to disk.
        </p>

        {/* Dropzone Skeleton (Prepared for M1) */}
        <section
          aria-label="File upload dropzone"
          className="w-full max-w-2xl p-10 rounded-2xl border-2 border-dashed border-slate-800 bg-slate-900/40 hover:border-indigo-500/50 hover:bg-slate-900/60 transition-all cursor-pointer flex flex-col items-center justify-center space-y-4"
        >
          <div className="h-14 w-14 rounded-full bg-indigo-950/80 border border-indigo-800 flex items-center justify-center text-indigo-400 text-2xl">
            📦
          </div>
          <div>
            <p className="text-sm font-semibold text-slate-200">
              Drag & drop files here, or click to browse
            </p>
            <p className="text-xs text-slate-500 mt-1">
              Supports JPEG, PNG, WebP, AVIF, MP4, WebM, PDF, Office, and ZIP archives
            </p>
          </div>
          <button
            type="button"
            className="mt-2 px-4 py-2 text-xs font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
          >
            Select Files
          </button>
        </section>

        {/* Hardware & Diagnostics Profile */}
        {profile && (
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3 text-xs text-slate-400 font-mono">
            <span className="px-2.5 py-1 rounded bg-slate-900 border border-slate-800">
              Tier: <strong className="text-slate-200">{profile.tier}</strong>
            </span>
            <span className="px-2.5 py-1 rounded bg-slate-900 border border-slate-800">
              Workers: <strong className="text-slate-200">{profile.maxWorkers}</strong>
            </span>
            <span className="px-2.5 py-1 rounded bg-slate-900 border border-slate-800">
              Budget:{' '}
              <strong className="text-slate-200">
                {(profile.memoryBudgetBytes / (1024 * 1024)).toFixed(0)} MB
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
      <footer className="w-full max-w-4xl py-4 border-t border-slate-800 text-center text-xs text-slate-500">
        BebiSmash • Private Zero-Upload Architecture • Engineered for Extreme Privacy & Performance
      </footer>
    </main>
  );
}
