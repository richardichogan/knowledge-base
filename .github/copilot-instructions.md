# GitHub Copilot Instructions

These rules apply to every change made in this repository. Follow them without exception.

Path-specific rules live in `.github/instructions/*.instructions.md` (each scoped via an `applyTo` glob) and load automatically when you touch matching files:
- `frontend.instructions.md` — `knowledge-hub-web/**` (styling, AppShell structure, compact-widget CSS)
- `backend.instructions.md` — `knowledge-hub-backend/**` (server, migrations)
- `athena-persona.instructions.md` — Athena AI persona files in both frontend and backend

---

## Athena Design Guide — MUST FOLLOW

- **You MUST always follow the Athena design guide in `DESIGN.md` for every UI change. This is mandatory, not optional guidance or a final polishing step.**
- Read `DESIGN.md` and the relevant frontend instructions before creating or changing any interface, including pages, modals, panels, chat widgets, controls and their states.
- Use the guide's existing Athena/Carbon tokens, typography, spacing, hierarchy, components and interaction patterns from the first implementation. Do not introduce generic dashboard styling, raw unstyled controls or a competing visual identity.
- A UI change is not complete until it conforms to the guide, including relevant loading, empty, error, disabled, hover and keyboard-focus states. Preserve the guide's desktop and compact-chat distinctions.
- If the requested design conflicts with the guide, ask the user before deviating. Do not silently override or rewrite the guide to justify an implementation.

---

## Terminal Commands — STRICT RULES

- **Never use `head` or `tail` to truncate command output.** Run the full command or use `grep` to filter specifically.
- **Never use `curl` to test endpoints.** If an endpoint needs testing, use the existing API client or logs.
- **NEVER run test suites mid-development, including targeted or single-feature suites.** Do not run test runners while implementing, debugging or iterating. Suite execution is allowed only after the requested work is complete, immediately before an explicitly requested push or deployment. A request to implement, fix, commit or merge is not permission to run suites.
- **Full test suites (full unit, full browser, CI-equivalent runs) remain deployment-only.** Before an explicitly requested push, use only directly affected tests; before a deployment, run required full suites once. Rerun only failed or affected checks unless new evidence requires broader coverage. During development, use the required `tsc --noEmit` checks and direct inspection of the actual running application, not suites, synthetic evaluations or repeated verification loops.
- **Mobile browser testing is for the chat interface only.** All other browser journeys (including navigation, Today, Discover, notes and diagrams) must be desktop-only. Do not launch a local browser without explicit user permission.
- **Finish the requested feature before testing broadly or verifying in the browser.** Do not get sidetracked into extra checks while the feature is incomplete.
- **Never pipe to `| cat`** just to disable a pager — use `--no-pager` flags where available (e.g. `git --no-pager`).

---

## Server Management

- Before starting servers, always check if they are already running to avoid EADDRINUSE errors.
- Backend: `knowledge-hub-backend` runs on port **3000** via `node --import tsx/esm src/server.ts`
- Frontend: `knowledge-hub-web` runs on port **5173** via `npm run dev` (strictPort: true — will not drift)
- Both must be running for the app to function. If the frontend shows empty data, check the backend first.

---

## Code Changes

- Follow the user's specification, including data source and workflow, without substituting a different implementation. Athena content in local development uses the production database: real drafts and approvals must work against shared production data, not an isolated snapshot or synthetic preview. Keep local automatic delivery disabled; do not disable requested editing or scheduling just because the application is running in development.
- Always run `tsc --noEmit` after changes to both `knowledge-hub-web` and `knowledge-hub-backend` before declaring work done.
- Never deploy to production without an explicit instruction from the user to do so.

---

## Token and Execution Budget — STRICT RULES

- Treat tokens, tool calls and execution time as the user's money. Use the smallest scope that fully delivers the requested outcome.
- Do not launch agents or parallel work speculatively. Prefer direct, focused work; delegate only when explicitly requested or required.
- Read only relevant files and ranges. Reuse evidence already gathered; do not repeat scans, checks or builds without a concrete reason.
- Do not run production builds outside an explicitly requested deployment unless the requested task specifically requires build verification.
- Avoid open-ended review, browser verification and polishing loops. Stop once the requested outcome is implemented and sufficiently verified.
- Keep responses concise. Report the result, material uncertainty or blocker; omit repetitive narration and unsolicited extras.
- If substantial extra work is needed beyond the request, ask before spending resources on it.

---

## Azure Deployment Runbook

Production is deployed to Azure Container Apps (backend) + Azure Static Web Apps (frontend). There is no CI/CD pipeline — deploys are manual, run from a local/session shell via the Azure CLI. Always `tsc --noEmit` and build locally first (see Code Changes above) before deploying.

### Deployment scope and stopping rule

- A request to deploy existing changes is deployment-only, not permission for another review, feature iteration, refactor or unrelated fix. Follow this runbook against the existing production targets; do not reopen settled infrastructure decisions.
- Reuse completed validation for unchanged code. Run each required full release suite at most once; after a failure or necessary code fix, rerun only failed or directly affected checks. An interrupted or locally aborted suite is not a reason to restart every suite.
- Fix genuine release blockers narrowly. If resolving a blocker requires substantial extra work, explain it and ask before expanding the task; never silently ignore a known failure.
- Keep release bookkeeping consolidated. Do not make repeated documentation-only commits for intermediate check results.
- Stop after the intended release is pushed, deployed, and confirmed healthy with startup/migration logs and the served frontend checked. Do not append an unsolicited audit or polishing pass.

### Resources

| Purpose | Resource | Resource Group | Subscription |
|---|---|---|---|
| Backend container app | `kh-prod-api-vnet` | `rg-knowledge-hub-prod` | `Alliance Tenant Reporting` |
| Container registry | `cad79107555facr` (image `kh-prod-api`) | `rg-knowledge-hub-prod` | `Alliance Tenant Reporting` |
| Frontend static web app | `kh-prod-web` | `rg-knowledge-hub-prod` | `Alliance Tenant Reporting` |
| Main Azure OpenAI (gpt-4o / gpt-4o-mini deployments — `gpt-4o` deployment slot is actually mapped to a `gpt-5.4` model) | `open-msft-alliance-reporting-res` | `rgAllianceReporting` | `Alliance Tenant Reporting` |
| GPT-5.5 Azure OpenAI (brainstorming persona only) | `imagine-dev-temp-resource` | `rg-imagine-claims-dev-temp` | `sub-ibmc-projImagine-dev` (different subscription — `az account set` before touching it) |

### Pre-deploy sync (always first)

Build-pipeline agents merge straight into `main` on GitHub, so a local worktree can be behind. The backend image is built from GitHub but the frontend is built from the local worktree. Deploying a stale frontend silently reverts agent changes. Before every deploy:

```
git fetch origin
git merge origin/main      # stop and ask the user if this conflicts
npx tsc --noEmit           # in both knowledge-hub-web and knowledge-hub-backend
git push origin HEAD:<branch>
git push origin HEAD:main
```

Then build the backend from `#main:knowledge-hub-backend` and the frontend from this synced worktree.

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

### Athena Desktop release (Electron, `athena-desktop/`)

The desktop app loads the hosted site, so web/backend changes reach it through the normal deploys above. Only rebuild it when `athena-desktop/` changes. Bump `version` in `athena-desktop/package.json` first; installed copies auto-update from the GitHub release.

```
cd athena-desktop
npm test
powershell -File scripts\install-signing-cert.ps1   # once per PC; puts the Key Vault cert in CurrentUser\My
npm run dist                                         # signed installer in release\
$env:GH_TOKEN = gh auth token; npm run release       # publishes the GitHub release for auto-update
```

Never commit the certificate or anything under `athena-desktop/release/`.
