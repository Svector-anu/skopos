#!/bin/bash
# Generates relay/.fly.secrets from local .env + wallet JSON
# Usage: bash scripts/gen-fly-secrets.sh > .fly.secrets
# Then:  fly secrets import < .fly.secrets

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"
WALLET_FILE="$HOME/.vara-wallet/wallets/skopos-agent.json"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found" >&2
  exit 1
fi

if [ ! -f "$WALLET_FILE" ]; then
  echo "ERROR: $WALLET_FILE not found" >&2
  exit 1
fi

# Source the .env to pick up the values we want
set -a
source "$ENV_FILE"
set +a

cat <<EOF
RELAY_SECRET=${RELAY_SECRET}
BRIDGE_PROGRAM_ID=${BRIDGE_PROGRAM_ID}
SKOPOS_BASE_URL=${SKOPOS_BASE_URL}
OPERATOR_HEX=${OPERATOR_HEX}
GROQ_API_KEY=${GROQ_API_KEY}
VOUCHER_ID=${VOUCHER_ID}
RELAY_WALLET_JSON_CONTENT=$(cat "$WALLET_FILE" | tr -d '\n')
EOF
