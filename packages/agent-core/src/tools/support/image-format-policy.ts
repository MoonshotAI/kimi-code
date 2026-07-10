/**
 * Provider-accepted image formats — the single source of truth.
 *
 * Model providers accept only PNG, JPEG, GIF, and WebP image blocks. An
 * `image_url` part carrying any other MIME (AVIF, HEIC, BMP, TIFF, ICO, …)
 * is rejected by the API — and because prompts and tool results persist in
 * the session history, that one part makes every subsequent request fail
 * too ("session poisoning"). Every ingestion point therefore refuses
 * unsupported formats instead of passing the bytes through: ReadMediaFile
 * refuses with a conversion command the model can run, and prompt/MCP
 * ingestion replaces the image with a text notice.
 *
 * The policy is deliberately a closed set, not a denylist: a format is only
 * ever sent when it is known to be accepted. Supporting a new format means
 * adding it to {@link MODEL_ACCEPTED_IMAGE_MIMES}; tailoring the refusal
 * guidance for a newly-seen unsupported format means adding one row to
 * {@link UNSUPPORTED_IMAGE_FORMATS}.
 *
 * Inbound MIME strings are normalized for the DECISION
 * ({@link normalizeImageMime}: case, whitespace, `image/jpg`), but every
 * call site must forward the CANONICAL MIME into the session — strict
 * provider whitelists (e.g. Anthropic's) reject the raw alias, which would
 * re-create the very session poisoning this module exists to prevent.
 *
 * Scope: only inline `data:` images can be gated. A remote http(s) image URL
 * (an MCP `resource_link`, a REST `source.kind: 'url'` part) carries no
 * bytes to inspect, and providers that support URL images fetch them
 * server-side; those pass through unchanged.
 */

/** Image MIME types every provider accepts. The closed set. */
export const MODEL_ACCEPTED_IMAGE_MIMES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/** Human-readable list of the accepted formats, for notices. */
const ACCEPTED_FORMATS_TEXT = 'PNG, JPEG, GIF, and WebP';

interface UnsupportedImageFormatInfo {
  /**
   * A format-specific Linux decoder named in the conversion guidance (e.g.
   * heif-convert for HEIC/HEIF). Other OSes, and formats without a dedicated
   * decoder, are guided to sips (macOS) or ImageMagick.
   */
  readonly linuxDecoder?: { readonly command: string; readonly packageName: string };
}

/**
 * Unsupported formats worth tailoring the guidance for, by normalized MIME.
 * A missing entry still means "refuse" — the entry only adds a
 * format-specific conversion hint.
 */
const UNSUPPORTED_IMAGE_FORMATS: Readonly<Record<string, UnsupportedImageFormatInfo>> =
  Object.freeze({
    'image/avif': {},
    'image/heic': { linuxDecoder: { command: 'heif-convert', packageName: 'libheif-examples' } },
    'image/heif': { linuxDecoder: { command: 'heif-convert', packageName: 'libheif-examples' } },
    'image/bmp': {},
    'image/tiff': {},
    'image/x-icon': {},
  });

/** Lowercase + `image/jpg` alias normalization. */
export function normalizeImageMime(mimeType: string): string {
  const lower = mimeType.trim().toLowerCase();
  return lower === 'image/jpg' ? 'image/jpeg' : lower;
}

/**
 * Parse an image `data:` URL into its MIME and base64 payload. The MIME is
 * returned raw — callers decide via {@link isModelAcceptedImageMime} and
 * forward {@link normalizeImageMime}. MIME parameters are tolerated and
 * ignored (`data:image/avif;charset=utf-8;base64,…`), so a parameter-bearing
 * URL cannot slip past the format gate. The scheme and `base64` marker are
 * matched case-insensitively (RFC 2045 encoding names are case-insensitive),
 * so an uppercase `;BASE64,` cannot slip past either — and since callers
 * rebuild to the canonical URL, the marker comes back out lowercase.
 * Returns null for non-data URLs (e.g. a remote http(s) image — see the
 * scope note in the module header).
 */
export function parseImageDataUrl(url: string): { mimeType: string; base64: string } | null {
  const match = /^data:([^;,]+)(?:;[^;,]+)*?;base64,(.*)$/si.exec(url);
  if (match === null) return null;
  return { mimeType: match[1]!, base64: match[2]! };
}

/**
 * Whether an image with this MIME may be sent to the model. Only the closed
 * accepted set passes; everything else must be refused at the entry point —
 * once an unsupported `image_url` lands in the session history, every later
 * request in the session is rejected by the provider.
 */
export function isModelAcceptedImageMime(mimeType: string): boolean {
  return MODEL_ACCEPTED_IMAGE_MIMES.has(normalizeImageMime(mimeType));
}

/**
 * Refusal for an unsupported image that has a readable file path, with a
 * conversion command matching the execution environment (`kaos.osEnv.osKind`
 * — where Bash actually runs, so SSH/container sessions get the right command
 * too). The model can run the command through Bash (under the normal
 * permission flow) and read the converted file.
 *
 * macOS converts with the built-in `sips`; Linux and Windows have no built-in
 * decoder for these formats, so the guidance names ImageMagick (plus the
 * format's dedicated Linux decoder when one exists, e.g. heif-convert).
 */
export function buildImageConversionGuidance(
  path: string,
  mimeType: string,
  osKind: string,
): string {
  const converted = path.replace(/\.[^./\\]+$/, '') + '.jpg';
  return (
    `"${path}" is an ${mimeType} image, which the provider does not accept. ` +
    'Convert it to JPEG first, then read the converted file. ' +
    imageConversionCommand(
      path,
      converted,
      osKind,
      UNSUPPORTED_IMAGE_FORMATS[normalizeImageMime(mimeType)],
    )
  );
}

function imageConversionCommand(
  path: string,
  converted: string,
  osKind: string,
  format: UnsupportedImageFormatInfo | undefined,
): string {
  const magick = `magick "${path}" "${converted}"`;
  const linuxDecoder = format?.linuxDecoder;
  switch (osKind) {
    case 'macOS':
      return `On macOS: sips -s format jpeg "${path}" --out "${converted}"`;
    case 'Linux':
      return linuxDecoder === undefined
        ? `On Linux, with ImageMagick: ${magick}`
        : `On Linux: ${linuxDecoder.command} "${path}" "${converted}" ` +
            `(package ${linuxDecoder.packageName}), or with ImageMagick: ${magick}`;
    case 'Windows':
      return (
        `On Windows, with ImageMagick: ${magick} ` +
        '(install it first if missing: winget install ImageMagick.ImageMagick)'
      );
    default:
      return (
        `Options: sips -s format jpeg "${path}" --out "${converted}" (macOS)` +
        (linuxDecoder === undefined
          ? ''
          : `, ${linuxDecoder.command} "${path}" "${converted}" ` +
            `(Linux, package ${linuxDecoder.packageName})`) +
        `, or ${magick} (ImageMagick)`
      );
  }
}

/**
 * Short notice standing in for an unsupported image where there is no file
 * path to point at (MCP tool results, prompt uploads): the image part is
 * dropped and this text replaces it, so the model knows what happened and
 * the session history stays free of formats the provider rejects.
 */
export function buildUnsupportedImageNotice(mimeType: string, name?: string): string {
  const what =
    name === undefined || name.length === 0
      ? `unsupported image format ${mimeType}`
      : `"${name}" uses unsupported image format ${mimeType}`;
  return (
    `[Image omitted: ${what}. Model providers accept only ${ACCEPTED_FORMATS_TEXT} — ` +
    'convert it to PNG or JPEG and try again.]'
  );
}
