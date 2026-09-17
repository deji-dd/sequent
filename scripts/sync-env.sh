#!/usr/bin/env bash
set -euo pipefail

# Configuration
SERVER_HOST="${SERVER_HOST:-dejis-cloud}"
SERVER_USER="${SERVER_USER:-root}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/sequent}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [ ! -f "${REPO_DIR}/.env.production" ]; then
  echo "Error: Local .env.production file not found at ${REPO_DIR}/.env.production"
  exit 1
fi

echo "==> Syncing .env.production to ${SERVER_USER}@${SERVER_HOST}:${DEPLOY_DIR}/.env..."
ssh -o StrictHostKeyChecking=no "${SERVER_USER}@${SERVER_HOST}" \
  "mkdir -p ${DEPLOY_DIR} && cat > ${DEPLOY_DIR}/.env && chmod 600 ${DEPLOY_DIR}/.env" \
  < "${REPO_DIR}/.env.production"

echo "==> Successfully synced .env.production to ${SERVER_HOST}:${DEPLOY_DIR}/.env!"
