# Knowledge Hub Production Deployment Plan

**Status:** Validated

## 1. Scope

Deploy diagram Title/Description properties and bidirectional note links to the
existing production backend and frontend. Migration 055 is already deployed;
optional descriptions use existing JSON storage and require no new migration:

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
