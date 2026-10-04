# Knowledge Hub Production Deployment Plan

**Status:** Validated

## 1. Scope

Deploy the frontend-only Athena launcher cleanup: remove the floating control
on every screen, disable the toolbar launcher throughout Think, and remove
Today's redundant prompt box and suggestions. Backend v155 remains unchanged.
No database schema or infrastructure changes are included:

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

- For this frontend-only release, backend build/image/revision steps are not
  applicable; retain the existing backend. Both TypeScript checks and the
  frontend production build must pass.
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
