#!/bin/sh
set -eu

repository="ggkguelensan/asana-cli"
version="latest"
bin_dir="${ASANA_CLI_INSTALL_DIR:-${HOME:-}/.local/bin}"

usage() {
  printf '%s\n' \
    "Install the verified asana-cli standalone binary." \
    "" \
    "Usage: install.sh [--version VERSION] [--bin-dir DIRECTORY]" \
    "" \
    "Environment:" \
    "  ASANA_CLI_INSTALL_DIR   Installation directory (default: \$HOME/.local/bin)"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || { printf '%s\n' "--version requires a value" >&2; exit 2; }
      version="${2#v}"
      shift 2
      ;;
    --bin-dir)
      [ "$#" -ge 2 ] || { printf '%s\n' "--bin-dir requires a value" >&2; exit 2; }
      bin_dir="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

valid_version() {
  printf '%s\n' "$1" | awk '
    /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z][0-9A-Za-z.-]*)?$/ { valid = 1 }
    END { exit valid ? 0 : 1 }
  '
}
if [ "$version" != "latest" ] && ! valid_version "$version"; then
  printf '%s\n' "VERSION must be latest or a semantic version such as 1.2.3" >&2
  exit 2
fi

case "$bin_dir" in
  /*) ;;
  *)
    printf '%s\n' "Installation directory must be an absolute path" >&2
    exit 2
    ;;
esac

case "$(uname -s)" in
  Darwin) platform="darwin" ;;
  Linux) platform="linux" ;;
  *)
    printf 'Unsupported operating system: %s\n' "$(uname -s)" >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  arm64|aarch64) architecture="arm64" ;;
  x86_64|amd64) architecture="x64" ;;
  *)
    printf 'Unsupported architecture: %s\n' "$(uname -m)" >&2
    exit 1
    ;;
esac

libc_suffix=""
if [ "$platform" = "linux" ] && command -v ldd >/dev/null 2>&1; then
  if ldd --version 2>&1 | grep -qi musl; then
    libc_suffix="-musl"
  fi
fi

artifact="asana-cli-${platform}-${architecture}${libc_suffix}"
if [ "$version" = "latest" ]; then
  release_url="https://github.com/${repository}/releases/latest/download"
else
  release_url="https://github.com/${repository}/releases/download/v${version}"
fi

if command -v curl >/dev/null 2>&1; then
  fetch() {
    curl --fail --silent --show-error --location \
      --proto '=https' --tlsv1.2 --output "$2" "$1"
  }
elif command -v wget >/dev/null 2>&1; then
  fetch() {
    wget --https-only --quiet --output-document="$2" "$1"
  }
else
  printf '%s\n' "curl or wget is required" >&2
  exit 1
fi

temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/asana-cli-install.XXXXXX")"
binary_path="${temporary_directory}/${artifact}"
checksums_path="${temporary_directory}/SHA256SUMS"
staged_path=""

cleanup() {
  rm -f "$binary_path" "$checksums_path"
  rmdir "$temporary_directory" 2>/dev/null || true
  if [ -n "$staged_path" ]; then
    rm -f "$staged_path"
  fi
}
trap cleanup EXIT HUP INT TERM

printf 'Downloading %s...\n' "$artifact"
fetch "${release_url}/${artifact}" "$binary_path"
fetch "${release_url}/SHA256SUMS" "$checksums_path"

expected_sha256="$(awk -v name="$artifact" '
  $2 == name && $1 ~ /^[0-9a-f]{64}$/ { print $1 }
' "$checksums_path")"
case "$expected_sha256" in
  [0-9a-f][0-9a-f]*) ;;
  *)
    printf 'SHA256SUMS has no valid record for %s\n' "$artifact" >&2
    exit 1
    ;;
esac
if [ "${#expected_sha256}" -ne 64 ]; then
  printf 'SHA256SUMS has an invalid digest for %s\n' "$artifact" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  actual_sha256="$(sha256sum "$binary_path" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  actual_sha256="$(shasum -a 256 "$binary_path" | awk '{print $1}')"
else
  printf '%s\n' "sha256sum or shasum is required" >&2
  exit 1
fi

if [ "$actual_sha256" != "$expected_sha256" ]; then
  printf '%s\n' "Checksum verification failed" >&2
  exit 1
fi

if [ -L "$bin_dir" ]; then
  printf '%s\n' "Installation directory must not be a symlink" >&2
  exit 1
fi
mkdir -p "$bin_dir"
if [ -L "${bin_dir}/asana-cli" ] || { [ -e "${bin_dir}/asana-cli" ] && [ ! -f "${bin_dir}/asana-cli" ]; }; then
  printf '%s\n' "Existing asana-cli target is not a regular file" >&2
  exit 1
fi

staged_path="$(mktemp "${bin_dir}/.asana-cli.install.XXXXXX")"
install -m 0755 "$binary_path" "$staged_path"
installed_version="$("$staged_path" --version)"
if ! valid_version "$installed_version"; then
  printf '%s\n' "Downloaded binary failed its version smoke test" >&2
  exit 1
fi
if [ "$version" != "latest" ] && [ "$installed_version" != "$version" ]; then
  printf 'Expected version %s, downloaded %s\n' "$version" "$installed_version" >&2
  exit 1
fi

mv -f "$staged_path" "${bin_dir}/asana-cli"
printf 'Installed asana-cli %s to %s\n' "$installed_version" "${bin_dir}/asana-cli"
case ":${PATH:-}:" in
  *":${bin_dir}:"*) ;;
  *)
    printf 'Add %s to PATH, then run: asana-cli doctor\n' "$bin_dir"
    ;;
esac
