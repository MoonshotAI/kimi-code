export const WEBBRIDGE_EXTENSION_LINKS = {
  chrome: {
    label: 'Chrome',
    url: 'https://chromewebstore.google.com/detail/kimi-webbridge/fldmhceldgbpfpkbgopacenieobmligc',
  },
  edge: {
    label: 'Edge',
    url: 'https://microsoftedge.microsoft.com/addons/detail/kimi-webbridge/bnlffdbcfnanfbknnlaflhlhkocccckg',
  },
} as const;

export type WebBridgeBrowser = keyof typeof WEBBRIDGE_EXTENSION_LINKS;

export const WEBBRIDGE_EXTENSION_GUIDE_URL =
  'https://www.kimi.com/code/docs/kimi-code-cli/customization/plugins.html#install-the-browser-extension';
