#!/usr/bin/env bash
#
# MACROS INVESTOR DEMO — one command, one terminal.
#
# Demo tooling, deliberately not production architecture. It prepares the
# emulator, database and build, starts the backend and Metro, launches the app,
# and keeps both alive until Ctrl+C.
#
# It never contains, echoes, logs or stores a credential.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

APP_ID="com.macrostablet"
AVD="MACROS_Tablet"
BACKEND_LOG="/tmp/macros-investor-backend.log"
METRO_LOG="/tmp/macros-investor-metro.log"
MAIN_APP="apps/tablet/android/app/src/main/java/com/macrostablet/MainApplication.kt"

say()  { printf '%s\n' "$*"; }
step() { printf '\n[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

# --- credentials -----------------------------------------------------------
# Prompted with hidden input when absent, exported only to the backend child,
# and never written to a file or the shell history.
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  read -r -s -p "Anthropic API key (hidden): " ANTHROPIC_API_KEY; echo
fi
if [ -z "${OPENAI_API_KEY:-}" ]; then
  read -r -s -p "OpenAI API key (hidden): " OPENAI_API_KEY; echo
fi
[ -n "$ANTHROPIC_API_KEY" ] || die "an Anthropic key is required for live guidance"
[ -n "$OPENAI_API_KEY" ] || die "an OpenAI key is required for premium voice"

# Overridable, but these are the demo defaults.
export MACROS_GUIDANCE_MODEL="${MACROS_GUIDANCE_MODEL:-claude-sonnet-5}"
export MACROS_TTS_MODEL="${MACROS_TTS_MODEL:-gpt-4o-mini-tts}"
export MACROS_TTS_VOICE="${MACROS_TTS_VOICE:-onyx}"

# --- preflight -------------------------------------------------------------
step "Preflight"
command -v node >/dev/null || die "node not found"
command -v npm  >/dev/null || die "npm not found"

ANDROID_SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
[ -d "$ANDROID_SDK" ] || die "Android SDK not found at $ANDROID_SDK (set ANDROID_HOME)"
ADB="$ANDROID_SDK/platform-tools/adb"
EMULATOR="$ANDROID_SDK/emulator/emulator"
[ -x "$ADB" ] || die "adb not found at $ADB"
[ -x "$EMULATOR" ] || die "emulator not found at $EMULATOR"
say "  Android SDK: $ANDROID_SDK"

# --- postgres --------------------------------------------------------------
step "PostgreSQL"
if ! psql -d macros_dev -c 'SELECT 1' >/dev/null 2>&1; then
  if command -v brew >/dev/null; then
    # Detect the INSTALLED service rather than guessing a version string.
    SERVICE="$(brew services list 2>/dev/null | awk '/^postgresql/ {print $1; exit}')"
    [ -n "$SERVICE" ] || die "PostgreSQL is not reachable and no postgresql service is installed"
    say "  starting $SERVICE"
    brew services start "$SERVICE" >/dev/null
    for _ in $(seq 1 30); do
      psql -d macros_dev -c 'SELECT 1' >/dev/null 2>&1 && break
      sleep 1
    done
  fi
fi
psql -d macros_dev -c 'SELECT 1' >/dev/null 2>&1 \
  || die "cannot reach database macros_dev — start PostgreSQL and create it, then retry"
say "  macros_dev reachable"

# --- emulator --------------------------------------------------------------
step "Emulator"
if [ -z "$("$ADB" devices | awk 'NR>1 && $2=="device" {print $1}')" ]; then
  # A clean boot on purpose: a stale snapshot previously produced
  # "System UI isn't responding" mid-demo. Data is never wiped.
  say "  starting $AVD (clean snapshot)"
  "$EMULATOR" -avd "$AVD" -no-snapshot-load >/tmp/macros-investor-emulator.log 2>&1 &
  "$ADB" wait-for-device
fi
say "  waiting for boot"
until [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
  sleep 2
done
say "  emulator ready"

# --- build -----------------------------------------------------------------
step "Verify"
npm run verify

step "Android shell"
NEEDS_HYDRATE=0
[ -f "$MAIN_APP" ] || NEEDS_HYDRATE=1
if [ -f "$MAIN_APP" ] && [ "$(grep -c 'add(MacrosSpeechPackage())' "$MAIN_APP")" != "1" ]; then
  NEEDS_HYDRATE=1
fi
if [ "$NEEDS_HYDRATE" = "1" ]; then
  say "  hydrating"
  node tools/hydrate-android-shell.mjs
else
  say "  already hydrated — not re-downloading React Native"
fi
[ "$(grep -c 'add(MacrosSpeechPackage())' "$MAIN_APP")" = "1" ] \
  || die "MacrosSpeechPackage must be registered exactly once"

step "Tablet build"
if [ ! -d apps/tablet/node_modules/react-native ]; then
  ( cd apps/tablet && npm install )
fi
( cd apps/tablet && npm run typecheck -- --pretty false )
( cd apps/tablet/android && ./gradlew clean && ./gradlew installDebug )

# Granted ahead of time so a permission dialog cannot interrupt the demo.
"$ADB" shell pm grant "$APP_ID" android.permission.RECORD_AUDIO || true

# --- services --------------------------------------------------------------
BACKEND_PID=""
METRO_PID=""
cleanup() {
  [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null || true
  [ -n "$METRO_PID" ] && kill "$METRO_PID" 2>/dev/null || true
  say ""
  say "Stopped backend and Metro. The emulator is still running."
}
trap cleanup EXIT INT TERM

step "Backend"
ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" OPENAI_API_KEY="$OPENAI_API_KEY" \
  npm run guidance:acceptance:backend >"$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!
for _ in $(seq 1 40); do
  nc -z 127.0.0.1 8787 2>/dev/null && break
  sleep 1
done
nc -z 127.0.0.1 8787 2>/dev/null || die "backend did not start — see $BACKEND_LOG"

# Both providers must be live before an investor sees the screen.
grep -q "inference         : LIVE" "$BACKEND_LOG" \
  || die "guidance is not live — see $BACKEND_LOG"
grep -q "premium voice     : LIVE" "$BACKEND_LOG" \
  || die "premium voice is not live — see $BACKEND_LOG"
say "  guidance LIVE, premium voice LIVE"

step "Metro"
( cd apps/tablet && MACROS_GUIDANCE_ACCEPTANCE=1 npm run start:guidance-acceptance ) \
  >"$METRO_LOG" 2>&1 &
METRO_PID=$!
for _ in $(seq 1 40); do
  nc -z 127.0.0.1 8081 2>/dev/null && break
  sleep 1
done
nc -z 127.0.0.1 8081 2>/dev/null || die "Metro did not start — see $METRO_LOG"

step "Launching"
"$ADB" shell am force-stop "$APP_ID"
"$ADB" shell am start -n "$APP_ID/.MainActivity" >/dev/null

say ""
say "========================================"
say "MACROS INVESTOR DEMO — READY"
say "Guidance: LIVE"
say "Premium voice: LIVE"
say "Emulator: READY"
say "========================================"
say "backend log: $BACKEND_LOG"
say "metro log:   $METRO_LOG"
say ""
say "Ctrl+C stops the backend and Metro."

# Watch both; a silent death would leave the app talking to nothing.
while true; do
  kill -0 "$BACKEND_PID" 2>/dev/null || die "the backend stopped — see $BACKEND_LOG"
  kill -0 "$METRO_PID" 2>/dev/null || die "Metro stopped — see $METRO_LOG"
  sleep 3
done
