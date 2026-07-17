const fs = require('fs');
const path = require('path');
const dir = 'd:/kimi/kimi-code/apps/kimi-code/dist/chunks';
const files = fs.readdirSync(dir);
for (const f of files) {
  const c = fs.readFileSync(path.join(dir, f), 'utf8');
  if (c.includes('stripOpenAISdk') || c.includes('xiaomimimo') || c.includes('mimocode-cli-free')) {
    console.log(f, '=> stripOpenAISdk:', c.includes('stripOpenAISdk'), 'xiaomimimo:', c.includes('xiaomimimo'), 'mimocode-cli-free:', c.includes('mimocode-cli-free'));
  }
}
console.log('done scanning', files.length, 'files');
