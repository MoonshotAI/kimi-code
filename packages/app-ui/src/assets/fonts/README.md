# Generated variable fonts

The WOFF2 files in this directory are generated locally and ignored by Git.
Run `pnpm prepare:fonts`, or start/build either app, to download the complete
variable TTFs from Google Fonts and convert them with `woff2-encoder`. Vite
then bundles the generated files into both the web build and the Electron app.

The UI font bundle includes:

- Schibsted Grotesk Variable (`wght` 400–900, normal and italic)

Noto Sans SC Variable (`wght` 100–900) is the Simplified Chinese fallback.

Sources:

- https://github.com/google/fonts/tree/main/ofl/notosanssc
- https://github.com/google/fonts/tree/main/ofl/schibstedgrotesk

- Source TTF SHA-256: `a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da`
- Generated WOFF2 SHA-256: `43c2f58299a21aaa962886e536c9e69f3c284f6cb6be39c57ce54a89d05205aa`
- License: all downloaded Google Fonts families use the SIL Open Font License
  1.1. The full license text is in `NotoSansSC-OFL.txt`; family copyright and
  reserved-name notices remain embedded in each generated font.
