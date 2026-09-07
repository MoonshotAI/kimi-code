delete process.env['KIMI_CODE_EXPERIMENTAL_FLAG'];
for (const key of Object.keys(process.env)) {
  if (key.startsWith('KIMI_CODE_EXPERIMENTAL_')) {
    delete process.env[key];
  }
}

process.env['KIMI_CODE_SEARCH_WORKER'] = 'false';

process.env['KIMI_CODE_PERSISTENCE_MINIDB_READMODEL'] = 'false';
