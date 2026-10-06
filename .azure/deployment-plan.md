# Knowledge Hub Production Deployment Plan

**Status:** Validated

**Deployment:** Chat recovery and current project context deployed and verified.

## 1. Scope

Deploy chat draft/session recovery and non-navigating sign-in renewal to the
frontend, plus current saved project metadata and project lookup to the backend.
No migrations, infrastructure or credential changes are required.
Retain the current Build credentials/configuration:

- Backend: Azure Container App `kh-prod-api-vnet`
- Frontend: Azure Static Web App `kh-prod-web`
- Resource group: `rg-knowledge-hub-prod`
- Subscription: `Alliance Tenant Reporting`

This is a MODIFY deployment of existing resources. No infrastructure will be created or deleted.

## 2. Architecture

| Component | Source | Azure target | Deployment method |
|---|---|---|---|
| Backend API | `knowledge-hub-backend` | Azure Container Apps | ACR remote build, then Container App image update |
| Frontend | `knowledge-hub-web` | Azure Static Web Apps | Local production build, then SWA CLI deployment |
| Database schema | Backend migrations | Existing PostgreSQL database | Existing backend startup migration runner |

## 3. Recipe

**Type:** AZCLI/manual existing-resource deployment

The repository's established production runbook is authoritative:

1. Confirm Azure subscription.
2. Type-check and build backend and frontend.
3. Read the currently deployed backend image tag and increment it.
4. Build the backend image in ACR from the pushed Git branch.
5. Update the Container App to the new image.
6. Verify the new revision is healthy and inspect startup logs for migration/configuration failures.
7. Obtain the Static Web App deployment token without printing or persisting it.
8. Deploy `knowledge-hub-web/dist` to the production Static Web App.
9. Verify the production root route and published asset are available.

## 4. Security and Safety

- Do not print, persist, or commit the Static Web App deployment token.
- Do not place secrets in source code or plain environment variables.
- Do not delete or recreate production resources.
- Do not change subscriptions other than selecting the established production subscription.
- Use the existing managed deployment configuration and resource names.

## 5. Validation Requirements

- `knowledge-hub-backend`: `tsc --noEmit` and `npm run build`
- `knowledge-hub-web`: `tsc --noEmit` and `npm run build`
- Confirm branch changes are pushed before ACR remote build.
- Confirm the new Container App revision reports healthy/running.
- Confirm backend startup logs contain no migration/configuration errors.
- Confirm the Static Web App production deployment succeeds.
- Confirm `https://athena.themicrosoftcloudblog.com/` responds after deployment.

## 6. Rollback

- Backend: update the Container App image back to the previously recorded image tag.
- Frontend: redeploy the prior known-good build/commit if verification fails.

## 7. Validation Proof

Chat recovery and project grounding deployed on 2026-10-06 (20:27 BST):

- Release `088b0bc` pushed to feature branch and remote main.
- ACR build succeeded; backend v165 revision `kh-prod-api-vnet--0000162`
  is active, Healthy and RunningAtMaxScale with 100% traffic.
- Startup logs confirm migrations completed.
- SWA production deployment succeeded; custom-domain release JS/CSS returned
  HTTP 200 and their SHA-256 hashes exactly match the local build.
- Backend environment fingerprint is unchanged, including Copilot secret
  references. No credentials, infrastructure or configuration were modified.

Chat recovery and project grounding validated on 2026-10-06 (20:23 BST):

- Fetched origin/main and confirmed it is an ancestor of the release.
- Both `npx tsc --noEmit` checks, fixture typecheck and production builds passed.
- Browser checks at 1440/1024/390px cover actual reload, draft/session recovery,
  rejected pre-auth send, acceptance-only draft clearing and history retry.
- Ten backend tests passed, including saved project edits reflected in the same
  session's next model prompt, full outputs, catalog lookup and assigned scope.
- Backend project helper lint and `git diff --check` passed. Frontend ESLint
  cannot run because the repository has no frontend ESLint configuration.
- Existing Azure targets confirmed. Backend currently v164; deploy v165,
  retain v164 for rollback. No provisioning/RBAC/template changes apply.
- Backend environment fingerprint recorded before deploy; only image/assets change.

Projects layout deployed and verified on 2026-10-06:

- Release `2e42f64` pushed to the feature branch and remote main.
- SWA CLI successfully deployed the existing production frontend.
- Production custom-domain HTML references the release JS/CSS; both returned
  HTTP 200 with SHA-256 hashes identical to the local production build.
- Backend remains `kh-prod-api:v164`; no configuration or credentials changed.

Projects layout release validated on 2026-10-06 (20:04 BST):

- Fetched remote main and confirmed it is an ancestor of the release branch.
- Frontend `npx tsc --noEmit`, fixture typecheck and `npm run build` passed;
  backend `npx tsc --noEmit` and `git diff --check` passed.
- Navigation browser checks passed at 1440/1024/390px, including shared spacing,
  filters, empty state, complete long outputs, responsive cards and edit-modal
  overflow. Build navigation and embedded Think Athena remain intact.
- Authenticated Azure reads confirmed the established production subscription,
  existing `kh-prod-web` target and backend v164.
- Frontend assets only: provisioning, RBAC/template validation, container builds,
  migrations and credential/environment updates do not apply.

Expected-output corrective release validated on 2026-10-06 (19:42 BST):

- Both TypeScript checks, fixture typecheck and production builds passed.
- Five regression tests passed, including API create/edit of 40 outputs over
  3,000 characters each with exact content preservation, rejection of blank
  and non-string entries, date round-trips and readable validation messages.
- Frontend parsing preserves full descriptions and validates existing goal,
  role and ownership limits before sending, without truncation.
- Backend request body remains limited to 1 MiB; no infrastructure, database,
  environment or credential changes.
- Current backend v163; deploy v164 and retain v163 for rollback.

Project-save fix validated on 2026-10-06 (19:30 BST):

- Synced latest remote main before building; existing Build and Project Context
  features retained.
- Both TypeScript checks and production builds passed.
- Three regression tests passed, covering list/create/edit date round-trips,
  null dates, invalid dates/ranges and readable server validation errors.
- `git diff --check` passed.
- Azure authenticated reads confirmed existing targets and backend v162,
  revision `--0000159`; use v163, retain v162 for rollback.
- No infrastructure, environment, secrets, RBAC or migration changes.

Project Context release validated on 2026-10-06 (16:37 BST):

- Backend `npm run build`, `npm run typecheck`, and ESLint for
  `src/routes/projects.ts` passed.
- Frontend `npm run build` and `npm run typecheck` passed.
- `git diff --check` passed.
- Project Context migration 058 is included by the Dockerfile's existing
  `src/db/migrations/*.sql` copy and will apply through the existing startup
  migration runner.
- Azure CLI authentication confirmed for `Alliance Tenant Reporting`
  (`c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28`); existing Container App, ACR and
  Static Web App were confirmed accessible.
- Current backend image confirmed as `kh-prod-api:v161`; deploy `v162` and
  retain `v161` as the rollback target.
- Source is based directly on `origin/main`; no infra, environment, secret,
  RBAC or resource configuration changes are included.

Project Context release deployed and verified on 2026-10-06 (15:44-15:47 UTC):

- Commit `eeba084` pushed to the feature branch and `main`.
- ACR build `ca53` succeeded for `kh-prod-api:v162`.
- Container App revision `kh-prod-api-vnet--0000159` reports Healthy,
  RunningAtMaxScale, with 100% traffic.
- Startup logs confirm `058_project_context.sql` applied and migrations
  completed successfully.
- Static Web Apps CLI reported successful production deployment.
- Production HTML references `/assets/index-CYhNBEaH.js` and
  `/assets/index-DiHA3HWK.css`; both assets returned HTTP 200 from the custom
  production hostname.
- Existing unrelated log noise observed: GitLab sync returns 401; rate-limit
  middleware reports an X-Forwarded-For/trust-proxy warning.

Recovery release validated on 2026-10-06 (12:25 BST):

- Merged latest main `c2513f0`, retaining the GitHub Copilot Build pipeline,
  diagrams, note/output handoffs and migrations 055/056.
- Both `npx tsc --noEmit` checks, frontend fixture typecheck and both production
  builds passed.
- 59 tests passed across Build runner, diagram validation/geometry, Spark
  creation, recent activity, Today and navigation.
- Navigation browser checks passed at 1440/1024/390px with Build present in
  desktop/mobile navigation; Today checks passed at 1440/390px.
- Azure authenticated read confirmed current backend v158, ready revision
  `--0000155`. Use v159; retain v158 for rollback.
- Existing GitHub token secret reference is retained. Deployment only changes
  the container image and frontend assets; no environment, secret, RBAC or
  infrastructure settings will be modified.
- Build implementation files are unchanged from latest main. The recovered
  shell exposes Build through shared navigation and the command palette.

Frontend-only launcher cleanup validated on 2026-10-04 (22:13 BST):

- Frontend and backend `npx tsc --noEmit` passed.
- Frontend `npm run build` and `git diff --check` passed.
- Navigation browser checks passed at 1440px, 1024px and 390px, including no
  floating control and a disabled Think toolbar launcher in every mode.
- Today browser checks passed at 1440px and 390px, including removal of the
  redundant prompt area and preservation of item-specific context handoffs.
- Azure authenticated reads confirmed subscription `Alliance Tenant Reporting`
  and the existing `kh-prod-web` Static Web App in West Europe.
- No provisioning, Container App update, RBAC changes or migrations apply.

Deployment completed on 2026-10-04 (21:53 BST):

- Application commit `66a4d32` pushed to `richardichogan-athena-spark-creation`.
- ACR run `ca4v` successfully built backend image `kh-prod-api:v155`.
- Container App revision `kh-prod-api-vnet--0000152` is active, `Healthy`,
  `RunningAtMaxScale`, and receives 100% of production traffic.
- Startup logs confirm migrations completed and the database pool connected.
  Existing note-image UUID lookup failures and a proxy/rate-limit configuration
  warning were observed in unchanged code; they did not prevent startup.
- Static Web Apps CLI successfully deployed the frontend to production.
- `https://athena.themicrosoftcloudblog.com/` returned the current build;
  published JavaScript and CSS SHA-256 hashes match the local build exactly.
- No resource, RBAC, secret, region or schema changes were made.

Validated on 2026-10-04 (21:49 BST) for the current full deployment:

- Backend `npx tsc --noEmit` and `npm run build` passed.
- Frontend `npx tsc --noEmit` and `npm run build` passed.
- Spark, recent activity, Today model and navigation unit tests: 21 passed.
- Navigation browser checks passed at 1440px, 1024px and 390px; Today browser
  checks passed at 1440px and 390px before deployment.
- `git diff --check` passed.
- Azure CLI authenticated reads confirmed the existing production subscription,
  resource group, Container App, ACR and Static Web App.
- Current backend image is `cad79107555facr.azurecr.io/kh-prod-api:v154`;
  deploy `v155` and retain `v154` as the rollback target.
- Dockerfile and lockfile verified: ACR will build the pushed branch with locked
  dependencies, compiled TypeScript and existing migrations.
- No templates, provisioning, policy changes, region changes, RBAC changes or
  schema migrations are involved. Existing registry authentication uses a
  Container App secret reference, not a managed identity; the new-identity
  AcrPull propagation gate is not applicable.
Properties and note-link deployment validated on 2026-10-06 (06:00 BST):

- Backend `npx tsc --noEmit` and `npm run build` passed.
- Frontend `npx tsc --noEmit` and `npm run build` passed.
- Latest fixture typecheck and desktop/mobile browser checks passed, covering
  properties, persistence/undo/duplication, linking/opening/unlinking notes,
  Connections return links and saving pending note edits before diagram creation.
- Backend document validation tests passed (22).
- Authenticated reads confirmed the production subscription is Enabled and both
  existing deployment targets are accessible.
- Previous backend image is `kh-prod-api:v156`; this deployment uses `v157`.
- Dockerfile and locked dependency build reviewed. ACR builds the exact pushed
  commit before the Container App is updated.
- No infrastructure, RBAC, policy, credentials, environment variables or schema
  changes: template compilation/what-if/provisioning checks are not applicable.

Two-canvas deployment validated on 2026-10-06 (05:14-05:18 BST):

- Backend `npx tsc --noEmit` and `npm run build` passed.
- Frontend `npx tsc --noEmit` and `npm run build` passed.
- Completed implementation verification includes 30 geometry checks, 21 backend
  validation/conflict checks, 10 Today regression checks and actual editor
  browser interactions at 1440px/390px (including icon paste/library,
  save/reopen/conflicts, export and desktop pointer/nesting/resize/connect).
- Existing resource reads confirmed subscription
  `c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28`, resource group `rg-knowledge-hub-prod`
  in `uksouth`, Container App `kh-prod-api-vnet` and Static Web App `kh-prod-web`.
- Previous backend image is `kh-prod-api:v155`, ready revision `--0000152`;
  this deployment uses `v156`.
- Dockerfile reviewed: locked dependencies, TypeScript build and migration 055
  copied through `src/db/migrations/*.sql` into the runtime image.
- No new environment variables or resources are required. Existing registry
  secret authentication is unchanged; managed-identity AcrPull propagation
  checks are not applicable. No infrastructure/RBAC/policy templates change,
  so Bicep/ARM/what-if/provisioning checks are not applicable.
- ACR will build and verify the exact pushed source before the image update.

Frontend-only correction validated on 2026-10-04 (13:37 BST):

- Frontend `npx tsc --noEmit`, fixture typecheck and `npm run build` passed.
- Backend `npx tsc --noEmit` passed; no backend changes or deployment required.
- Actual Discover/Think component comparisons and Today interactions passed at
  1440px and 390px, using isolated test data.
- Azure CLI authenticated resource read confirmed the existing `kh-prod-web`
  target in subscription `c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28`.
- Infrastructure, container builds, migrations and RBAC changes are not applicable:
  only the existing Static Web App's frontend content is being replaced.

Validated on 2026-10-04 (11:10-11:15 BST):

- `knowledge-hub-backend`: `npx tsc --noEmit` passed.
- `knowledge-hub-backend`: `npm run build` passed.
- `knowledge-hub-web`: `npx tsc --noEmit` passed.
- `knowledge-hub-web`: `npm run build` passed.
- Azure CLI authentication confirmed for `Alliance Tenant Reporting`
  (`c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28`).
- Existing resource group confirmed: `rg-knowledge-hub-prod` in `uksouth`.
- Existing Container App confirmed:
  `kh-prod-api-vnet`, ready revision `--0000150`, current image `v153`.
- Existing Static Web App confirmed:
  `kh-prod-web`, hostname `nice-mud-0f780fb03.7.azurestaticapps.net`,
  custom domain `athena.themicrosoftcloudblog.com`.
- Production frontend build confirmed to reference the existing Container App API.
- Today model regression tests (9), export regression tests (4), and isolated
  browser interaction checks at 1440px and 390px passed before deployment.
- Dockerfile reviewed: locked dependencies, TypeScript build, schema and
  migrations copied into the production image. ACR performs the container build.
- No infrastructure templates are involved in this application-only deployment,
  so Bicep compilation, ARM validation, what-if, and RBAC template checks are not applicable.

### Login regression fix — frontend only (backend v165 unchanged)

- Cause: the popup-based "Sign in again" (commit `088b0bc`) needed an MSAL 5 `/signin` redirect bridge that was never added, so login was broken.
- Fix: `auth.ts`, `SignInGate.tsx` and `main.tsx` are restored to their exact pre-`088b0bc` versions; `git diff --stat 088b0bc~1` for these files is empty. The banner CSS and `SignInRequiredError` handling were removed. Saving chat drafts in session storage is unchanged.
- `npx tsc --noEmit` passed for the web app, test fixtures and backend.
- Browser suite passed at 1440, 1024 and 390, including the real reload test that preserves the draft and session.
- `npm run build` passed.
- Deployed to SWA `kh-prod-web` from `c064710`. Production `index-r_DrYltu.js` and `index-Dg_rYtuc.css` match the local build by SHA-256. The live bundle contains `acquireTokenRedirect` and none of the popup code.
