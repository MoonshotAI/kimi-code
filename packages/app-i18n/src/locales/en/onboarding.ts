export default {
  continue: 'Continue',
  back: 'Back',
  skip: 'Skip',
  welcome: {
    title: 'Welcome to Kimi Code',
    subtitle: 'The AI coding workbench for professional developers',
    languageLabel: 'Language',
    themeLabel: 'Appearance',
  },
  login: {
    title: 'Configure Model',
    subtitle: 'Choose the model service that powers Kimi Code. You can change it later in Settings',
    // Single-card fallback (shown when the daemon predates region support;
    // starts the flow without a region)
    kimiTitle: 'Sign in with Kimi',
    kimiHint: 'Ready out of the box with Kimi membership benefits',
    kimiCnTitle: 'Kimi Code',
    kimiCnHint: 'Sign in with your kimi.com account',
    kimiOverseasTitle: 'Kimi Code',
    kimiOverseasHint: 'Sign in with your kimi.ai account',
    customProviderTitle: 'Add a custom provider',
    customProviderHint: 'Bring your own API key for OpenAI-compatible and other services',
    loggedInTitle: 'Logged in with Kimi',
    loggedInHint: 'Your model service is ready to use',
    finish: 'Finish',
    skip: 'Skip for now',
  },
} as const;
