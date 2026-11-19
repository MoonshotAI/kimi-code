export interface ImageSource {
  start: number;
  end: number;
  src: string;
}

function characterPositions(text: string, character: string): number[] {
  const positions: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === character) positions.push(i);
  }
  return positions;
}

export function imageSources(text: string): ImageSource[] {
  const sources: ImageSource[] = [];
  const angleCloses = characterPositions(text, '>');
  const lineEnds = characterPositions(text, '\n');
  let angleCursor = 0;
  let lineCursor = 0;
  let labelClose = -1;
  let destinationClose = -1;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '!' || text[i + 1] !== '[') continue;
    if (labelClose < i + 2) labelClose = text.indexOf(']', i + 2);
    if (labelClose === -1) break;
    if (text[labelClose + 1] !== '(') {
      i = labelClose;
      continue;
    }
    let start = labelClose + 2;
    if (destinationClose < start) destinationClose = text.indexOf(')', start);
    if (destinationClose === -1) break;
    while (start < destinationClose && /\s/.test(text[start]!)) start += 1;
    let end = start;
    while (angleCursor < angleCloses.length && angleCloses[angleCursor]! <= start) angleCursor += 1;
    while (lineCursor < lineEnds.length && lineEnds[lineCursor]! < start) lineCursor += 1;
    const angleClose = text[start] === '<' ? angleCloses[angleCursor] ?? -1 : -1;
    const lineEnd = lineEnds[lineCursor] ?? text.length;
    if (angleClose !== -1 && angleClose < lineEnd) {
      destinationClose = text.indexOf(')', angleClose + 1);
      if (destinationClose === -1) break;
      start += 1;
      end = angleClose;
    } else {
      while (end < destinationClose && !/\s/.test(text[end]!)) end += 1;
    }
    if (end > start) sources.push({ start, end, src: text.slice(start, end) });
    i = destinationClose;
  }
  const htmlSources: ImageSource[] = [];
  let tagEnd = -1;
  const tags = /<img\b/gi;
  while (tags.exec(text) !== null) {
    if (tagEnd < tags.lastIndex) tagEnd = text.indexOf('>', tags.lastIndex);
    if (tagEnd === -1) break;
    const tag = text.slice(tags.lastIndex, tagEnd);
    for (const src of tag.matchAll(/\bsrc="/gi)) {
      const start = tags.lastIndex + src.index + src[0].length;
      const end = text.indexOf('"', start);
      if (end === -1) break;
      if (end === start) continue;
      htmlSources.push({ start, end, src: text.slice(start, end) });
      tagEnd = Math.max(tagEnd, end);
      break;
    }
    tags.lastIndex = tagEnd + 1;
  }
  const merged: ImageSource[] = [];
  let markdownIndex = 0;
  let htmlIndex = 0;
  while (markdownIndex < sources.length || htmlIndex < htmlSources.length) {
    const markdown = sources[markdownIndex];
    const html = htmlSources[htmlIndex];
    if (markdown && (!html || markdown.start <= html.start)) {
      merged.push(markdown);
      markdownIndex += 1;
    } else if (html) {
      merged.push(html);
      htmlIndex += 1;
    }
  }
  return merged;
}

export function rewriteImageSources(text: string, sources: readonly ImageSource[], resolve: (src: string) => string | null): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const source of sources) {
    if (source.start < cursor) continue;
    const next = resolve(source.src);
    if (next === null) continue;
    parts.push(text.slice(cursor, source.start), next);
    cursor = source.end;
  }
  return parts.join('') + text.slice(cursor);
}
