const fs = require('fs');
const c = fs.readFileSync('d:/kimi/kimi-code/apps/kimi-code/dist-native/intermediates/main.cjs', 'utf8');
const m = c.match(/stripOpenAISdk/g);
console.log('stripOpenAISdk occurrences:', m ? m.length : 0);
const m2 = c.match(/x-mimo-source/gi);
console.log('x-mimo-source occurrences:', m2 ? m2.length : 0);
const m3 = c.match(/mimocode-cli-free/gi);
console.log('mimocode-cli-free occurrences:', m3 ? m3.length : 0);
