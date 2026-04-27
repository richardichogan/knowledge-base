#!/usr/bin/env bash
# =============================================================================
# deploy-frontend.sh — Build and deploy the Knowledge Hub web frontend
#
# Prerequisites:
#   • provision.sh has been run
#   • deploy-backend.sh has been run (need the API URL and JWT token)
#   • VITE_API_TOKEN set to the JWT secret output from deploy-backend.sh
#
# Usage:
#   VITE_API_TOKEN="<signed-jwt>" bash scripts/deploy-frontend.sh
#
#   To generate a token (run once after deploy-backend.sh):
#     node -e "import('jsonwebtoken').then(({default:jwt})=> \
#       console.log(jwt.sign({sub:'richard-prod'}, process.env.JWT_SECRET, {expiresIn:'365d'})))"
# =============================================================================

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
SUBSCRIPTION="01a8d825-d38f-4f99-92b0-fe6bb2d74b6b"
RG="rg-knowledge-hub"
API_APP="rh-knhub-api"
WEB_APP="rh-knhub-web"
WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../knowledge-hub-web" && pwd)"

# ── Helpers ───────────────────────────────────────────────────────────────────
info()    { echo -e "\033[1;34m[INFO]\033[0m  $*"; }
success() { echo -e "\033[1;32m[OK]\033[0m    $*"; }
die()     { echo -e "\033[1;31m[ERROR]\033[0m $*" >&2; exit 1; }

# ── Pre-flight ────────────────────────────────────────────────────────────────
az account show --output none 2>/dev/null || die "Run 'az login' first."
az account set --subscription "$SUBSCRIPTION"

API_URL="https://$API_APP.azurewebsites.net"

# Auto-generate a signed JWT if one is not explicitly supplied.
if [[ -z "${VITE_API_TOKEN:-}" ]]; then
  info "No VITE_API_TOKEN supplied — generating one from production JWT_SECRET..."
  PROD_JWT_SECRET=$(az webapp config appsettings list \
    --resource-group "$RG" --name "$API_APP" \
    --query "[?name=='JWT_SECRET'].value" --output tsv 2>/dev/null)
  [[ -z "$PROD_JWT_SECRET" ]] && die "Could not read JWT_SECRET from App Service settings."
  VITE_API_TOKEN=$(node --input-type=module <<EOF
import { createHmac } from 'crypto';
const secret = '$PROD_JWT_SECRET';
const header = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
const payload = Buffer.from(JSON.stringify({sub:'richard-prod',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+31536000})).toString('base64url');
const sig = createHmac('sha256', secret).update(\`\${header}.\${payload}\`).digest('base64url');
console.log(\`\${header}.\${payload}.\${sig}\`);
EOF
)
  success "JWT generated."
fi

# ── Install dependencies ───────────────────────────────────────────────────────
info "Installing frontend dependencies..."
cd "$WEB_DIR"
npm ci

# ── Build Vite app with production API URL ────────────────────────────────────
info "Building frontend for production (API: $API_URL)..."
VITE_API_URL="$API_URL" \
VITE_API_TOKEN="$VITE_API_TOKEN" \
  npm run build
success "Frontend built to $WEB_DIR/dist"

# ── Configure App Service for static file serving ────────────────────────────
info "Configuring App Service startup command..."
az webapp config set \
  --resource-group "$RG" \
  --name "$WEB_APP" \
  --startup-file "npx serve -s /home/site/wwwroot -l 8080" \
  --output none

az webapp config appsettings set \
  --resource-group "$RG" \
  --name "$WEB_APP" \
  --settings \
    WEBSITES_PORT=8080 \
    NODE_ENV=production \
  --output none

# ── Zip and deploy dist/ ──────────────────────────────────────────────────────
info "Creating deployment zip..."
DEPLOY_ZIP="/tmp/knowledge-hub-web-deploy.zip"
cd "$WEB_DIR/dist"

# Include a minimal package.json so App Service can run 'npx serve'
cat > package.json << 'EOF'
{
  "name": "knowledge-hub-web-static",
  "version": "1.0.0",
  "scripts": { "start": "npx serve -s . -l 8080" }
}
EOF

zip -r "$DEPLOY_ZIP" . --exclude "*.DS_Store"
success "Zip created: $DEPLOY_ZIP"

info "Deploying to App Service: $WEB_APP..."
az webapp deploy \
  --resource-group "$RG" \
  --name "$WEB_APP" \
  --src-path "$DEPLOY_ZIP" \
  --type zip \
  --output none

# Restart to apply
az webapp restart \
  --resource-group "$RG" \
  --name "$WEB_APP" \
  --output none

rm "$DEPLOY_ZIP"
success "Frontend deployed!"
echo ""
echo "  Web URL: https://$WEB_APP.azurewebsites.net"
