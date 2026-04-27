#!/usr/bin/env bash
# =============================================================================
# provision.sh — One-time Azure infrastructure provisioning for Knowledge Hub
#
# Creates (all in UK South):
#   • Resource group:    rg-knowledge-hub
#   • App Service Plan:  knowledge-hub-plan  (B1 Linux)
#   • App Service (API): knowledge-hub-api   (Node 20 LTS)
#   • App Service (Web): knowledge-hub-web   (Node 20 LTS)
#   • PostgreSQL Flex:   knowledge-hub-db    (Burstable B1ms)
#
# Run once. Safe to re-run — az commands are idempotent.
# Usage: bash scripts/provision.sh
# =============================================================================

set -euo pipefail

SUBSCRIPTION="01a8d825-d38f-4f99-92b0-fe6bb2d74b6b"
LOCATION="uksouth"
RG="rg-knowledge-hub"
APP_PLAN="rh-knhub-plan"
API_APP="rh-knhub-api"
WEB_APP="rh-knhub-web"
PG_SERVER="knowledge-hub-db"
PG_ADMIN="khadmin"
PG_PASSWORD="${POSTGRES_ADMIN_PASSWORD:-$(openssl rand -base64 24 | tr -d '/+=')}"
PG_DB="knowledgehub"

info()    { echo -e "\033[1;34m[INFO]\033[0m  $*"; }
success() { echo -e "\033[1;32m[OK]\033[0m    $*"; }
die()     { echo -e "\033[1;31m[ERROR]\033[0m $*" >&2; exit 1; }

# ── Pre-flight ────────────────────────────────────────────────────────────────
az account show --output none 2>/dev/null || die "Run 'az login' first."
az account set --subscription "$SUBSCRIPTION"
success "Subscription: Richards Subscription"

# ── Resource Group ────────────────────────────────────────────────────────────
info "Creating resource group: $RG ($LOCATION)..."
az group create --name "$RG" --location "$LOCATION" --output none
success "Resource group ready."

# ── App Service Plan (B1 Linux — shared by API + Web) ────────────────────────
info "Creating App Service Plan: $APP_PLAN (B1 Linux)..."
az appservice plan create \
  --resource-group "$RG" \
  --name "$APP_PLAN" \
  --location "$LOCATION" \
  --is-linux \
  --sku B1 \
  --output none
success "App Service Plan ready."

# ── App Service: Backend API ───────────────────────────────────────────────────
info "Creating App Service (backend): $API_APP..."
az webapp create \
  --resource-group "$RG" \
  --plan "$APP_PLAN" \
  --name "$API_APP" \
  --runtime "NODE:20-lts" \
  --output none
success "Backend App Service ready."

# ── App Service: Frontend Web ─────────────────────────────────────────────────
info "Creating App Service (frontend): $WEB_APP..."
az webapp create \
  --resource-group "$RG" \
  --plan "$APP_PLAN" \
  --name "$WEB_APP" \
  --runtime "NODE:20-lts" \
  --output none
success "Frontend App Service ready."

# ── PostgreSQL Flexible Server ────────────────────────────────────────────────
info "Checking PostgreSQL Flexible Server: $PG_SERVER..."
PG_EXISTS=$(az postgres flexible-server show \
  --resource-group "$RG" \
  --name "$PG_SERVER" \
  --query name \
  --output tsv 2>/dev/null || echo "")

if [[ -z "$PG_EXISTS" ]]; then
  info "Creating PostgreSQL Flexible Server: $PG_SERVER (Burstable B1ms)..."
  az postgres flexible-server create \
    --resource-group "$RG" \
    --name "$PG_SERVER" \
    --location "$LOCATION" \
    --admin-user "$PG_ADMIN" \
    --admin-password "$PG_PASSWORD" \
    --sku-name Standard_B1ms \
    --tier Burstable \
    --storage-size 32 \
    --version 16 \
    --public-access 0.0.0.0 \
    --output none

  az postgres flexible-server db create \
    --resource-group "$RG" \
    --server-name "$PG_SERVER" \
    --database-name "$PG_DB" \
    --output none

  # Allow Azure App Service to connect
  az postgres flexible-server firewall-rule create \
    --resource-group "$RG" \
    --name "$PG_SERVER" \
    --rule-name AllowAzureServices \
    --start-ip-address 0.0.0.0 \
    --end-ip-address 0.0.0.0 \
    --output none
else
  info "PostgreSQL server '$PG_SERVER' already exists — skipping creation."
  # On re-run, password must be passed in via POSTGRES_ADMIN_PASSWORD env var
  [[ -z "${POSTGRES_ADMIN_PASSWORD:-}" ]] && \
    echo "  ⚠️  Set POSTGRES_ADMIN_PASSWORD to your existing DB password to construct DATABASE_URL"
fi

PG_HOST=$(az postgres flexible-server show \
  --resource-group "$RG" \
  --name "$PG_SERVER" \
  --query fullyQualifiedDomainName \
  --output tsv)

success "PostgreSQL ready."

# ── Output ────────────────────────────────────────────────────────────────────
DATABASE_URL="postgresql://${PG_ADMIN}:${PG_PASSWORD}@${PG_HOST}:5432/${PG_DB}?sslmode=require"

echo ""
echo "============================================================"
echo "  PROVISIONING COMPLETE"
echo "============================================================"
echo "  API URL:     https://$API_APP.azurewebsites.net"
echo "  Web URL:     https://$WEB_APP.azurewebsites.net"
echo "  PG Host:     $PG_HOST"
echo "  PG Admin:    $PG_ADMIN"
echo "  PG Password: $PG_PASSWORD"
echo ""
echo "  DATABASE_URL=$DATABASE_URL"
echo ""
echo "  ⚠️  Copy the DATABASE_URL and PG Password — needed for deploy-backend.sh"
echo "============================================================"

# Write to temp file so deploy-all.sh can pick it up automatically
echo "DATABASE_URL=$DATABASE_URL" > /tmp/knowledge-hub-provision-output.env
echo "POSTGRES_ADMIN_PASSWORD=$PG_PASSWORD" >> /tmp/knowledge-hub-provision-output.env
