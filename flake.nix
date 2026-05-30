{
  description = "Kimi Code CLI";

  inputs = {
    # Pinned to the 25.11 release channel because nixpkgs-unstable currently
    # ships nodejs_24 = 24.14.1, which trips the >= 24.15.0 floor that the
    # native SEA build enforces (see apps/kimi-code/scripts/native/build.mjs).
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
  };

  outputs =
    { self, nixpkgs }:
    let
      lib = nixpkgs.lib;

      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      forAllSystems =
        f:
        lib.genAttrs systems (
          system:
          f (import nixpkgs {
            inherit system;
          })
        );

      minNodeVersion = "24.15.0";
      requiredNodeMajor = "24";

      # nodejsFor picks pkgs.nodejs_24 when it satisfies the minimum, otherwise
      # falls back to pkgs.nodejs_latest. The build pipeline (tsdown target
      # `node24`, SEA flags) assumes a 24.x runtime, so we hard-fail if neither
      # candidate is in the 24.x line.
      nodejsFor =
        pkgs:
        let
          candidate =
            if lib.versionAtLeast pkgs.nodejs_24.version minNodeVersion then
              pkgs.nodejs_24
            else
              pkgs.nodejs_latest;
          major = lib.versions.major candidate.version;
        in
        if major == requiredNodeMajor then
          candidate
        else
          throw ''
            Kimi Code requires Node.js ${requiredNodeMajor}.x (>= ${minNodeVersion}),
            but nixpkgs only offers ${candidate.version}.
            Pin a newer nixpkgs revision or update minNodeVersion in flake.nix.
          '';

      pnpmFor =
        pkgs:
        pkgs.pnpm_10.override {
          nodejs = nodejsFor pkgs;
        };

      # ---------------------------------------------------------------------
      # Derive workspace members from pnpm-workspace.yaml + each package.json.
      #
      # Source of truth is pnpm-workspace.yaml's `packages:` section. We expand
      # each glob (or literal path) against the repo root, keep only entries
      # that contain a package.json, and read their `name` field. Both the
      # `src` fileset and the `pnpmWorkspaces` filter for pnpmConfigHook are
      # derived from this list, so adding/removing a workspace only requires
      # updating pnpm-workspace.yaml (followed by `nix run .#update-pnpm-deps`).
      # ---------------------------------------------------------------------

      # Minimal parser for the `packages:` list in pnpm-workspace.yaml. Only
      # handles top-level `- <entry>` items under the `packages:` key; other
      # sections (catalog, overrides) are ignored. Sufficient for the format
      # pnpm produces and we maintain.
      parsePnpmWorkspaceGlobs =
        file:
        let
          lines = lib.splitString "\n" (builtins.readFile file);
          isPackagesHeader = l: builtins.match "^packages:[[:space:]]*$" l != null;
          isTopLevelKey = l: builtins.match "^[^[:space:]#].*:.*$" l != null;
          extractItem =
            l:
            let
              m = builtins.match "^[[:space:]]+-[[:space:]]+['\"]?([^'\"#[:space:]]+)['\"]?[[:space:]]*$" l;
            in
            if m == null then null else builtins.head m;
          step =
            state: line:
            if state.done then
              state
            else if !state.inSection then
              if isPackagesHeader line then state // { inSection = true; } else state
            else
              let
                item = extractItem line;
              in
              if item != null then
                state // { items = state.items ++ [ item ]; }
              else if isTopLevelKey line then
                state // { inSection = false; done = true; }
              else
                state;
          result = lib.foldl' step {
            inSection = false;
            items = [ ];
            done = false;
          } lines;
        in
        result.items;

      expandWorkspaceGlob =
        root: glob:
        if lib.hasSuffix "/*" glob then
          let
            dir = lib.removeSuffix "/*" glob;
            absDir = root + "/${dir}";
          in
          if builtins.pathExists absDir then
            map (n: "${dir}/${n}") (
              builtins.attrNames (lib.filterAttrs (_: t: t == "directory") (builtins.readDir absDir))
            )
          else
            [ ]
        else if builtins.pathExists (root + "/${glob}") then
          [ glob ]
        else
          [ ];

      workspaceMembers =
        let
          globs = parsePnpmWorkspaceGlobs ./pnpm-workspace.yaml;
          paths = lib.unique (lib.concatMap (expandWorkspaceGlob ./.) globs);
        in
        builtins.filter (p: builtins.pathExists (./. + "/${p}/package.json")) paths;

      workspacePaths = map (p: ./. + "/${p}") workspaceMembers;

      workspaceNames = map (
        p: (builtins.fromJSON (builtins.readFile (./. + "/${p}/package.json"))).name
      ) workspaceMembers;
    in
    {
      packages = forAllSystems (
        pkgs:
        let
          nodejs = nodejsFor pkgs;
          pnpm = pnpmFor pkgs;
          appPackageJson = builtins.fromJSON (builtins.readFile ./apps/kimi-code/package.json);
          nativeTarget =
            if pkgs.stdenv.hostPlatform.isLinux && pkgs.stdenv.hostPlatform.isAarch64 then
              "linux-arm64"
            else if pkgs.stdenv.hostPlatform.isLinux then
              "linux-x64"
            else if pkgs.stdenv.hostPlatform.isDarwin && pkgs.stdenv.hostPlatform.isAarch64 then
              "darwin-arm64"
            else if pkgs.stdenv.hostPlatform.isDarwin then
              "darwin-x64"
            else
              throw "Unsupported Kimi Code native target for ${pkgs.stdenv.hostPlatform.system}";

          kimi-code = pkgs.stdenv.mkDerivation (finalAttrs: {
            pname = "kimi-code";
            version = appPackageJson.version;

            src = lib.fileset.toSource {
              root = ./.;
              fileset = lib.fileset.unions (
                [
                  ./build
                  ./.npmrc
                  ./.nvmrc
                  ./package.json
                  ./pnpm-lock.yaml
                  ./pnpm-workspace.yaml
                  ./tsconfig.json
                  ./vitest.config.ts
                  ./LICENSE
                ]
                ++ workspacePaths
              );
            };

            pnpmWorkspaces = [ "." ] ++ workspaceNames;

            pnpmDeps = pkgs.fetchPnpmDeps {
              inherit (finalAttrs) pname version src pnpmWorkspaces;
              inherit pnpm;
              fetcherVersion = 3;
              hash = "sha256-HpRlxlXZoVqAzrdMdSWhLcTRM1DvDvytVbzIGBo8QUo=";
            };

            nativeBuildInputs = [
              nodejs
              pnpm
              (pkgs.pnpmConfigHook.override { inherit pnpm; })
            ]
            # The SEA inject step (postject) invalidates the macOS code
            # signature on the copied Node executable; build.mjs then re-applies
            # an ad-hoc signature via `codesign`. The Nix darwin sandbox does
            # not expose /usr/bin/codesign, so we supply nixpkgs' ad-hoc-only
            # replacement instead.
            ++ lib.optionals pkgs.stdenv.hostPlatform.isDarwin [
              pkgs.darwin.sigtool
            ];

            # The SEA binary is produced by `postject`-injecting a blob into a
            # plain Node executable. Stripping rewrites section tables and can
            # invalidate the injected blob's offsets, so leave the binary
            # untouched after the build.
            dontStrip = true;

            buildPhase = ''
              runHook preBuild
              export KIMI_CODE_BUILD_TARGET=${nativeTarget}
              ${lib.optionalString pkgs.stdenv.hostPlatform.isDarwin ''
                # pkgs.darwin.sigtool's codesign supports `--sign -` (ad-hoc)
                # but not the inspection mode (`-dv`) that 05-verify.mjs runs
                # afterwards. Disable the verify step for the Nix build; the
                # release CI keeps it via the unmodified script.
                substituteInPlace apps/kimi-code/scripts/native/build.mjs \
                  --replace-fail \
                    "await runVerifyStep({ requireGatekeeper: false });" \
                    "// runVerifyStep skipped in nix sandbox (sigtool lacks -dv)"
              ''}
              pnpm --filter=@moonshot-ai/kimi-code run build:native:sea
              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall

              install -Dm755 \
                "apps/kimi-code/dist-native/bin/${nativeTarget}/kimi" \
                "$out/bin/kimi"

              runHook postInstall
            '';

            meta = {
              description = "Kimi Code CLI";
              homepage = "https://github.com/MoonshotAI/kimi-code";
              license = lib.licenses.mit;
              mainProgram = "kimi";
              platforms = systems;
            };
          });

          # Expose pnpmDeps as a top-level package so `nix build .#kimi-code-pnpm-deps`
          # (used by the update-pnpm-deps app) is a stable selector that doesn't
          # depend on attribute drilling into a derivation.
          kimi-code-pnpm-deps = kimi-code.pnpmDeps;

          update-pnpm-deps = pkgs.writeShellApplication {
            name = "update-pnpm-deps";
            runtimeInputs = [
              pkgs.nix
              pkgs.git
              nodejs
              pkgs.gnused
              pkgs.gnugrep
              pkgs.coreutils
            ];
            text = builtins.readFile ./build/nix/update-pnpm-deps.sh;
          };
        in
        {
          inherit kimi-code kimi-code-pnpm-deps update-pnpm-deps;
          default = kimi-code;
        }
      );

      apps = forAllSystems (pkgs: {
        kimi-code = {
          type = "app";
          program = "${self.packages.${pkgs.system}.kimi-code}/bin/kimi";
        };
        update-pnpm-deps = {
          type = "app";
          program = "${self.packages.${pkgs.system}.update-pnpm-deps}/bin/update-pnpm-deps";
        };
        default = self.apps.${pkgs.system}.kimi-code;
      });

      devShells = forAllSystems (pkgs: {
        default =
          let
            nodejs = nodejsFor pkgs;
            pnpm = pnpmFor pkgs;
          in
          pkgs.mkShell {
            packages = [
              nodejs
              pnpm
            ];
          };
      });
    };
}
