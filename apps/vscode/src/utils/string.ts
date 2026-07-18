export function buildCaseInsensitiveGlobLiteral(input: string) {
  let out = "";
  for (const ch of input) {
    if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z")) {
      const l = ch.toLowerCase();
      const u = ch.toUpperCase();
      out += `[${l}${u}]`;
    } else {
      if ("*?[]{}\\".includes(ch)) {
        out += "\\" + ch;
      } else {
        out += ch;
      }
    }
  }
  return out;
}
