import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useImportZip } from '../../hooks/useSession';

function isFileDrag(dt: DataTransfer | null): boolean {
  return dt !== null && Array.from(dt.types).includes('Files');
}

export function isZipFile(file: { name: string; type: string }): boolean {
  const name = file.name.toLowerCase();
  return (
    name.endsWith('.zip') ||
    file.type === 'application/zip' ||
    file.type === 'application/x-zip-compressed'
  );
}

export function ZipDropOverlay() {
  const navigate = useNavigate();
  const { mutateAsync: importZip, isPending: importing } = useImportZip();
  const [dragging, setDragging] = useState(false);
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
