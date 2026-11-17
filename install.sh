#!/bin/sh
set -eu

binary=""
bin_dir="${ASANA_CLI_INSTALL_DIR:-${HOME:-}/.local/bin}"
usage() {
  printf '%s\n' 'Install a locally built or downloaded asana-cli binary.' \
    'Usage: install.sh --binary ABSOLUTE_PATH [--bin-dir ABSOLUTE_DIRECTORY]'
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --binary|--bin-dir)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      case "$1" in
        --binary) binary="$2" ;;
        --bin-dir) bin_dir="$2" ;;
      esac
      shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
case "$binary" in /*) ;; *) usage >&2; exit 2 ;; esac
case "$bin_dir" in /*) ;; *) usage >&2; exit 2 ;; esac
[ -f "$binary" ] && [ -x "$binary" ] || { printf '%s\n' 'Binary must be an executable regular file' >&2; exit 2; }
mkdir -p "$bin_dir"
install -m 755 "$binary" "$bin_dir/asana-cli"
printf 'Installed %s\n' "$bin_dir/asana-cli"
