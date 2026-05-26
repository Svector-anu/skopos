#!/bin/sh
set -e

if [ -n "$RELAY_WALLET_JSON_CONTENT" ]; then
  mkdir -p "$HOME/.vara-wallet/wallets"
  printf '%s' "$RELAY_WALLET_JSON_CONTENT" > "$HOME/.vara-wallet/wallets/skopos-agent.json"
  echo "[entrypoint] wallet written to $HOME/.vara-wallet/wallets/skopos-agent.json"
fi

exec "$@"
