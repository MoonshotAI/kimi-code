

export function encodeWireComponent(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (code > 0x7f || /[A-Za-z0-9\-._~]/.test(ch)) {
      out += ch;
    } else {
      out += `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

export function escapeLinkDest(value: string): string {
  const parts = value.split('/');
  const dest = parts
    .map((part, index) => {
      if (index !== 0) return encodeWireComponent(part);
      const drive = /^([A-Za-z]:)(\\.*)?$/.exec(part);
      if (drive === null || (drive[2] === undefined && parts.length === 1)) return encodeWireComponent(part);
      return drive[1] + encodeWireComponent(drive[2] ?? '');
    })
    .join('/');

  if (dest.startsWith('//')) return `/%2F${dest.slice(2)}`;
  return dest;
}

export function escapeLinkText(value: string): string {
  return value
    .replace(/%/g, '%25')
    .replace(/&/g, '%26')
    .replace(/</g, '%3C')
    .replace(/>/g, '%3E')
    .replace(/([\\[\]])/g, '\\$1')
    .replace(/\n/g, '%0A')
    .replace(/\r/g, '%0D');
}

export function unescapeLinkText(value: string): string {
  return value
    .replace(/\\([\\[\]])/g, '$1')
    .replace(/%0A/g, '\n')
    .replace(/%0D/g, '\r')
    .replace(/%26/g, '&')
    .replace(/%3C/g, '<')
    .replace(/%3E/g, '>')
    .replace(/%25/g, '%');
}

export function unescapeRenderedLinkText(value: string): string {
  return value
    .replace(/%0A/g, '\n')
    .replace(/%0D/g, '\r')
    .replace(/%26/g, '&')
    .replace(/%3C/g, '<')
    .replace(/%3E/g, '>')
    .replace(/%25/g, '%');
}

export function unescapeLinkDest(value: string, angle: boolean): string {
  const dest = angle ? value.replace(/\\([\\<>])/g, '$1') : value.replace(/\\([\\()])/g, '$1');
  return decodeURIComponentOrRaw(dest);
}

export function decodeURIComponentOrRaw(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
