interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

interface Lab {
  readonly l: number;
  readonly a: number;
  readonly b: number;
}

const D65_WHITE = { x: 0.95047, y: 1, z: 1.08883 } as const;
const LIGHTNESS_STEPS = [5, 4, 3, 2, 1, 0] as const;
const MIN_TEXT_CONTRAST = 4.5;

export function deriveHoverBackground(backgroundHex: string, foregroundHex: string): string {
  const background = parseHex(backgroundHex);
  const foreground = parseHex(foregroundHex);
  const base = rgbToLab(background);
  const direction = base.l < 50 ? 1 : -1;
  const requiredContrast = Math.min(MIN_TEXT_CONTRAST, contrastRatio(background, foreground));

  for (const step of LIGHTNESS_STEPS) {
    const candidate = labToRgbInGamut({
      l: clamp(base.l + direction * step, 0, 100),
      a: base.a,
      b: base.b,
    });
    if (contrastRatio(candidate, foreground) >= requiredContrast) return rgbToHex(candidate);
  }
  return backgroundHex.toUpperCase();
}

function parseHex(hex: string): Rgb {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) throw new Error(`Expected a six-digit hex color: ${hex}`);
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

function rgbToHex(rgb: Rgb): string {
  const channel = (value: number): string =>
    Math.round(clamp(value, 0, 255)).toString(16).padStart(2, '0').toUpperCase();
  return `#${channel(rgb.r)}${channel(rgb.g)}${channel(rgb.b)}`;
}

function rgbToLab(rgb: Rgb): Lab {
  const r = srgbToLinear(rgb.r);
  const g = srgbToLinear(rgb.g);
  const b = srgbToLinear(rgb.b);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / D65_WHITE.x;
  const y = (0.2126729 * r + 0.7151522 * g + 0.072175 * b) / D65_WHITE.y;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / D65_WHITE.z;
  const fx = labCurve(x);
  const fy = labCurve(y);
  const fz = labCurve(z);
  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

function labToRgbInGamut(lab: Lab): Rgb {
  for (let step = 10; step >= 0; step -= 1) {
    const scale = step / 10;
    const rgb = labToRgb({ l: lab.l, a: lab.a * scale, b: lab.b * scale });
    if ([rgb.r, rgb.g, rgb.b].every((channel) => channel >= -0.00001 && channel <= 255.00001)) {
      return rgb;
    }
  }
  return labToRgb({ l: lab.l, a: 0, b: 0 });
}

function labToRgb(lab: Lab): Rgb {
  const fy = (lab.l + 16) / 116;
  const fx = fy + lab.a / 500;
  const fz = fy - lab.b / 200;
  const x = D65_WHITE.x * labCurveInverse(fx);
  const y = D65_WHITE.y * labCurveInverse(fy);
  const z = D65_WHITE.z * labCurveInverse(fz);
  return {
    r: linearToSrgb(3.2404542 * x - 1.5371385 * y - 0.4985314 * z),
    g: linearToSrgb(-0.969266 * x + 1.8760108 * y + 0.041556 * z),
    b: linearToSrgb(0.0556434 * x - 0.2040259 * y + 1.0572252 * z),
  };
}

function labCurve(value: number): number {
  const epsilon = 216 / 24389;
  const kappa = 24389 / 27;
  return value > epsilon ? Math.cbrt(value) : (kappa * value + 16) / 116;
}

function labCurveInverse(value: number): number {
  const epsilon = 216 / 24389;
  const kappa = 24389 / 27;
  const cube = value ** 3;
  return cube > epsilon ? cube : (116 * value - 16) / kappa;
}

function contrastRatio(first: Rgb, second: Rgb): number {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function relativeLuminance(rgb: Rgb): number {
  return (
    0.2126 * srgbToLinear(rgb.r) +
    0.7152 * srgbToLinear(rgb.g) +
    0.0722 * srgbToLinear(rgb.b)
  );
}

function srgbToLinear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number): number {
  const channel = value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
  return channel * 255;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
