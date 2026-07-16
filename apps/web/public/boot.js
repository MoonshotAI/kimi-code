(function () {
  try {
    var v = localStorage.getItem('kimi-web.color-scheme');
    if (v === 'light' || v === 'dark' || v === 'system') {
      document.documentElement.dataset.colorScheme = v;
    }
  } catch {
    /* ignore */
  }
})();
