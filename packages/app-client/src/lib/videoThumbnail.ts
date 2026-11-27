const THUMBNAIL_MAX_EDGE = 160;
const THUMBNAIL_TIMEOUT_MS = 5000;

function waitForVideoEvent(
  video: HTMLVideoElement,
  event: 'loadeddata' | 'seeked',
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(`video thumbnail ${event} timeout`));
    }, THUMBNAIL_TIMEOUT_MS);
    const onEvent = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error('video thumbnail decode failed'));
    };
    const cleanup = (): void => {
      window.clearTimeout(timer);
      video.removeEventListener(event, onEvent);
      video.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onError);
    };
    signal?.addEventListener('abort', onError, { once: true });
    if (signal?.aborted) {
      onError();
      return;
    }
    video.addEventListener(event, onEvent, { once: true });
    video.addEventListener('error', onError, { once: true });
  });
}

export async function createVideoThumbnail(source: Blob, signal?: AbortSignal): Promise<string | undefined> {
  if (signal?.aborted || typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return undefined;
  const objectUrl = URL.createObjectURL(source);
  const video = document.createElement('video');
  try {
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    const loadedData = waitForVideoEvent(video, 'loadeddata', signal);
    video.src = objectUrl;
    video.load();
    await loadedData;
    if (Number.isFinite(video.duration) && video.duration > 0.1) {
      const seeked = waitForVideoEvent(video, 'seeked', signal);
      video.currentTime = Math.min(0.1, video.duration / 2);
      await seeked;
    }
    if (video.videoWidth <= 0 || video.videoHeight <= 0) return undefined;
    const scale = Math.min(1, THUMBNAIL_MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (context === null) return undefined;
    context.drawImage(video, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', 0.72);
  } catch {
    return undefined;
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(objectUrl);
  }
}
