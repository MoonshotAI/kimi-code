const fs = require('fs');
const c = fs.readFileSync('d:/kimi/kimi-code/apps/kimi-code/dist-native/intermediates/main.cjs', 'utf8');
console.log('size:', c.length);
console.log('has stripOpenAISdk:', c.includes('stripOpenAISdk'));
console.log('has xiaomimimo:', c.includes('xiaomimimo'));
console.log('has mimocode-cli-free:', c.includes('mimocode-cli-free'));
console.log('has X-Stainless:', c.includes('X-Stainless'));
console.log('has x-stainless:', c.includes('x-stainless'));
