#!/usr/bin/env bash
# =============================================================================
# setup-auth.sh — Create GitHub OAuth App + enable Easy Auth on Azure
#
# GitHub doesn't allow creating OAuth Apps via API without the admin:app PAT
# scope (a deliberate security restriction). So this script opens the GitHub
# new-app page in your browser, waits for you to paste back the credentials,
# then does everything else automatically.
#
# Usage:
#   bash scripts/setup-auth.sh
# =============================================================================

set -euo pipefail

SUBSCRIPTION="01a8d825-d38f-4f99-92b0-fe6bb2d74b6b"
RG="rg-knowledge-hub"
WEB_APP="rh-knhub-web"
CALLBACK_URL="https://$WEB_APP.azurewebsites.net/.auth/login/github/callback"
HOMEPAGE_URL="https://$WEB_APP.azurewebsites.net"
NEW_APP_URL="https://github.com/settings/applications/new?application_name=Knowledge+Hub&homepage_url=${HOMEPAGE_URL}&callback_url=${CALLBACK_URL}"

info()    { echo -e "\033[1;34m[INFO]\033[0m  $*"; }
success() { echo -e "\033[1;32m[OK]\033[0m    $*"; }
die()     { echo -e "\033[1;31m[ERROR]\033[0m $*" >&2; exit 1; }

az account show --output none 2>/dev/null || die "Run 'az login' first."
az account set --subscription "$SUBSCRIPTION"

# ── Check if Easy Auth is already configured ─────────────────────────────────
ALREADY_ENABLED=$(az webapp auth show \
  --resource-group "$RG" --name "$WEB_APP" \
  --query "enabled" --output tsv 2>/dev/null || echo "false")

if [[ "$ALREADY_ENABLED" == "true" ]]; then
  success "Easy Auth is already enabled on $WEB_APP."
  EXISTING_CLIENT_ID=$(az webapp auth show \
    --resource-group "$RG" --name "$WEB_APP" \
    --query "gitHubClientId" --output tsv 2>/dev/null || echo "")
  echo "  GitHub Client ID: $EXISTING_CLIENT_ID"
  echo "  To reconfigure, set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET and re-run."
  exit 0
fi

# ── Step 1: Open GitHub in browser ───────────────────────────────────────────
echo ""
info "Opening GitHub OAuth App creation page in your browser..."
echo "  Callback URL is pre-filled: $CALLBACK_URL"
echo ""
open "$NEW_APP_URL" 2>/dev/null || xdg-open "$NEW_APP_URL" 2>/dev/null || echo "  Open this URL manually: $NEW_APP_URL"

echo ""
echo "  In GitHub:"
echo "   1. Click 'Register application'"
echo "   2. Click 'Generate a new client secret'"
echo "   3. Paste the Client ID and Client Secret below"
echo ""

# ── Step 2: Collect credentials ──────────────────────────────────────────────
read -r -p "  GitHub OAuth Client ID:     " GITHUB_CLIENT_ID
read -r -s -p "  GitHub OAuth Client Secret: " GITHUB_CLIENT_SECRET
echo ""

[[ -z "$GITHUB_CLIENT_ID" ]]     && die "Client ID is required."
[[ -z "$GITHUB_CLIENT_SECRET" ]] && die "Client Secret is required."

# ── Step 3: Enable Easy Auth on Azure ────────────────────────────────────────
echo ""
info "Enabling GitHub Easy Auth on $WEB_APP..."

az webapp auth update \
  --resource-group "$RG" \
  --name "$WEB_APP" \
  --enabled true \
  --action LoginWithGitHub \
  --github-client-id "$GITHUB_CLIENT_ID" \
  --github-client-secret "$GITHUB_CLIENT_SECRET" \
  --token-store true \
  --output none

success "Done! Easy Auth is now active."
echo ""
echo "  App URL:  https://$WEB_APP.azurewebsites.net"
echo "  Any visitor will be redirected to GitHub login automatically."
