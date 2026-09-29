#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <pipline.dmg>" >&2
  exit 2
fi

DMG_PATH="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
PI_TARGET="${PI_TARGET:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case "$PI_TARGET" in
  darwin-arm64) EXPECTED_ARCH="arm64" ;;
  darwin-x64) EXPECTED_ARCH="x86_64" ;;
  *) echo "Unsupported PI_TARGET: $PI_TARGET" >&2; exit 2 ;;
esac

if [[ ! -f "$DMG_PATH" ]]; then
  echo "DMG not found: $DMG_PATH" >&2
  exit 1
fi

SMOKE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/pipline-dmg-smoke.XXXXXX")"
MOUNT_POINT="$SMOKE_ROOT/mount"
APP_PATH="$SMOKE_ROOT/Pipline.app"
APP_PID=""
MOUNTED=0
PI_DIR=""
mkdir -p "$MOUNT_POINT" "$SMOKE_ROOT/home" "$SMOKE_ROOT/pi-agent"

bundled_pi_pids() {
  ps -axo pid=,command= | awk -v pi_dir="$PI_DIR/" '
    $2 != "ps" && $2 != "awk" &&
    index($0, pi_dir) > 0 &&
    ($0 ~ /--mode rpc/ || index($0, "/node/bin/node") > 0) { print $1 }
  '
}

cleanup() {
  if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" 2>/dev/null; then
    kill -TERM "$APP_PID" 2>/dev/null || true
    wait "$APP_PID" 2>/dev/null || true
  fi
  if [[ -n "$PI_DIR" ]]; then
    while IFS= read -r pi_pid; do
      [[ -n "$pi_pid" ]] || continue
      kill -TERM "$pi_pid" 2>/dev/null || true
      wait "$pi_pid" 2>/dev/null || true
    done < <(bundled_pi_pids)
  fi
  if [[ "$MOUNTED" -eq 1 ]]; then
    hdiutil detach -quiet "$MOUNT_POINT" || hdiutil detach -force -quiet "$MOUNT_POINT" || true
  fi
  rm -rf "$SMOKE_ROOT"
}
trap cleanup EXIT

hdiutil attach -quiet -nobrowse -readonly -mountpoint "$MOUNT_POINT" "$DMG_PATH"
MOUNTED=1
shopt -s nullglob
APP_BUNDLES=("$MOUNT_POINT"/*.app)
SOURCE_APP="${APP_BUNDLES[0]:-}"
if [[ -z "$SOURCE_APP" ]]; then
  echo "DMG does not contain an application bundle: $DMG_PATH" >&2
  exit 1
fi

ditto "$SOURCE_APP" "$APP_PATH"
EXECUTABLE_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP_PATH/Contents/Info.plist")"
MINIMUM_SYSTEM="$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$APP_PATH/Contents/Info.plist")"
if [[ "$MINIMUM_SYSTEM" != "11.0" ]]; then
  echo "Expected macOS deployment target 11.0, found $MINIMUM_SYSTEM" >&2
  exit 1
fi

# Generated-code execution is post-M0–M6 scope. The XPC prototype currently
# does not have a per-target signing path, so release installers must not ship
# the service or worker until M8 confinement and packaging are complete.
WORKFLOW_XPC_SERVICE="$APP_PATH/Contents/XPCServices/app.pipline.desktop.workflow-runner.xpc"
if [[ -e "$WORKFLOW_XPC_SERVICE" ]]; then
  echo "Release DMG unexpectedly contains the workflow XPC service: $WORKFLOW_XPC_SERVICE" >&2
  exit 1
fi
WORKFLOW_CODE_WORKER="$(find "$APP_PATH/Contents" -type f -name 'workflow-code-worker' -print -quit)"
if [[ -n "$WORKFLOW_CODE_WORKER" ]]; then
  echo "Release DMG unexpectedly contains the workflow code worker: $WORKFLOW_CODE_WORKER" >&2
  exit 1
fi

APP_EXECUTABLE="$APP_PATH/Contents/MacOS/$EXECUTABLE_NAME"
if [[ ! -x "$APP_EXECUTABLE" ]]; then
  echo "Application executable is missing or not executable: $APP_EXECUTABLE" >&2
  exit 1
fi
PUBLIC_DIR="$APP_PATH/Contents/Resources/public"
for frontend_asset in \
  "$PUBLIC_DIR/index.html" \
  "$PUBLIC_DIR/compat/bootstrap-entry.js" \
  "$PUBLIC_DIR/vendor/workflow-code-compiler-worker.js" \
  "$PUBLIC_DIR/vendor/esbuild.wasm"; do
  if [[ ! -f "$frontend_asset" ]]; then
    echo "DMG is missing a required frontend asset: $frontend_asset" >&2
    exit 1
  fi
done
TEST_MODULE="$(find "$PUBLIC_DIR" -type f \
  \( -name '*.test.js' -o -name '*.spec.js' -o -name '*.test.jsx' -o -name '*.spec.jsx' \
     -o -name '*.test.ts' -o -name '*.spec.ts' -o -name '*.test.tsx' -o -name '*.spec.tsx' \
     -o -name '*.test.mjs' -o -name '*.spec.mjs' -o -name '*.test.cjs' -o -name '*.spec.cjs' \) \
  -print -quit)"
if [[ -n "$TEST_MODULE" ]]; then
  echo "DMG contains a frontend test module: $TEST_MODULE" >&2
  exit 1
fi
EXPECTED_NODE_ARCH="x64"
if [[ "$EXPECTED_ARCH" == "arm64" ]]; then EXPECTED_NODE_ARCH="arm64"; fi
node "$ROOT/scripts/check-macos-bundle-mach-o.cjs" "$APP_PATH" "$EXPECTED_NODE_ARCH"
APP_ARCHS="$(lipo -archs "$APP_EXECUTABLE")"
if ! grep -Eq "(^|[[:space:]])${EXPECTED_ARCH}([[:space:]]|$)" <<<"$APP_ARCHS"; then
  echo "Application architecture mismatch: expected $EXPECTED_ARCH, found $APP_ARCHS" >&2
  exit 1
fi

PI_DIR="$APP_PATH/Contents/Resources/pi"
PI_LAUNCHER="$PI_DIR/pi"
if [[ ! -x "$PI_LAUNCHER" || ! -x "$PI_DIR/node/bin/node" ]]; then
  echo "DMG is missing the executable Pi or Node runtime." >&2
  exit 1
fi
EXPECTED_PI_VERSION="$(cd "$ROOT" && node -p 'require("./scripts/pi-version.json").version')"
PI_VERSION_OUTPUT="$(HOME="$SMOKE_ROOT/home" PI_CODING_AGENT_DIR="$SMOKE_ROOT/pi-agent" "$PI_LAUNCHER" --version)"
if [[ "$PI_VERSION_OUTPUT" != *"$EXPECTED_PI_VERSION"* ]]; then
  echo "Bundled Pi version mismatch: expected $EXPECTED_PI_VERSION, got $PI_VERSION_OUTPUT" >&2
  exit 1
fi

APP_LOG="$SMOKE_ROOT/app.log"
HOME="$SMOKE_ROOT/home" PI_CODING_AGENT_DIR="$SMOKE_ROOT/pi-agent" \
  "$APP_EXECUTABLE" >"$APP_LOG" 2>&1 &
APP_PID=$!
PI_PIDS=""
for _ in $(seq 1 20); do
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    wait "$APP_PID" || APP_EXIT=$?
    echo "Pipline exited during launch (status ${APP_EXIT:-unknown}). Log:" >&2
    cat "$APP_LOG" >&2
    exit 1
  fi
  PI_PIDS="$(bundled_pi_pids)"
  if [[ -n "$PI_PIDS" ]]; then break; fi
  sleep 1
done
if [[ -z "$PI_PIDS" ]]; then
  echo "Pipline launched without its bundled Pi Runtime. Log:" >&2
  cat "$APP_LOG" >&2
  exit 1
fi

kill -TERM "$APP_PID"
wait "$APP_PID" || true
APP_PID=""
for _ in $(seq 1 10); do
  if [[ -z "$(bundled_pi_pids)" ]]; then break; fi
  sleep 1
done
if [[ -n "$(bundled_pi_pids)" ]]; then
  echo "The bundled Pi Runtime did not exit with Pipline: $(bundled_pi_pids)" >&2
  exit 1
fi
echo "[macos-dmg-smoke] installed and launched Pipline for $EXPECTED_ARCH; macOS $MINIMUM_SYSTEM; Pi $PI_VERSION_OUTPUT"
