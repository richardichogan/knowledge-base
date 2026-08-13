# GitHub Copilot Instructions

These rules apply to every change made in this repository. Follow them without exception.

Path-specific rules live in `.github/instructions/*.instructions.md` (each scoped via an `applyTo` glob) and load automatically when you touch matching files:
- `frontend.instructions.md` — `knowledge-hub-web/**` (styling, AppShell structure, compact-widget CSS)
- `backend.instructions.md` — `knowledge-hub-backend/**` (server, migrations)
- `athena-persona.instructions.md` — Athena AI persona files in both frontend and backend

---

## Terminal Commands — STRICT RULES

- **Never use `head` or `tail` to truncate command output.** Run the full command or use `grep` to filter specifically.
- **Never use `curl` to test endpoints.** If an endpoint needs testing, use the existing API client or logs.
- **Never pipe to `| cat`** just to disable a pager — use `--no-pager` flags where available (e.g. `git --no-pager`).

---

## Server Management

- Before starting servers, always check if they are already running to avoid EADDRINUSE errors.
- Backend: `knowledge-hub-backend` runs on port **3000** via `node --import tsx/esm src/server.ts`
- Frontend: `knowledge-hub-web` runs on port **5173** via `npm run dev` (strictPort: true — will not drift)
- Both must be running for the app to function. If the frontend shows empty data, check the backend first.

---

## Code Changes

- Always run `tsc --noEmit` after changes to both `knowledge-hub-web` and `knowledge-hub-backend` before declaring work done.
- Never deploy to production without an explicit instruction from the user to do so.

---

## Azure Deployment Runbook

Production is deployed to Azure Container Apps (backend) + Azure Static Web Apps (frontend). There is no CI/CD pipeline — deploys are manual, run from a local/session shell via the Azure CLI. Always `tsc --noEmit` and build locally first (see Code Changes above) before deploying.

### Resources

| Purpose | Resource | Resource Group | Subscription |
|---|---|---|---|
| Backend container app | `kh-prod-api-vnet` | `rg-knowledge-hub-prod` | `Alliance Tenant Reporting` |
| Container registry | `cad79107555facr` (image `kh-prod-api`) | `rg-knowledge-hub-prod` | `Alliance Tenant Reporting` |
| Frontend static web app | `kh-prod-web` | `rg-knowledge-hub-prod` | `Alliance Tenant Reporting` |
| Main Azure OpenAI (gpt-4o / gpt-4o-mini deployments — `gpt-4o` deployment slot is actually mapped to a `gpt-5.4` model) | `open-msft-alliance-reporting-res` | `rgAllianceReporting` | `Alliance Tenant Reporting` |
| GPT-5.5 Azure OpenAI (brainstorming persona only) | `imagine-dev-temp-resource` | `rg-imagine-claims-dev-temp` | `sub-ibmc-projImagine-dev` (different subscription — `az account set` before touching it) |

### Backend deploy

```
git push origin <branch>
az account set --subscription "Alliance Tenant Reporting"
az acr build --registry cad79107555facr --image kh-prod-api:v<NN> --file Dockerfile "https://github.com/richardichogan/knowledge-base.git#<branch>:knowledge-hub-backend"
az containerapp update --name kh-prod-api-vnet --resource-group rg-knowledge-hub-prod --image cad79107555facr.azurecr.io/kh-prod-api:v<NN>
```

- `<NN>` must increment from whatever's currently deployed — check first with:
  `az containerapp show --name kh-prod-api-vnet --resource-group rg-knowledge-hub-prod --query "properties.template.containers[0].image" -o tsv`
- After updating, verify the new revision before considering the deploy done:
  `az containerapp revision list --name kh-prod-api-vnet --resource-group rg-knowledge-hub-prod --query "[].{name:name,active:properties.active,health:properties.healthState,running:properties.runningState}" -o table`
  — look for the new revision showing `Healthy` / `RunningAtMaxScale`.
- Check startup logs for migration/config errors: `az containerapp logs show --name kh-prod-api-vnet --resource-group rg-knowledge-hub-prod --tail 30`
- New secrets (API keys etc.) go through `az containerapp secret set --name kh-prod-api-vnet --resource-group rg-knowledge-hub-prod --secrets <name>=<value>`, then referenced from env vars as `--set-env-vars SOME_VAR=secretref:<name>` — never as a plain env var value.

### Frontend deploy

```
cd knowledge-hub-web
npm run build
$token = az staticwebapp secrets list --name kh-prod-web --resource-group rg-knowledge-hub-prod --query "properties.apiKey" -o tsv
npx --yes @azure/static-web-apps-cli deploy ./dist --deployment-token $token --env production
```
