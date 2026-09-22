# Knowledge Hub Production Deployment Plan

**Status:** Validated

## 1. Scope

Deploy the existing Knowledge Hub project-management changes to production:

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
9. Verify the production `/projects` route is available.

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
- Confirm `https://nice-mud-0f780fb03.7.azurestaticapps.net/projects` responds after deployment.

## 6. Rollback

- Backend: update the Container App image back to the previously recorded image tag.
- Frontend: redeploy the prior known-good build/commit if verification fails.

## 7. Validation Proof

Validated on 2026-09-18:

- `knowledge-hub-backend`: `npx tsc --noEmit` passed.
- `knowledge-hub-backend`: `npm run build` passed.
- `knowledge-hub-web`: `npx tsc --noEmit` passed.
- `knowledge-hub-web`: `npm run build` passed.
- Azure CLI authentication confirmed for `Alliance Tenant Reporting`
  (`c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28`).
- Existing resource group confirmed: `rg-knowledge-hub-prod` in `uksouth`.
- Existing Container App confirmed healthy at the resource level:
  `kh-prod-api-vnet`, provisioning state `Succeeded`, current image `v67`.
- Existing Static Web App confirmed:
  `kh-prod-web`, hostname `nice-mud-0f780fb03.7.azurestaticapps.net`.
- No infrastructure templates are involved in this application-only deployment,
  so Bicep compilation, ARM validation, what-if, and RBAC template checks are not applicable.
