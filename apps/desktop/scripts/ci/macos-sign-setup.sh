#!/usr/bin/env bash
# macOS signing setup for GitLab CI — translated from the kimi-code repo's
# .github/actions/macos-keychain-setup composite action.
#
# This script must be SOURCED from a job's before_script so the exported
# variables reach the packaging step:
#
#   before_script:
#     - source apps/desktop/scripts/ci/macos-sign-setup.sh
#
# Behavior:
#   - DESKTOP_SIGN_MACOS != "true"  -> export unsigned-build env and return.
#   - DESKTOP_SIGN_MACOS == "true"  -> create a temporary keychain with the
#     Developer ID Application certificate, discover the signing identity, and
#     export the env contract that apps/desktop/electron-builder.config.cjs
#     expects (CSC_*, KIMI_DESKTOP_NOTARIZE, APPLE_API_KEY*).
#
# Required CI/CD variables when signing:
#   APPLE_CERTIFICATE_P12          base64-encoded .p12
#   APPLE_CERTIFICATE_PASSWORD     .p12 password
#   APPLE_NOTARIZATION_KEY_P8      base64-encoded App Store Connect API key
#   APPLE_NOTARIZATION_KEY_ID      API key id
#   APPLE_NOTARIZATION_ISSUER_ID   issuer id (UUID)
#
# Must be paired with macos-sign-cleanup.sh in after_script (it restores the
# runner's original default keychain + search list and deletes the temp one —
# important on persistent self-hosted runners).

if [ "${DESKTOP_SIGN_MACOS:-false}" != "true" ]; then
  echo "DESKTOP_SIGN_MACOS != true: building unsigned (no notarization)."
  export CSC_IDENTITY_AUTO_DISCOVERY=false
  export KIMI_DESKTOP_NOTARIZE=false
  return 0 2>/dev/null || exit 0
fi

# Validate inputs early — base64-decoding "" gives a 0-byte file and
# `security import` fails later with a cryptic message. Fail loudly here.
missing=""
for var in APPLE_CERTIFICATE_P12 APPLE_CERTIFICATE_PASSWORD \
           APPLE_NOTARIZATION_KEY_P8 APPLE_NOTARIZATION_KEY_ID \
           APPLE_NOTARIZATION_ISSUER_ID; do
  eval "val=\${$var:-}"
  if [ -z "$val" ]; then
    missing="$missing $var"
  fi
done
if [ -n "$missing" ]; then
  echo "ERROR: signing requested but these CI/CD variables are empty/unset:$missing"
  echo "Configure them under Settings -> CI/CD -> Variables, or trigger the"
  echo "pipeline with DESKTOP_SIGN_MACOS=false for an unsigned build."
  exit 1
fi

SIGN_DIR="${CI_PROJECT_DIR:-$PWD}/.ci-signing"
rm -rf "$SIGN_DIR"
mkdir -p "$SIGN_DIR"
KEYCHAIN_PATH="$SIGN_DIR/signing.keychain-db"
KEYCHAIN_PASSWORD="$(openssl rand -hex 16)"

# 1. Decode certificate + notarization API key.
cert_path="$SIGN_DIR/certificate.p12"
printf '%s' "$APPLE_CERTIFICATE_P12" | base64 -d > "$cert_path"
if [ ! -s "$cert_path" ]; then
  echo "ERROR: decoded certificate is empty. APPLE_CERTIFICATE_P12 may not be valid base64."
  exit 1
fi
key_path="$SIGN_DIR/AuthKey.p8"
printf '%s' "$APPLE_NOTARIZATION_KEY_P8" | base64 -d > "$key_path"
if [ ! -s "$key_path" ]; then
  echo "ERROR: decoded API key is empty. APPLE_NOTARIZATION_KEY_P8 may not be valid base64."
  exit 1
fi

# 2. Record the runner's current keychain state so cleanup can restore it.
security default-keychain > "$SIGN_DIR/default-keychain.txt" 2>/dev/null || true
security list-keychains -d user > "$SIGN_DIR/keychain-list.txt" 2>/dev/null || true

# 3. Create a temporary keychain (don't pollute the runner's default one).
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
security set-keychain-settings -lut 21600 "$KEYCHAIN_PATH"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"

# 4. Add it to the user keychain search list and make it default.
# shellcheck disable=SC2046
security list-keychains -d user -s "$KEYCHAIN_PATH" $(security list-keychains -d user | tr -d '"')
security default-keychain -s "$KEYCHAIN_PATH"

# 5. Import the cert, authorizing codesign + security to use it.
security import "$cert_path" -k "$KEYCHAIN_PATH" \
  -P "$APPLE_CERTIFICATE_PASSWORD" \
  -T /usr/bin/codesign -T /usr/bin/security

# 6. Non-interactive private key access.
security set-key-partition-list -S apple-tool:,apple: \
  -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH" > /dev/null

# 7. Discover the identity (don't hardcode team ID).
IDENTITY=$(security find-identity -v -p codesigning "$KEYCHAIN_PATH" \
  | grep "Developer ID Application" | head -1 \
  | sed -n 's/.*"\(Developer ID Application[^"]*\)".*/\1/p' || true)

if [ -z "$IDENTITY" ]; then
  echo "ERROR: no Developer ID Application identity found in keychain:"
  security find-identity -v -p codesigning "$KEYCHAIN_PATH" || true
  exit 1
fi
echo "Found signing identity: $IDENTITY"

# State file for the cleanup script (runs in a separate shell in after_script).
{
  echo "KEYCHAIN_PATH=$KEYCHAIN_PATH"
  echo "SIGN_DIR=$SIGN_DIR"
} > "$SIGN_DIR/env"

rm -f "$cert_path"

# 8. Export the electron-builder env contract.
export APPLE_SIGNING_IDENTITY="$IDENTITY"
export APPLE_KEYCHAIN_PATH="$KEYCHAIN_PATH"
# electron-builder rejects the "Developer ID Application: " prefix in
# CSC_NAME; strip it so the certificate matches by team name + ID.
export CSC_NAME="${IDENTITY#Developer ID Application: }"
export CSC_KEYCHAIN="$KEYCHAIN_PATH"
export CSC_IDENTITY_AUTO_DISCOVERY=true
export KIMI_DESKTOP_NOTARIZE=true
export APPLE_API_KEY="$key_path"
export APPLE_API_KEY_ID="$APPLE_NOTARIZATION_KEY_ID"
export APPLE_API_ISSUER="$APPLE_NOTARIZATION_ISSUER_ID"
