(function () {
  try {
    var v = localStorage.getItem('kimi-web.color-scheme');
    if (v === 'light' || v === 'dark' || v === 'system') {
      document.documentElement.dataset.colorScheme = v;

      var light = document.querySelector('link[rel="manifest"][href="/manifest-light.json"]');
      var dark = document.querySelector('link[rel="manifest"][href="/manifest-dark.json"]');
      if (light && dark) {
        if (v === 'system') {
          light.media = '(prefers-color-scheme: light)';
          dark.media = '(prefers-color-scheme: dark)';
        } else if (v === 'light') {
          light.media = '';
          dark.media = 'not all';
        } else {
          light.media = 'not all';
          dark.media = '';
        }
      }
    }
  } catch {
    /* ignore */
  }
})();
