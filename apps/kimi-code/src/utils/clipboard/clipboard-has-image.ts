import { isFileLikeNativeFormat, safeAvailableFormats } from './clipboard-common';
import { clipboard, type ClipboardModule } from './clipboard-native';

async function hasImageViaNative(clip: ClipboardModule | null): Promise<boolean> {
  if (clip === null) return false;

  // Finder exposes file icons/thumbnails as image data when a non-image file
  // is copied. Treat file-like clipboard contents as "not a pasteable image"
  // to match the read path in clipboard-image.ts.
  const formats = safeAvailableFormats(clip);
  if (formats.some(isFileLikeNativeFormat)) return false;

  try {
    return clip.hasImage();
  } catch {
    return false;
  }
}

export async function clipboardHasImage(options?: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  clipboard?: ClipboardModule | null;
}): Promise<boolean> {
  const env = options?.env ?? process.env;
  const platform = options?.platform ?? process.platform;
  const clip = options?.clipboard ?? clipboard;

  if (env['TERMUX_VERSION'] !== undefined) return false;

  // The focus-driven clipboard-image hint does not probe on Linux. The probe
  // would spawn wl-paste / xclip, which on Wayland perturbs seat focus and
  // re-triggers the terminal's focus event, creating a focus feedback loop
  // (window repeatedly gains/loses focus, IME candidate window cannot stay
  // focused — see issue #1090). macOS and Windows are fine: both use the
  // in-process native module, which neither spawns a subprocess nor perturbs
  // focus.
  //
  // Image *paste* is unaffected on all platforms: it reads the clipboard
  // through readClipboardMedia() on the explicit paste path, not here.
  if (platform !== 'darwin' && platform !== 'win32') return false;

  return hasImageViaNative(clip);
}
