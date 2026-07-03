import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useImportZip } from '../../hooks/useSession';

/** True for the file-like drag payloads we care about; filters out text /
 *  link drags so the overlay doesn't hijack ordinary in-page drags. */
function isFileDrag(dt: DataTransfer | null): boolean {
  return dt !== null && Array.from(dt.types).includes('Files');
}

/** Cheap client-side zip check for immediate feedback. The server still
 *  validates the bytes and bundle shape; this only gates the drop. */
export function isZipFile(file: { name: string; type: string }): boolean {
  const name = file.name.toLowerCase();
  return (
    name.endsWith('.zip') ||
    file.type === 'application/zip' ||
    file.type === 'application/x-zip-compressed'
  );
}

/**
 * Window-level drop target for importing a `/export-debug-zip` bundle.
 *
 * Renders nothing until a file is dragged over the window, then shows a
 * full-screen overlay. Dropping a `.zip` posts it to the import endpoint and
 * navigates to the imported session; non-zip files get an alert and are
 * ignored. The pointer-events are disabled so the overlay itself never swallows
 * the drop — the window listener owns the interaction.
 */
export function ZipDropOverlay() {
  const navigate = useNavigate();
  const { mutateAsync: importZip, isPending: importing } = useImportZip();
  const [dragging, setDragging] = useState(false);
  // Count nested enter/leave pairs so dragging over a child element doesn't
  // briefly drop the counter to zero and flicker the overlay.
  const depth = useRef(0);

  useEffect(() => {
    async function importFile(file: File) {
      try {
        const result = await importZip(file);
        void navigate(`/sessions/${result.sessionId}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        window.alert(`Import failed: ${message}`);
      }
    }

    function onDragEnter(e: DragEvent) {
      if (!isFileDrag(e.dataTransfer)) return;
      e.preventDefault();
      depth.current += 1;
      setDragging(true);
    }
    function onDragOver(e: DragEvent) {
      if (!isFileDrag(e.dataTransfer)) return;
      // Required — without preventDefault the browser cancels the drag and
      // never fires `drop`.
      e.preventDefault();
      if (e.dataTransfer !== null) e.dataTransfer.dropEffect = 'copy';
    }
    function onDragLeave(e: DragEvent) {
      if (!isFileDrag(e.dataTransfer)) return;
      e.preventDefault();
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    }
    function onDrop(e: DragEvent) {
      // Gate on file drags first so non-file drops (e.g. selected text or a
      // URL into the search input) keep their native behavior.
      if (!isFileDrag(e.dataTransfer)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      const file = e.dataTransfer?.files[0];
      if (file === undefined) return;
      if (!isZipFile(file)) {
        window.alert('Please drop a .zip bundle exported from kimi-code (/export-debug-zip).');
        return;
      }
      void importFile(file);
    }

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [importZip, navigate]);

  if (!dragging && !importing) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="border-2 border-dashed border-border-strong bg-surface-1 px-10 py-8 text-center">
        <div className="font-mono text-[13px] text-fg-0">
          {importing ? 'importing debug zip…' : 'drop debug zip to import'}
        </div>
        <div className="mt-2 font-mono text-[11px] text-fg-3">
          from kimi-code /export-debug-zip
        </div>
      </div>
    </div>
  );
}
