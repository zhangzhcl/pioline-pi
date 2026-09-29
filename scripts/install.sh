#!/usr/bin/env bash
# Pipline installer — macOS & Linux
# Set PIPLINE_GITHUB_REPOSITORY=owner/repository, then run:
#   curl -fsSL "https://raw.githubusercontent.com/$PIPLINE_GITHUB_REPOSITORY/main/scripts/install.sh" | bash
# Or: curl -fsSL "$URL" | bash -s -- --repository owner/repository --version v0.1.0
set -euo pipefail

# ── Constants ─────────────────────────────────────────────────────────────────
REPO="${PIPLINE_GITHUB_REPOSITORY:-}"
APP_NAME="Pipline"

# ── Colors ────────────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  BOLD="\033[1m"; GREEN="\033[1;32m"; YELLOW="\033[1;33m"
  RED="\033[1;31m"; CYAN="\033[1;36m"; RESET="\033[0m"
else
  BOLD=""; GREEN=""; YELLOW=""; RED=""; CYAN=""; RESET=""
fi

info()    { printf "  ${CYAN}•${RESET} %s\n" "$*"; }
success() { printf "  ${GREEN}✓${RESET} %s\n" "$*"; }
warn()    { printf "  ${YELLOW}⚠${RESET} %s\n" "$*"; }
error()   { printf "  ${RED}✗${RESET} %s\n" "$*" >&2; }
header()  { printf "\n${BOLD}%s${RESET}\n" "$*"; }

die() { error "$*"; exit 1; }

# ── Argument parsing ──────────────────────────────────────────────────────────
PINNED_VERSION=""
FORCE_APPIMAGE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version|-v)
      [ "$#" -ge 2 ] || die "$1 requires a version tag."
      [ -n "$2" ] || die "$1 requires a non-empty version tag."
      [[ "$2" != -* ]] || die "$1 requires a version tag, not another option."
      PINNED_VERSION="$2"
      shift 2
      ;;
    --repository|-r)
      [ "$#" -ge 2 ] || die "--repository requires an owner/repository value."
      REPO="$2"
      shift 2
      ;;
    --appimage)   FORCE_APPIMAGE=1; shift ;;
    --help|-h)
      echo "Usage: install.sh --repository <owner/repository> [--version <tag>] [--appimage]"
      echo "  --repository GitHub repository containing Pipline releases. May also be set with PIPLINE_GITHUB_REPOSITORY."
      echo "  --version   Install a specific release tag (e.g. v0.1.0). Defaults to latest."
      echo "  --appimage  Linux only. Install the AppImage into ~/.local/bin instead of"
      echo "              using the system package manager. No sudo required."
      exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ "$REPO" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]] \
  || die "Set --repository <owner/repository> or PIPLINE_GITHUB_REPOSITORY to the Pipline GitHub repository."
GITHUB_API="https://api.github.com/repos/${REPO}/releases"

# ── Dependency check ──────────────────────────────────────────────────────────
need_cmd() { command -v "$1" &>/dev/null || die "Required command not found: $1"; }
need_cmd curl
need_cmd uname

# Ubuntu's snap curl is AppArmor-confined: it has a private /tmp, and the home
# interface denies top-level hidden directories (so ~/.cache is not writable).
# Prefer the native binary when both are present; otherwise stage downloads
# under a visible $HOME path.
is_snap_path() {
  case "$1" in
    /snap/*) return 0 ;;
  esac
  case "$(readlink -f "$1" 2>/dev/null || true)" in
    /snap/*) return 0 ;;
  esac
  return 1
}

CURL_BIN="$(command -v curl)"
if is_snap_path "$CURL_BIN" && [ -x /usr/bin/curl ] && ! is_snap_path /usr/bin/curl; then
  CURL_BIN="/usr/bin/curl"
fi

curl_get() { "$CURL_BIN" "$@"; }

# ── Detect OS & arch ──────────────────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) PLATFORM="macos" ;;
  Linux)  PLATFORM="linux" ;;
  *)      die "Unsupported operating system: $OS. Use install.ps1 for Windows." ;;
esac

case "$ARCH" in
  x86_64|amd64)     ARCH_NORM="x86_64" ;;
  arm64|aarch64)    ARCH_NORM="arm64"  ;;
  *)                die "Unsupported architecture: $ARCH" ;;
esac

if [ "$FORCE_APPIMAGE" = "1" ] && [ "$PLATFORM" != "linux" ]; then
  die "--appimage is Linux-only; on macOS the DMG is the only bundle."
fi

# ── Pick the Linux install method ─────────────────────────────────────────────
# The AppImage is the universal fallback: it is a self-contained binary, so it
# covers the distros that ship none of these package managers (Arch, Alpine,
# NixOS, Gentoo, Void, ...) and it installs per-user without sudo.
INSTALL_METHOD=""
if [ "$PLATFORM" = "linux" ]; then
  if [ "$FORCE_APPIMAGE" = "1" ]; then
    INSTALL_METHOD="appimage"
  elif command -v apt-get &>/dev/null; then
    INSTALL_METHOD="apt"
  elif command -v dpkg &>/dev/null; then
    INSTALL_METHOD="dpkg"
  elif command -v dnf &>/dev/null; then
    INSTALL_METHOD="dnf"
  elif command -v yum &>/dev/null; then
    INSTALL_METHOD="yum"
  elif command -v rpm &>/dev/null; then
    INSTALL_METHOD="rpm"
  else
    INSTALL_METHOD="appimage"
    info "No apt/dpkg/dnf/yum/rpm found — falling back to the AppImage."
  fi
fi

# ── Resolve the release ───────────────────────────────────────────────────────
header "🎯  ${APP_NAME} Installer"
if is_snap_path "$(command -v curl)"; then
  if [ "$CURL_BIN" = "/usr/bin/curl" ]; then
    warn "Snap curl cannot write to /tmp or ~/.cache. Using /usr/bin/curl instead."
  else
    warn "Snap curl cannot write to /tmp or ~/.cache. Staging the download under ~/pipline-install."
  fi
fi

if [ -n "$PINNED_VERSION" ]; then
  VERSION="$PINNED_VERSION"
  [ "${VERSION#v}" = "$VERSION" ] && VERSION="v${VERSION}"
  info "Using pinned version: ${VERSION}"
  RELEASE_URL="${GITHUB_API}/tags/${VERSION}"
else
  info "Fetching latest release from GitHub..."
  RELEASE_URL="${GITHUB_API}/latest"
fi

RELEASE_JSON="$(curl_get -fsSL "$RELEASE_URL")" \
  || die "Failed to query the GitHub release API. Check your connection, or that ${PINNED_VERSION:-the latest release} exists."

if [ -z "$PINNED_VERSION" ]; then
  # `|| true`: `set -o pipefail` turns a non-matching grep into a failed
  # assignment, which `set -e` would abort on before the guard below runs.
  VERSION="$(printf '%s' "$RELEASE_JSON" | grep '"tag_name"' | head -1 | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/' || true)"
  [ -n "$VERSION" ] || die "Failed to fetch latest release version."
  info "Latest version: ${VERSION}"
fi

# Never rebuild asset filenames from the tag. `scripts/release.sh` encodes
# prerelease tags into a numeric app version (Windows MSI rejects `-beta.4`),
# so prerelease tags ship assets with version metadata encoded by Tauri. Matching the
# asset list the API just handed us keeps this immune to that encoding — and to
# any future bundler rename.
ASSET_URLS="$(printf '%s' "$RELEASE_JSON" \
  | grep -o '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*"' \
  | sed -E 's/.*"([^"]*)"$/\1/' || true)"
[ -n "$ASSET_URLS" ] || die "Release ${VERSION} has no downloadable assets."

# `|| true` so a no-match returns empty rather than tripping `set -e` via
# `pipefail` — callers decide what a missing asset means.
pick_asset() { printf '%s\n' "$ASSET_URLS" | grep -E "$1" | head -1 || true; }

case "$ARCH_NORM" in
  x86_64) APPIMAGE_PATTERN='_amd64\.AppImage$'    ;;
  arm64)  APPIMAGE_PATTERN='_aarch64\.AppImage$'  ;;
esac

case "$PLATFORM" in
  macos)
    case "$ARCH_NORM" in
      arm64)  PATTERN='_aarch64\.dmg$' ;;
      x86_64) PATTERN='_x64\.dmg$'     ;;
    esac
    ;;
  linux)
    case "$INSTALL_METHOD" in
      apt|dpkg)
        case "$ARCH_NORM" in
          x86_64) PATTERN='_amd64\.deb$' ;;
          arm64)  PATTERN='_arm64\.deb$' ;;
        esac
        ;;
      dnf|yum|rpm)
        case "$ARCH_NORM" in
          x86_64) PATTERN='\.x86_64\.rpm$'  ;;
          arm64)  PATTERN='\.aarch64\.rpm$' ;;
        esac
        ;;
      appimage) PATTERN="$APPIMAGE_PATTERN" ;;
    esac
    ;;
esac

DOWNLOAD_URL="$(pick_asset "$PATTERN")"

# Older releases predate the AppImage target, and a given release can miss an
# arch for one bundle type. Fall back rather than dying on a partial release.
if [ -z "$DOWNLOAD_URL" ] && [ "$PLATFORM" = "linux" ] && [ "$INSTALL_METHOD" != "appimage" ]; then
  DOWNLOAD_URL="$(pick_asset "$APPIMAGE_PATTERN")"
  if [ -n "$DOWNLOAD_URL" ]; then
    warn "Release ${VERSION} has no ${INSTALL_METHOD} package for ${ARCH_NORM} — using the AppImage."
    INSTALL_METHOD="appimage"
  fi
fi

[ -n "$DOWNLOAD_URL" ] || die "Release ${VERSION} has no ${PLATFORM} asset for ${ARCH_NORM}."

FILENAME="${DOWNLOAD_URL##*/}"

# ── Download ──────────────────────────────────────────────────────────────────
if is_snap_path "$CURL_BIN"; then
  # Snap's home interface allows non-hidden $HOME paths only. Host mkdir of
  # ~/.cache succeeds, but snap curl still cannot create the file there.
  STAGING="${HOME}/pipline-install"
  mkdir -p "$STAGING"
  TMPDIR="$(mktemp -d "${STAGING}/tmp.XXXXXX")"
  trap 'rm -rf "$TMPDIR"; rmdir "$STAGING" 2>/dev/null || true' EXIT
else
  TMPDIR="$(mktemp -d)"
  trap 'rm -rf "$TMPDIR"' EXIT
fi

DEST="${TMPDIR}/${FILENAME}"

header "⬇️   Downloading"
info "URL: ${DOWNLOAD_URL}"
info "File: ${FILENAME}"

if ! curl_get -fL --progress-bar -o "$DEST" "$DOWNLOAD_URL"; then
  if is_snap_path "$CURL_BIN"; then
    die "Download failed. Ubuntu snap curl cannot write this file. Install native curl (\`sudo apt install curl\`) and retry, or download ${FILENAME} from ${DOWNLOAD_URL}."
  fi
  die "Download failed. Check your internet connection or try --version with a valid tag."
fi
success "Downloaded ${FILENAME}"

# ── Install ───────────────────────────────────────────────────────────────────
header "📦  Installing"

BIN_DIR="${HOME}/.local/bin"
BIN_PATH="${BIN_DIR}/pipline"

install_appimage() {
  mkdir -p "$BIN_DIR"
  # Copy-then-rename instead of writing in place: overwriting a running
  # AppImage fails with ETXTBSY, while rename(2) swaps it happily.
  cp "$DEST" "${BIN_PATH}.new"
  chmod 755 "${BIN_PATH}.new"
  mv -f "${BIN_PATH}.new" "$BIN_PATH"
  info "Installed AppImage to ${BIN_PATH}"

  # Desktop entry + icon, so the app shows up in the launcher like the
  # deb/rpm does. Icon extraction is best effort — `--appimage-extract` reads
  # the bundle's own squashfs and needs no FUSE, but a missing icon is not
  # worth failing the install over.
  local desktop_dir="${HOME}/.local/share/applications"
  local icon_dir="${HOME}/.local/share/icons/hicolor/256x256/apps"
  mkdir -p "$desktop_dir" "$icon_dir"

  local extracted
  extracted="$(cd "$TMPDIR" && "$BIN_PATH" --appimage-extract 'usr/share/icons/hicolor/256x256/apps/*.png' >/dev/null 2>&1 \
    && find "${TMPDIR}/squashfs-root" -name '*.png' | head -1 || true)"
  if [ -n "$extracted" ] && [ -f "$extracted" ]; then
    cp "$extracted" "${icon_dir}/pipline.png"
  fi

  cat > "${desktop_dir}/pipline.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=${APP_NAME}
Exec=${BIN_PATH}
Icon=pipline
Categories=Development;Utility;
Terminal=false
DESKTOP
  update-desktop-database "$desktop_dir" &>/dev/null || true
  info "Added launcher entry"

  case ":${PATH}:" in
    *":${BIN_DIR}:"*) ;;
    *) warn "${BIN_DIR} is not on your PATH. Add it to your shell profile to run \`pipline\` directly." ;;
  esac
  # FUSE 2 is what mounts an AppImage at launch. Ubuntu 24.04+ ships only
  # FUSE 3, so point at both the fix and the no-install escape hatch.
  if [ ! -e /dev/fuse ] || ! ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
    warn "FUSE 2 not detected. Install it (e.g. \`sudo apt install libfuse2t64\`), or run: ${BIN_PATH} --appimage-extract-and-run"
  fi
}

case "$PLATFORM" in
  macos)
    MOUNTPOINT="$(mktemp -d)"
    info "Mounting disk image..."
    hdiutil attach -quiet -nobrowse -mountpoint "$MOUNTPOINT" "$DEST"

    APP_SRC="$(find "$MOUNTPOINT" -maxdepth 1 -name "*.app" | head -1)"
    [ -n "$APP_SRC" ] || die "No .app found in DMG."

    APP_DEST="/Applications/${APP_NAME}.app"

    if [ -d "$APP_DEST" ]; then
      warn "Removing existing installation at ${APP_DEST}..."
      rm -rf "$APP_DEST"
    fi

    info "Copying ${APP_NAME}.app to /Applications..."
    cp -R "$APP_SRC" "$APP_DEST"

    hdiutil detach -quiet "$MOUNTPOINT" || true
    rm -rf "$MOUNTPOINT"

    # Remove the quarantine bit so Gatekeeper does not block the first launch.
    # Pipline uses ad-hoc signing (not Apple-notarized). Files downloaded via
    # curl still receive the com.apple.quarantine xattr from macOS, which
    # causes the "app can't be opened" / Privacy & Security prompt on first
    # launch. Stripping it here means the app opens directly without any
    # manual "Open Anyway" step in System Settings.
    info "Removing macOS quarantine attribute..."
    xattr -dr com.apple.quarantine "$APP_DEST" 2>/dev/null || true

    success "Installed ${APP_NAME}.app to /Applications"
    ;;

  linux)
    case "$INSTALL_METHOD" in
      apt)
        info "Installing with apt..."
        sudo apt-get install -y "$DEST"
        ;;
      dpkg)
        info "Installing with dpkg..."
        sudo dpkg -i "$DEST"
        ;;
      dnf)
        info "Installing with dnf..."
        sudo dnf install -y "$DEST"
        ;;
      yum)
        info "Installing with yum..."
        sudo yum localinstall -y "$DEST"
        ;;
      rpm)
        info "Installing with rpm..."
        sudo rpm -U --force "$DEST"
        ;;
      appimage)
        install_appimage
        ;;
    esac
    success "Installed ${APP_NAME}"
    ;;
esac

# ── Done ──────────────────────────────────────────────────────────────────────
printf "\n${GREEN}${BOLD}✓ ${APP_NAME} ${VERSION} installed successfully!${RESET}\n\n"

case "$PLATFORM" in
  macos) info "Launch it from /Applications/${APP_NAME}.app or Spotlight." ;;
  linux) info "Launch it by running: pipline  (or search in your app menu)" ;;
esac

printf "\n"
