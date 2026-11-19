import { parentPort } from 'node:worker_threads';
import { cropReceiptBitmap, type ReceiptCropJob } from './browser-receipt-image';

parentPort?.on('message', (job: ReceiptCropJob & { id: number }) => {
  try {
    const bitmap = cropReceiptBitmap(job);
    parentPort?.postMessage({ id: job.id, bitmap }, bitmap === null ? [] : [bitmap.bgra.buffer as ArrayBuffer]);
  } catch (error) {
    parentPort?.postMessage({ id: job.id, bitmap: null, error: error instanceof Error ? error.message : String(error) });
  }
});
