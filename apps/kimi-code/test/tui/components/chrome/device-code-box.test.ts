import { describe, expect, it } from 'vitest';

import { DeviceCodeBoxComponent } from '#/tui/components/chrome/device-code-box';
import { darkColors } from '#/tui/theme/colors';

function strip(text: string): string {
  return text.replaceAll(/\[[0-9;]*m/g, '');
}

const url = 'https://www.kimi.com/code/authorize_device?user_code=N32D-W3YD';
const code = 'N32D-W3YD';
const title = 'Sign in to Kimi Code';
const hint = 'Press Ctrl-C to cancel';

describe('DeviceCodeBoxComponent', () => {
  it('renders a rounded border that frames the title, url and code', () => {
    const component = new DeviceCodeBoxComponent({
      title,
      url,
      code,
      hint,
    });

    const lines = component.render(80).map(strip);
    const joined = lines.join('\n');

    expect(lines[1]?.startsWith('╭')).toBe(true);
    expect(lines[1]?.endsWith('╮')).toBe(true);
    expect(lines.at(-2)?.startsWith('╰')).toBe(true);
    expect(lines.at(-2)?.endsWith('╯')).toBe(true);

    expect(joined).toContain(title);
    expect(joined).toContain(url);
    expect(joined).toContain(code);
    expect(joined).toContain(hint);
    expect(joined).toContain('Verification code');
  });

  it('truncates long urls when the terminal is narrow', () => {
    const component = new DeviceCodeBoxComponent({
      title,
      url,
      code,
    });

    const lines = component.render(40).map(strip);
    const urlLine = lines.find((line) => line.includes('https://'));
    expect(urlLine).toBeDefined();
    expect(urlLine).toContain('…');
    expect(urlLine?.length).toBeLessThanOrEqual(40);
  });

  it('omits the hint row when no hint is provided', () => {
    const component = new DeviceCodeBoxComponent({
      title,
      url,
      code,
    });

    const joined = component.render(80).map(strip).join('\n');
    expect(joined).not.toContain('Press Ctrl-C');
  });
});
