#!/usr/bin/env bash
set -euo pipefail

runner_temp=${RUNNER_TEMP:?RUNNER_TEMP must be set}
case "$runner_temp" in
  /*) ;;
  *) echo "Runner temporary directory is invalid." >&2; exit 2 ;;
esac

cloudflared_path="$runner_temp/cloudflared"
if [[ -e "$cloudflared_path" ]]; then
  echo "cloudflared destination already exists." >&2
  exit 2
fi

curl \
  --fail \
  --location \
  --proto '=https' \
  --retry 3 \
  --show-error \
  --silent \
  --tlsv1.2 \
  --output "$cloudflared_path" \
  'https://github.com/cloudflare/cloudflared/releases/download/2026.8.2/cloudflared-linux-amd64'

printf '%s  %s\n' \
  'fcfb02b575a52ca1af2e3267af4e1517bcdeb30ac48c834c69abaed3c0576ad2' \
  "$cloudflared_path" | sha256sum --check --status
chmod 0700 "$cloudflared_path"

version_output=$($cloudflared_path --version)
if [[ ! "$version_output" =~ 2026\.8\.2 ]]; then
  echo "cloudflared reported an unexpected version." >&2
  exit 1
fi
