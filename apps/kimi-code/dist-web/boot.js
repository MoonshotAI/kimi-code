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
    var fp = localStorage.getItem('kimi-web.fonts');
    if (fp) {
      var fpGeneric = { serif: 1, 'sans-serif': 1, monospace: 1, cursive: 1, fantasy: 1, 'ui-serif': 1, 'ui-rounded': 1, emoji: 1, math: 1, fangsong: 1 };
      var fpKeyword = { '-apple-system': 1, blinkmacsystemfont: 1, 'system-ui': 1, 'ui-sans-serif': 1, 'ui-monospace': 1 };
      var fpVars = {
        ui: ['--user-font-ui', '--base-font'],
        transcript: ['--user-font-transcript', '--user-transcript-size'],
        code: ['--user-font-mono', '--user-code-size'],
        terminal: ['--user-font-terminal', '--user-terminal-size'],
      };
      var fpKimi = {
        ui: ['Schibsted Grotesk Variable', 'Noto Sans SC Variable'],
        transcript: ['Schibsted Grotesk Variable', 'Noto Sans SC Variable'],
        code: ['JetBrains Mono Variable'],
        terminal: ['JetBrains Mono Variable'],
      };
      var fpPrefs = JSON.parse(fp);
      var st = document.documentElement.style;
      var fpRow = function (target) {
        var r = fpPrefs[target];
        return r && typeof r === 'object' ? r : {};
      };
      var fpList = function (r) {
        var fams = Array.isArray(r.families) ? r.families : typeof r.family === 'string' && r.family !== '' ? [r.family] : [];
        var out = [];
        for (var fi = 0; fi < fams.length; fi++) {
          if (typeof fams[fi] !== 'string') continue;
          var fam = fams[fi].replace(/["\\]/g, '').trim();
          if (fpGeneric[fam.toLowerCase()]) break;
          if (fam !== '') out.push(fam);
        }
        return out;
      };
      var fpMode = function (target, r) {
        var followable = target === 'transcript' || target === 'terminal';
        if (r.mode === 'system' || r.mode === 'kimi' || r.mode === 'custom') return r.mode;
        if (r.mode === 'same') return followable ? 'same' : 'system';
        if (followable && r.follow !== false) return 'same';
        return fpList(r).length > 0 ? 'custom' : 'system';
      };
      var fpFamilies = function (target, r) {
        var m = fpMode(target, r);
        if (m === 'kimi') return fpKimi[target];
        if (m === 'custom') return fpList(r);
        return [];
      };
      for (var target in fpVars) {
        var p = fpRow(target);
        var src = { transcript: 'ui', terminal: 'code' }[target];
        var same = src && fpMode(target, p) === 'same';
        var q = same ? fpRow(src) : p;
        var fams = fpFamilies(same ? src : target, q);
        var vars = fpVars[target];
        var famList = [];
        for (var fj = 0; fj < fams.length; fj++) {
          famList.push(fpKeyword[fams[fj].toLowerCase()] ? fams[fj] : '"' + fams[fj] + '"');
        }
        if (famList.length > 0) st.setProperty(vars[0], famList.join(', '));
        if (target === 'terminal' && typeof p.size === 'number' && isFinite(p.size)) st.setProperty(vars[1], p.size + 'px');
      }
    }
  } catch {
    /* ignore */
  }
})();
