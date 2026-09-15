import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  getCapabilities,
  getCellDimensions,
  getPngDimensions,
  renderImage,
} from '@moonshot-ai/pi-tui';
import * as QRCode from 'qrcode';

const TERMINAL_QR_MARGIN = 2;
const TERMINAL_QR_DARK = '0;0;0';
const TERMINAL_QR_LIGHT = '255;255;255';
const ANSI_RESET = '\u001B[0m';

const QR_PNG_MARGIN = 4;
const QR_IMAGE_MIN_PX_PER_MODULE = 4;

export async function generateRemoteControlQr(
  url: string,
  dataDir: string,
): Promise<{ terminal: string; pngPath: string }> {
  await mkdir(dataDir, { recursive: true });
  const pngPath = resolve(dataDir, 'rc-qrcode.png');
  const png = await QRCode.toBuffer(url, { type: 'png', margin: QR_PNG_MARGIN });
  await writeFile(pngPath, png);
  const terminal = renderInlineImageQr(url, png) ?? renderTerminalQr(url);
  return { terminal, pngPath };
}

function renderInlineImageQr(url: string, png: Buffer): string | null {
  if (getCapabilities().images === null) return null;
  const base64 = png.toString('base64');
  const dimensions = getPngDimensions(base64);
  if (dimensions === null) return null;
  const moduleCount =
    QRCode.create(url, { errorCorrectionLevel: 'M' }).modules.size + QR_PNG_MARGIN * 2;
  const maxWidthCells = Math.ceil(
    (moduleCount * QR_IMAGE_MIN_PX_PER_MODULE) / getCellDimensions().widthPx,
  );
  const rendered = renderImage(base64, dimensions, { maxWidthCells });
  return rendered === null ? null : `${rendered.sequence}\n`;
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
