(function () {
  try {
    var v = localStorage.getItem('kimi-web.color-scheme');
    if (v === 'light' || v === 'dark' || v === 'system') {
      document.documentElement.dataset.colorScheme = v;
    }
    // Font scale, with the same migration rules as useAppearance (app-core):
    // the retired 'xxlarge' lands on 'xlarge', and a legacy px key maps onto
    // the nearest step — seeded pre-paint so a non-Medium user never flashes
    // the Medium scale before the bundle runs.
    var fs = localStorage.getItem('kimi-web.font-scale');
    if (fs === 'xxlarge') fs = 'xlarge';
    if (fs !== 'small' && fs !== 'medium' && fs !== 'large' && fs !== 'xlarge') {
      var legacy = localStorage.getItem('kimi-web.ui-font-size');
      var px = Number(legacy);
      fs =
        legacy !== null && isFinite(px)
          ? px <= 13
            ? 'small'
            : px <= 15
              ? 'medium'
              : px <= 17
                ? 'large'
                : 'xlarge'
          : 'medium';
    }
    document.documentElement.dataset.fontScale = fs;
  } catch {
    /* ignore */
  }
})();
