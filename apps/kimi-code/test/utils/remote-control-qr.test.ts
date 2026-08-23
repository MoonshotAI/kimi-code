import { describe, expect, it } from 'vitest';

import * as QRCode from 'qrcode';

import { renderTerminalQr } from '#/utils/remote-control-qr';

const RESET = '\u001B[0m';
const WHITE_CELL = '\u001B[38;2;255;255;255m\u001B[48;2;255;255;255m▀';

describe('renderTerminalQr', () => {
  it('renders truecolor black-on-white half blocks with a white quiet zone', () => {
    const url = 'https://example.test/rc/entry';
    const output = renderTerminalQr(url);
    const size = QRCode.create(url, { errorCorrectionLevel: 'M' }).modules.size;
    const width = size + 4;

    expect(output).toContain('\u001B[38;2;0;0;0m');
    expect(output).not.toContain('\u001B[40m');
    expect(output).not.toContain('\u001B[47m');
    expect(output).not.toContain('\u001B[30m');
    expect(output).not.toContain('\u001B[37m');
    expect(output.endsWith(RESET)).toBe(true);

    const lines = output.split('\n');
    expect(lines.at(-1)).toBe(RESET);
    const rows = lines.slice(0, -1);
    expect(rows.length).toBe(Math.ceil((size + 4) / 2));
    for (const row of rows) {
      expect(row.startsWith(WHITE_CELL.repeat(2))).toBe(true);
      expect(row.endsWith(`${WHITE_CELL.repeat(2)}${RESET}`)).toBe(true);
      expect(row.split('▀').length - 1).toBe(width);
    }
    expect(rows[0]).toBe(`${WHITE_CELL.repeat(width)}${RESET}`);
    expect(rows.at(-1)).toBe(`${WHITE_CELL.repeat(width)}${RESET}`);
  });

  it('renders different output for different URLs', () => {
    expect(renderTerminalQr('https://example.test/a')).not.toBe(
      renderTerminalQr('https://example.test/b'),
    );
  });
});
