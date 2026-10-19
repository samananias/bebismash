import { saveOptions } from '../core/saveOptions';
import { useSmashStore } from '../store/useSmashStore';
import type { IArchiveSink } from '../services/sink';

export function SaveToDisk({
  filename,
  singleFile,
  startSmash,
}: {
  filename: string;
  singleFile: boolean;
  startSmash: (sink?: IArchiveSink) => Promise<void>;
}) {
  return (
    <button
      className="text-button"
      onClick={() => {
        void (async () => {
          try {
            // Obtain the handle in the trusted click, before loading processing code.
            const handle = await (
              window as unknown as {
                showSaveFilePicker: (options: unknown) => Promise<FileSystemFileHandle>;
              }
            ).showSaveFilePicker(saveOptions(filename));
            const { FileSystemArchiveSink } = await import('../services/sink');
            await startSmash(new FileSystemArchiveSink(handle));
          } catch (error) {
            if (!(error instanceof DOMException && error.name === 'AbortError')) {
              useSmashStore.setState({
                errorMessage:
                  error instanceof Error ? error.message : 'Could not open local output file',
              });
            }
          }
        })();
      }}
    >
      Save {singleFile ? 'file' : 'ZIP'} to disk
    </button>
  );
}
