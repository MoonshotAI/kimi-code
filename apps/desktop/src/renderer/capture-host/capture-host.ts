interface StreamEntry {
  stream: MediaStream;
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

interface StartResult {
  ok: boolean;
  width: number;
  height: number;
  error?: string;
}

interface GrabResult {
  width: number;
  height: number;
  data: Uint8Array;
}

interface ShotCaptureHost {
  startStream: (displayId: string) => Promise<StartResult>;
  stopStream: (displayId: string) => void;
  stopAll: () => void;
  has: (displayId: string) => boolean;
  grab: (displayId: string) => GrabResult;
}

const entries = new Map<string, StreamEntry>();

function stopStream(displayId: string): void {
  const entry = entries.get(displayId);
  if (entry === undefined) return;
  for (const track of entry.stream.getTracks()) track.stop();
  entry.video.srcObject = null;
  entries.delete(displayId);
}

async function startStream(displayId: string): Promise<StartResult> {
  stopStream(displayId);
  let stream: MediaStream | undefined;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const track = stream.getVideoTracks()[0];
    if (track === undefined) throw new Error('no-video-track');
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('first-frame-timeout')), 3_000);
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) done();
      else video.onloadeddata = () => done();
    });
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx === null) throw new Error('canvas-unavailable');
    track.addEventListener('ended', () => entries.delete(displayId));
    entries.set(displayId, { stream, video, canvas, ctx });
    return { ok: true, width: video.videoWidth, height: video.videoHeight };
  } catch (error) {
    if (stream !== undefined) for (const track of stream.getTracks()) track.stop();
    return { ok: false, width: 0, height: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

function grab(displayId: string): GrabResult {
  const entry = entries.get(displayId);
  if (entry === undefined) throw new Error('stream-missing');
  entry.ctx.drawImage(entry.video, 0, 0);
  const image = entry.ctx.getImageData(0, 0, entry.canvas.width, entry.canvas.height);
  return { width: image.width, height: image.height, data: new Uint8Array(image.data.buffer.slice(0)) };
}

declare global {
  interface Window {
    __shotCapture: ShotCaptureHost;
  }
}

window.__shotCapture = {
  startStream,
  stopStream,
  stopAll: () => {
    for (const displayId of entries.keys()) stopStream(displayId);
  },
  has: (displayId: string) => entries.has(displayId),
  grab,
};

export {};
