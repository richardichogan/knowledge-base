#!/usr/bin/env bash
# =============================================================================
# deploy-all.sh — Full first-time deployment of the Knowledge Hub
#
# Runs in order:
#   1. provision.sh      — creates all Azure resources
#   2. deploy-backend.sh — compiles TS, runs migrations, deploys API
#   3. deploy-frontend.sh — builds Vite app, deploys static frontend
#
# Usage (first time):
#   bash scripts/deploy-all.sh
#
# Re-deploy only backend or frontend afterwards:
#   DATABASE_URL="..." bash scripts/deploy-backend.sh
#   VITE_API_TOKEN="..." bash scripts/deploy-frontend.sh
# =============================================================================

set -euo pipefail

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROVISION_OUTPUT="/tmp/knowledge-hub-provision-output.env"

info()    { echo -e "\033[1;34m[INFO]\033[0m  $*"; }
success() { echo -e "\033[1;32m[OK]\033[0m    $*"; }
die()     { echo -e "\033[1;31m[ERROR]\033[0m $*" >&2; exit 1; }

# ── Step 1: Provision ─────────────────────────────────────────────────────────
info "Step 1/3 — Provisioning Azure resources..."
bash "$SCRIPTS_DIR/provision.sh"

# Provision script writes DATABASE_URL + POSTGRES_ADMIN_PASSWORD to temp file
[[ -f "$PROVISION_OUTPUT" ]] || die "Provision output file not found: $PROVISION_OUTPUT"
# shellcheck source=/dev/null
source "$PROVISION_OUTPUT"
export DATABASE_URL
success "Picked up DATABASE_URL from provisioning output."

# ── Step 2: Deploy backend ────────────────────────────────────────────────────
info "Step 2/3 — Deploying backend..."
bash "$SCRIPTS_DIR/deploy-backend.sh"

# Pick up JWT secret written by deploy-backend.sh
source "$PROVISION_OUTPUT"
export VITE_API_TOKEN="${PROD_JWT_SECRET:-}"

# ── Step 3: Deploy frontend ───────────────────────────────────────────────────
info "Step 3/3 — Deploying frontend..."
bash "$SCRIPTS_DIR/deploy-frontend.sh"

# Cleanup temp file
rm -f "$PROVISION_OUTPUT"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "============================================================"
echo "  DEPLOYMENT COMPLETE"
echo "============================================================"
echo "  API:  https://rh-knhub-api.azurewebsites.net"
echo "  Web:  https://rh-knhub-web.azurewebsites.net"
echo ""
echo "  Health check:"
echo "    curl https://rh-knhub-api.azurewebsites.net/health"
echo "============================================================"

set -euo pipefail

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

info()    { echo -e "\033[1;34m[INFO]\033[0m  $*"; }
success() { echo -e "\033[1;32m[OK]\033[0m    $*"; }
die()     { echo -e "\033[1;31m[ERROR]\033[0m $*" >&2; exit 1; }

# ── Step 1: Provision ─────────────────────────────────────────────────────────
info "Step 1/3 — Provisioning Azure resources..."
bash "$SCRIPTS_DIR/provision.sh"

# ── Capture PostgreSQL details from provisioned server ────────────────────────
PG_SERVER="knowledge-hub-db"
PG_DB="knowledgehub"
RG="rg-knowledge-hub"
SUBSCRIPTION="01a8d825-d38f-4f99-92b0-fe6bb2d74b6b"

info "Fetching PostgreSQL hostname..."
PG_HOST=$(az postgres flexible-server show \
  --resource-group "$RG" \
  --name "$PG_SERVER" \
  --subscription "$SUBSCRIPTION" \
  --query fullyQualifiedDomainName \
  --output tsv)

# Password must be provided (output from provision.sh or set via env)
[[ -z "${POSTGRES_ADMIN_PASSWORD:-}" ]] && \
  die "Set POSTGRES_ADMIN_PASSWORD to the password output by provision.sh"

export DATABASE_URL="postgresql://khadmin:${POSTGRES_ADMIN_PASSWORD}@${PG_HOST}:5432/${PG_DB}?sslmode=require"
success "DATABASE_URL constructed."

# ── Step 2: Deploy backend ────────────────────────────────────────────────────
info "Step 2/3 — Deploying backend..."
bash "$SCRIPTS_DIR/deploy-backend.sh"

# ── Step 3: Deploy frontend ───────────────────────────────────────────────────
# VITE_API_TOKEN is optional — if not set the frontend works without auth
# (auth middleware skips verification in the dev bypass, production requires it)
info "Step 3/3 — Deploying frontend..."
bash "$SCRIPTS_DIR/deploy-frontend.sh"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "============================================================"
echo "  DEPLOYMENT COMPLETE"
echo "============================================================"
echo "  API:  https://knowledge-hub-api.azurewebsites.net"
echo "  Web:  https://knowledge-hub-web.azurewebsites.net"
echo "  Health check:"
echo "    curl https://knowledge-hub-api.azurewebsites.net/health"
echo "============================================================"
