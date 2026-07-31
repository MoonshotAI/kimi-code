// Probe: can the dev CLI's module graph load the Rust adapter?
import('@moonshot-ai/kimi-agent/rust-loop')
  .then((m) => {
    console.log('IMPORT OK, createRunTurnOverride =', typeof m.createRunTurnOverride);
    try {
      const override = m.createRunTurnOverride(undefined, process.cwd(), { nativeTools: true });
      console.log('createRunTurnOverride() =>', typeof override);
    } catch (error) {
      console.error('CREATE FAIL:', error instanceof Error ? error.message : String(error));
    }
  })
  .catch((error) => {
    console.error('IMPORT FAIL:', error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack) console.error(error.stack.split('\n').slice(0, 6).join('\n'));
  });
