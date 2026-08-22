import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import * as QRCode from 'qrcode';

export async function generateRemoteControlQr(
  url: string,
  dataDir: string,
): Promise<{ terminal: string; pngPath: string }> {
  await mkdir(dataDir, { recursive: true });
  const pngPath = resolve(dataDir, 'rc-qrcode.png');
  const [terminal] = await Promise.all([
    QRCode.toString(url, { type: 'terminal', small: true }),
    QRCode.toFile(pngPath, url, { type: 'png' }),
  ]);
  return { terminal, pngPath };
}
