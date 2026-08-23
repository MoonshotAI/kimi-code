import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import * as QRCode from 'qrcode';

const TERMINAL_QR_MARGIN = 2;
const TERMINAL_QR_DARK = '0;0;0';
const TERMINAL_QR_LIGHT = '255;255;255';
const ANSI_RESET = '\u001B[0m';

export async function generateRemoteControlQr(
  url: string,
  dataDir: string,
): Promise<{ terminal: string; pngPath: string }> {
  await mkdir(dataDir, { recursive: true });
  const pngPath = resolve(dataDir, 'rc-qrcode.png');
  const terminal = renderTerminalQr(url);
  await QRCode.toFile(pngPath, url, { type: 'png' });
  return { terminal, pngPath };
}

export function renderTerminalQr(url: string): string {
  const qr = QRCode.create(url, { errorCorrectionLevel: 'M' });
  const size: number = qr.modules.size;
  const data: Uint8Array = qr.modules.data;
  const isDark = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < size && y < size && data[y * size + x] === 1;
  let output = '';
  for (let y = -TERMINAL_QR_MARGIN; y < size + TERMINAL_QR_MARGIN; y += 2) {
    for (let x = -TERMINAL_QR_MARGIN; x < size + TERMINAL_QR_MARGIN; x++) {
      const top = isDark(x, y) ? TERMINAL_QR_DARK : TERMINAL_QR_LIGHT;
      const bottom = isDark(x, y + 1) ? TERMINAL_QR_DARK : TERMINAL_QR_LIGHT;
      output += `\u001B[38;2;${top}m\u001B[48;2;${bottom}m▀`;
    }
    output += `${ANSI_RESET}\n`;
  }
  return output + ANSI_RESET;
}
