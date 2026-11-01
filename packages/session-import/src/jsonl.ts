import { createReadStream } from 'node:fs';
import { createZstdDecompress } from 'node:zlib';
import { StringDecoder } from 'node:string_decoder';

export async function* readJsonLines(path: string): AsyncGenerator<string> {
  const file = createReadStream(path);
  const decompressor = path.endsWith('.zst') ? createZstdDecompress() : undefined;
  const stream = decompressor ? file.pipe(decompressor) : file;
  if (decompressor) file.on('error', error => decompressor.destroy(error));
  const decoder = new StringDecoder('utf8');
  let fragments: string[] = [];
  try {
    for await (const buffer of stream) {
      const chunk = decoder.write(buffer);
      let start = 0;
      for (let end = chunk.indexOf('\n'); end >= 0; end = chunk.indexOf('\n', start)) {
        fragments.push(chunk.slice(start, end));
        let line = fragments.join('');
        if (line.endsWith('\r')) line = line.slice(0, -1);
        yield line;
        fragments = [];
        start = end + 1;
      }
      if (start < chunk.length) fragments.push(chunk.slice(start));
    }
    const tail = decoder.end();
    if (tail) fragments.push(tail);
    if (fragments.length > 0) yield fragments.join('');
  } finally {
    file.destroy();
    decompressor?.destroy();
  }
}
