// Probe: does the CLI wiring actually produce a Rust RunTurnOverride with
// the user's real config (same resolution path as `kimi -p`)?
import { maybeLoadRustEngine } from './src/cli/rust-engine';

const override = await maybeLoadRustEngine();
console.log('maybeLoadRustEngine =>', override === undefined ? 'undefined (JS engine)' : typeof override);
