import { isFileLikeNativeFormat, safeAvailableFormats } from './clipboard-common';
import { clipboard, type ClipboardModule } from './clipboard-native';

async function hasImageViaNative(clip: ClipboardModule | null): Promise<boolean> {
  if (clip === null) return false;

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

  if (platform !== 'darwin' && platform !== 'win32') return false;

  return hasImageViaNative(clip);
}
