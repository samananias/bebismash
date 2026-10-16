let pending: Promise<void> | undefined;
/** Explicit user action only. Browser-managed disk cache, never user-file storage. */
export function prepareOffline(): Promise<void> {
  if (pending) return pending;
  pending = prepare().finally(() => {
    pending = undefined;
  });
  return pending;
}
async function prepare(): Promise<void> {
  if (!('serviceWorker' in navigator) || navigator.onLine === false)
    throw new Error('Offline setup needs a secure online browser');
  const registration = await navigator.serviceWorker.register('/offline-worker.js', {
    updateViaCache: 'none',
  });
  // A newer worker must not replace a version still used by an open page.
  if (registration.waiting)
    throw new Error('Close other BebiSmash tabs and reload before preparing this update');
  const worker = registration.active ?? registration.installing;
  if (!worker) throw new Error('Offline worker unavailable');
  if (worker.state !== 'activated')
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        worker.removeEventListener('statechange', changed);
        reject(new Error('Offline worker activation timed out'));
      }, 15000);
      function changed() {
        if (worker!.state === 'activated' || worker!.state === 'redundant') {
          clearTimeout(timeout);
          worker!.removeEventListener('statechange', changed);
          if (worker!.state === 'activated') resolve();
          else reject(new Error('Offline worker replaced'));
        }
      }
      worker.addEventListener('statechange', changed);
      changed();
    });
  await new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => {
      channel.port1.close();
      reject(new Error('Offline preparation timed out'));
    }, 120000);
    channel.port1.onmessage = ({ data }: MessageEvent<{ ok: boolean }>) => {
      clearTimeout(timeout);
      channel.port1.close();
      if (data.ok) resolve();
      else reject(new Error('Offline assets could not be saved'));
    };
    try {
      worker.postMessage({ type: 'PREPARE_OFFLINE' }, [channel.port2]);
    } catch (error) {
      clearTimeout(timeout);
      channel.port1.close();
      channel.port2.close();
      reject(error);
    }
  });
}
