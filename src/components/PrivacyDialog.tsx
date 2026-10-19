import { useEffect, useRef } from 'react';
import { useSmashStore } from '../store/useSmashStore';

interface PrivacyDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function PrivacyDialog({ isOpen, onClose }: PrivacyDialogProps) {
  const { telemetryConsent, setTelemetryConsent } = useSmashStore();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement as HTMLElement | null;
    if (isOpen && !element?.open) {
      element?.showModal();
      element?.querySelector('button')?.focus();
    }
    return () => {
      element?.close();
      previousFocus?.focus();
    };
  }, [isOpen]);
  return (
    <dialog
      ref={dialog}
      className="privacy-dialog"
      aria-labelledby="privacy-dialog-title"
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const controls = dialog.current?.querySelectorAll<HTMLElement>('button, input');
        const first = controls?.[0];
        const last = controls?.[controls.length - 1];
        if (event.shiftKey && document.activeElement === first && last) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last && first) {
          event.preventDefault();
          first.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="dialog-header">
        <h2 id="privacy-dialog-title">Privacy & telemetry</h2>
        <button className="remove-button" onClick={onClose} aria-label="Close dialog">
          ×
        </button>
      </div>
      <div className="dialog-copy">
        <h3>Your files stay here.</h3>
        <p>
          File contents, filenames, paths and hashes are never uploaded. Processing and archiving
          happen locally in your browser. There are no accounts, cookies or persistent identifiers.
        </p>
        <h3>Optional community statistics</h3>
        <p>
          When you opt in, completed batches send counts and byte totals rounded down to KiB,
          grouped by allowlisted input format and whether files were compressed or preserved. One
          request is sent only while this page is visible and online. Failed reports are discarded;
          they never delay your download. These approximate numbers exclude ZIP overhead.
        </p>
        <p>
          Cloudflare processes network identifiers to deliver the service and prevent abuse. IP
          addresses are not stored in our statistics database.
        </p>
        <p>
          Only public community statistics may be saved in local storage. Preparing offline use
          saves app and engine assets; it never saves your files or output.
        </p>
        <label className="consent-label">
          <input
            type="checkbox"
            checked={telemetryConsent}
            onChange={(event) => setTelemetryConsent(event.target.checked)}
          />
          <span>
            Share anonymous, rounded compression statistics. Off by default; this choice lasts for
            this page session.
          </span>
        </label>
      </div>
      <div className="dialog-actions">
        <button className="pixel-button primary" onClick={onClose}>
          Done
        </button>
      </div>
    </dialog>
  );
}
