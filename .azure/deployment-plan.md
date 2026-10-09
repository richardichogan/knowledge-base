# Knowledge Hub Production Deployment Plan

**Status:** Validated

**Deployment:** Project-only GitHub destinations, readable title filenames and dark diagram shapes.

## 1. Scope

Approved 2026-10-09 at 08:24 BST: deploy, merge and push commits `2656a76`
and `310536b`. Deploy backend v174 then the matching full frontend release.
Use existing production resources and registry credentials. No migrations,
data repair, infrastructure, secret, environment, authentication or role changes.
Rollback: backend v173 and frontend source `bbadbde`.

Approved on 2026-10-08 at 21:42 BST: deploy correction `6950018` to the
existing production targets. Reject unavailable project repository defaults,
disable publishing until folder access succeeds, show actionable API errors,
and replace KH icons with cache-busted Athena artwork.
Backend advances from v172 to v173; frontend follows. No data writes,
new migrations, infrastructure, credentials, environment or role changes.
Rollback: backend v172 and frontend source `b14f62a`.

Approved on 2026-10-08: deploy the GitHub note publication changes in this
workspace. Publish to the chosen writable repository and path, preserving
Think as the master and suppressing duplicate GitHub document context.
Apply additive migration 061 through the existing backend startup runner.
Backend advances from v171 to v172; deploy it before the matching frontend.
No infrastructure, secrets, environment, RBAC or authentication changes.
Rollback: backend v171 and frontend source `64307d2`; migration 061 remains.

Validation for this release (2026-10-08 21:15 BST):
- Backend and frontend `npx tsc --noEmit` and production builds passed.
- Publishing/history/Markdown/project-context tests passed (13 tests).
- Backend publishing files passed the existing ESLint rules.
- Publishing browser fixture passed at 1440 and 390, including repository and
  nested folder selection, failed pushes, autosave and external conflict review.
- Existing history and navigation browser fixtures passed.
- Azure target verified: `Alliance Tenant Reporting`, existing Container App
  `kh-prod-api-vnet` currently v171, SWA `kh-prod-web`.
- Existing Dockerfile copies all migrations; dependency lockfile is updated.
- No infrastructure template or role modifications; provisioning/what-if N/A.
- ACR remote Docker build must succeed before changing the production image.
- `git diff --check` passed; remote main fetched with no newer commits.

Approved by the user on 2026-10-08: deploy all undeployed application code
from the current feature branch, not another isolated/cherry-picked release.
Include Think-only bounded recovery history (`ddb3a66`) and migration 060,
the Markdown handoff fix (`1a899a2`), and the new notes-list Refresh control.
Preserve the deployed authentication callback and IMAGINE brief features.
No changes to infrastructure, secrets, permissions, environment or existing
note bodies. Backend image advances from v170 to v171; deploy backend before
the matching full frontend build. Rollback baseline: backend v170 and frontend
tag `imagine-demo-brief-2026-10-08`. Migration 060 is additive and remains on rollback.

Previous release record:

Current deployment (2026-10-08 12:08 BST): isolated release `412ba5c`, based on
deployed auth-only `aa4f208` plus IMAGINE brief feature `c1bd9be`, with conflicts
resolved to retain the production note editor (no history changes).
Deploy backend v170 and `.imagine-brief-release/knowledge-hub-web/dist`.
No migration 060, note recovery history, infrastructure, secrets, RBAC or
environment changes are included. Preserve the callback/bootstrap auth fix.
Release source is published under `imagine-demo-brief-2026-10-08`.
Rollback: backend v169; frontend tag `auth-callback-hotfix-2026-10-08`.

Previous deployment (2026-10-08 11:29 BST): frontend-only authentication hotfix.
Release `aa4f208` uses deployed baseline `616f895` plus only the callback/bootstrap
production files from fix `1eb6bb2`. Do not deploy Think history (`ddb3a66`),
backend changes, migration 060, or any infrastructure/configuration changes.
Backend stays v169. Deploy only `.auth-hotfix-release/knowledge-hub-web/dist`.
The prior scope and evidence below remain as the previous release record.

Deploy session-expired messaging with user-initiated Microsoft popup renewal,
Think Copy note (including unsaved edits), and connection-only checks every
15 minutes. Apply migration 059 through the existing startup runner: content
version view and durable assessment checkpoints, baselining existing content
without AI backfill or re-indexing.
Fetch and integrate remote main before merging, pushing and deploying.
No infrastructure or credential changes are required.
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

All validation checks pass:
- Azure CLI/authentication and existing ACA/ACR/SWA resource reads passed.
- No IaC changes: Bicep compilation, template validation, what-if and static
  role changes are not applicable to this existing-resource image/content update.
- Dockerfile/lockfile build context verified; ACR build must pass before image update.
- Both app typechecks/builds, browser fixture typecheck and isolated regressions passed.

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

Validated 2026-10-09 (08:25 BST), combined release:

- Both apps: `npx tsc --noEmit` and `npm run build` passed.
- Frontend fixture typecheck passed. Backend combined test selection passed
  9 tests plus 30 geometry assertions: project-only allowlist, pagination,
  duplicate/renamed repositories, readable Unicode filenames, publishing,
  history, dark legacy/new shape surfaces and unchanged legacy exports.
- Desktop/mobile publishing and diagram browser fixtures passed during
  implementation at 1440/390px; actual SVG fills and label contrast checked.
- Real project database and production GitHub account checks passed:
  16 writable configured destinations, folder browsing, unconfigured rejection.
- Azure authenticated to established Alliance Tenant Reporting subscription;
  backend currently v173, v174 absent. Remote main is ancestor of release.
- No changed IaC/RBAC: template/what-if/provisioning/new-role checks N/A.
  Existing registry secret authentication retained. ACR Node 20 build is
  mandatory before image update. `git diff --check` passed.

Deployed 2026-10-08 (21:50 BST), correction `6950018`:

- ACR run `ca5f` built and pushed backend v173 successfully on Node 20.
- Revision `kh-prod-api-vnet--0000170` Healthy / RunningAtMaxScale,
  the only active revision. Startup migrations completed.
- SWA production deployment succeeded. Both production hostnames serve
  byte-matching release HTML, `index-hBiedstu.js`, callback/bootstrap chunks,
  versioned Athena SVG favicon, 192/512px PNG icons and app manifest.
- Live authenticated API checks passed: screenshot destination returns
  actionable 403 instead of 502; writable list excludes it; client-demo
  root and docs folder browsing succeeds on master.
- New and prior revision environment values and secret references match
  after normalization; no credentials, roles or infrastructure changed.
- Production endpoint: https://athena.themicrosoftcloudblog.com/
- No production note writes were performed during verification.

Validated 2026-10-08 (21:43 BST), correction `6950018`:

- Both apps: `npx tsc --noEmit` and `npm run build` passed on exact release.
- Frontend: `npx tsc --noEmit -p tests/tsconfig.json` passed.
- Backend publishing/history tests passed: 4 tests, including inaccessible
  project repository, conflict handling, retries and canonical identity.
- Existing browser fixture passed at 1440/390px before commit: unavailable
  default excluded, failed folder browse blocks Push, paginated default
  verification, complete publish/conflict flow, favicon URL/artwork and
  192/512px app icon dimensions and teal pixel checks.
- Corrected service passed real production GitHub account reads: inaccessible
  screenshot destination gives actionable 403; client-demo root/docs browse
  on master; content-store root on main; writable list excludes missing repo.
- Azure CLI authentication and existing ACA/ACR/SWA reads passed; current
  image v172, v173 absent. Existing registry secret authentication retained.
- Dockerfile and lockfile verified; successful ACR Node 20 build required
  before image update. No changed IaC/RBAC: compilation/what-if/provisioning
  and new-role verification not applicable to image/static-asset update.
- `git diff --check` passed and remote main is an ancestor of release.

### GitHub note publication release — 2026-10-08

Deployed from `e8d01e9` at 21:19 BST:
- ACR run `ca5e` built and pushed `kh-prod-api:v172` successfully on Node 20.
- New revision `kh-prod-api-vnet--0000169` is `Healthy` / `RunningAtMaxScale`;
  it is the only active revision.
- Startup applied `061_note_github_publications.sql` and completed migration.
- Startup publication and content-store sync completed with zero errors.
- SWA production deployment succeeded. Live `index-Dj0NWIqd.js`,
  `signinCallback-bh-pVR6x.js` and `appBootstrap-GzWjllnT.js` match local
  release files by SHA-256.
- Container environment hash is unchanged from the baseline below.
- Production endpoint: https://athena.themicrosoftcloudblog.com/
- Existing GitLab sync reports 401 Unauthorized; unrelated credentials were
  not changed by this deployment.

Both apps passed `npx tsc --noEmit` and production builds on the exact release
tree. Backend publishing/history tests, safe Markdown and project-context
regressions passed (13 tests). Existing backend ESLint passed for publishing
files. Browser publishing, history and navigation fixtures passed across their
desktop/mobile widths. Repository picker, folder browser, error retention,
outside-edit review, stale revision checks, durable retries, vector cleanup
failure/retry and one canonical indexed identity are covered.
The configured GitHub HTTP transport was exercised against deterministic
responses; no test created or overwrote a real GitHub note.
Azure CLI confirmed the existing production targets and v171 baseline.
Container environment baseline hash:
`e6711ced8216f8c3f78d1be68b7753f66f815b28e1df7a069aad927f190ed878`.
Migration 061 is included by the unchanged Dockerfile. No infrastructure or
role changes; Bicep, provisioning and new-role checks are not applicable.
ACR remotely builds the actual Docker image before the Container App update.

Deployed 2026-10-08 (12:39 BST), full application release `a7d8cfd`:

- Full source branch pushed, including previously undeployed history and
  Markdown conversion. No isolated/cherry-picked application release.
- Local-context packaging encountered an old untracked `node_modules_backup`
  directory. Rebuilt from a clean `git archive` of exact committed backend
  source instead; ACR run `ca5d` succeeded for v171, digest
  `sha256:85176ae6b35af80db51facbd0e1fdf4781939b96102635a5eced7815181ab854`.
- Backend revision `kh-prod-api-vnet--0000168` is Healthy/RunningAtMaxScale
  and receives 100% traffic. Startup logs confirm migration 060 applied and
  migration completion; existing notes were not rewritten or reindexed.
- Backend environment fingerprint unchanged; no secret, role or configuration
  changes. Existing secret-reference registry pull configuration retained.
- Full frontend SWA production deployment succeeded. Custom/default host HTML
  at `/`, `/signin` and `/think` matches the local build; all five
  entry/bootstrap/callback asset SHA-256 hashes match.
- Production entry `/assets/index-CpoiEcZ7.js` includes the full application
  release. Live synthetic auth popup success/error checks passed at 1440/390px
  with popup closing and original page retained.
- No production note writes were performed during verification. Real-account
  acceptance remains user-owned; existing malformed notes remain untouched.

Validated 2026-10-08 (full pending release):

- Azure account and ACA/ACR/SWA read checks passed for the existing production
  subscription/resources; current image is v170.
- Both application `npx tsc --noEmit` and `npm run build` passed.
- Frontend fixture `npx tsc --noEmit --project tests/tsconfig.json` passed.
- Backend offline tests: history, Markdown conversion, full Think export and
  IMAGINE brief all passed (12 tests, including isolated PostgreSQL migration 060).
- Browser checks at 1440/390px passed for notes refresh (new items, search and
  selection preservation, duplicate blocking, error retention/retry, collapsed
  rail), history/restore/conflicts, Markdown editor roundtrip, IMAGINE export,
  whole-note copy and the official MSAL callback bridge.
- Failed list refresh previously triggered the initial-load error screen;
  now cached-list errors retain the mounted page/editor, verified by the fixture.
- Dockerfile includes migration 060 and production dependency lockfile.
  Remote ACR build is required to pass before updating the image.
- No IaC or RBAC changes; template/what-if/static-role checks are not applicable.
  Existing registry secret-reference authentication is retained.
- No production note writes or user-data repair were performed by validation.

Deployed 2026-10-08 (12:10 BST), isolated IMAGINE brief release `412ba5c`:

- Release tag `imagine-demo-brief-2026-10-08` published to origin.
- Remote Git-context ACR run `ca5b` could not download source. Retried with the
  exact validated local release context after removing the dependency junction;
  ACR run `ca5c` succeeded for v170 (digest
  `sha256:1942459c0b3b8c8d4679b71b8fc0091b6d9d5cd0ae72677d835f38277a68a62e`).
- Backend revision `kh-prod-api-vnet--0000167` is Healthy/RunningAtMaxScale,
  active with 100% traffic. Startup migrations complete through 059; no 060.
- Backend environment exactly matches its pre-deployment fingerprint. Registry
  credentials, secrets, roles and resource configuration were not changed.
- SWA production deployment succeeded from the exact isolated frontend build.
  Custom and default host HTML at `/` and `/signin` matches local release HTML;
  all five entry/bootstrap/callback JS/CSS SHA-256 hashes match.
- Production entry: `/assets/index-CM7-ja_a.js`.
- Real production-library popup callback checks passed at 1440/390px for
  success/error relay, popup closing and original page preservation. These
  synthetic callback checks do not claim real-account browser acceptance.
- Think history remains unreleased. No production notes were written during
  verification. Release-specific skill/source/export checks ran offline.

Validated 2026-10-08 (12:08 BST), isolated IMAGINE brief release `412ba5c`:

- Exact-release backend and frontend `npx tsc --noEmit` and production builds passed.
- Offline PostgreSQL brief persistence tests passed: exact Markdown, same-output
  revisions, required sections/tables and unchanged downstream Build instruction.
- Exact-release browser checks at 1440/390px passed: full unsaved source, no
  automatic send or note replacement, persona selection, confirmation/cancel,
  error preservation, clipboard/export and Use case-only shortcut.
- Existing whole-note Copy browser regressions passed at 1440/390px.
- Azure CLI authenticated to established Alliance Tenant Reporting subscription;
  existing ACA/ACR/SWA reads passed. Current image v169; v170 not already present.
- Fetched origin/main (`616f895`); production baseline includes it and auth hotfix.
- Dockerfile and committed lockfile verified; ACR container build is the deployment
  gate before updating the image. Registry uses the existing secret reference,
  not managed identity; no AcrPull/provisioning gate applies.
- No infrastructure/template/policy/RBAC changes: compilation, what-if and new
  region selection do not apply to this existing-resource image/assets update.
- Existing backend environment captured privately for post-deployment comparison.
- Frontend ESLint remains unavailable because no frontend configuration exists;
  TypeScript, production build and browser checks passed.

Deployed 2026-10-08 (11:37 BST), auth-only hotfix:

- SWA production deployment succeeded from isolated release `aa4f208`.
- Custom domain and default SWA host both serve matching release HTML at `/`
  and `/signin`; entry, app bootstrap and callback JS/CSS SHA-256 hashes match
  the auth-only local build.
- Entry `/assets/index-Dsn5b7Fp.js`; callback
  `/assets/signinCallback-bh-pVR6x.js`; app bootstrap
  `/assets/appBootstrap-Ch-2pX_h.js`.
- Live custom-domain browser checks at 1440/390px passed: synthetic success/error
  callback payloads returned via the actual deployed MSAL bridge, popup closed,
  original page and unsaved-state sentinel remained mounted. No real account
  credentials or authentication codes were used in these isolated checks.
- Backend remains v169; no database migration or Think history deployment.

Validated 2026-10-08 (11:33 BST), auth-only hotfix:

- Isolated release `aa4f208` built from deployed baseline `616f895`; git diff
  contains only six callback/bootstrap frontend file changes, no history code.
- Release frontend `npx tsc --noEmit`, `node tests/auth-session.test.mjs` and
  `npm run build -- --logLevel error` passed using existing production environment.
- Both current-app typechecks passed during hotfix verification.
- Real MSAL 5.23 redirect-bridge browser checks passed at 1440/390px: popup
  broadcast and closure, OAuth errors, query/hash callbacks, malformed-response
  recovery, no app/sign-in bootstrap in callback, full-page redirect return.
- Existing session dialog checks passed at 1440/390px: retained unsaved writing,
  cancellation/retry, explicit renewal, no automatic navigation.
- Azure authenticated subscription and existing SWA kh-prod-web confirmed.
  Backend remains cad79107555facr.azurecr.io/kh-prod-api:v169.
- No IaC, resource, RBAC, credentials, API or database changes; template checks,
  container build, provisioning and managed-identity role changes not applicable.
- Rollback: redeploy frontend build from prior deployed baseline 616f895.

Deployed 2026-10-08 (09:32 BST):

- Release `9195b45` pushed to main and feature branch.
- ACR run `ca5a` succeeded from exact release SHA; backend v169 digest
  `sha256:886b25061d86ce229379edd770fa069261462d4eb61d06e7c95a84790cf9d950`.
- Revision `kh-prod-api-vnet--0000166` Healthy / RunningAtMaxScale,
  latest ready matches and latest revision receives 100% traffic.
- Migration 059 applied successfully; migration complete, DB pool warmed 8/8.
  Startup confirms 15-minute incremental connection schedule. All 88 notes
  already plain-text indexed: existing startup reindex had nothing to do.
- SWA production deployment succeeded. Custom-domain root and release assets
  `/assets/index-KZixD-TS.js`, `/assets/index-BK4Aue92.css` returned HTTP 200;
  JS/CSS SHA-256 hashes matched the local production build.
- No credentials, infrastructure, environment or RBAC changes. Registry retains
  existing secret authentication; backend rollback image v168.

Validated 2026-10-08 (09:29 BST):

- Both app `npx tsc --noEmit` and production builds passed.
- Frontend `npx tsc --noEmit -p tests\tsconfig.json` passed.
- Eight mocked connection/Spark regressions and auth token-flow regression passed.
- Desktop/mobile auth and whole-note-copy browser fixtures passed at 1440/390px:
  explicit renewal, cancellation/retry, retained draft, whole current note,
  title fallback, paragraph/list preservation and clipboard error feedback.
- Migration 059 and actual incremental job SQL previously passed isolated PGlite
  PostgreSQL execution: baseline, body-only changes, concurrent edits, timestamp-only
  changes, new nodes, candidates and checkpoints. No production test writes.
- Dockerfile copies all migrations into dist; package-lock/build context retained.
- Fetched origin/main; it matches HEAD before release. `git diff --check` passed.
- Azure account and existing ACA/SWA targets confirmed in Alliance Tenant Reporting.
  Current backend v168; next v169. Rollback image v168.
- No IaC/provisioning/policy/RBAC changes: template compilation/what-if not applicable.
  Registry uses existing secret authentication, identity None; no managed-identity
  AcrPull provisioning applies. Existing source-sync/backfill schedules unchanged.
- Actual ACR container build must succeed before image update.

Deployed 2026-10-07 (17:02 BST):

- Release `4873801` pushed to main and feature branch.
- ACR run `ca59` succeeded from the exact release SHA; image v168 digest
  `sha256:720d2c0f2505ed5e6b0f1902bbf9e7fecd45ff937ebaf41df182402d96dcd0af`.
- Revision `kh-prod-api-vnet--0000165`: Healthy / RunningAtMaxScale;
  latest ready revision matches, with 100% latest-revision traffic.
- Startup migrations completed and DB pool warmed 8/8; all 86 notes already
  indexed. No migration/configuration failure in new revision startup logs.
- SWA production deployment succeeded. Custom-domain root returned HTTP 200 and
  references `/assets/index-78cijhmb.js` and `/assets/index-CeYa3q1U.css`.
  Both assets returned HTTP 200 and SHA-256 matched the local production build.
- Existing registry uses its configured secret, not managed identity;
  no AcrPull/RBAC provisioning applies. No infrastructure, secrets or environment
  settings changed. Rollback image remains v167.
- Expanded GitHub nodes populate on the next regular sync; thematic suggestions
  use the existing scheduled inference job, not an immediate production backfill.

Connections / Spark release validated 2026-10-07 (17:00 BST):

- Both apps: `npx tsc --noEmit` and `npm run build` passed.
- `node --import tsx --test scripts\connections.test.ts`: all five isolated
  mocked tests passed without production data writes.
- Web `npx tsc --noEmit -p tests\tsconfig.json` passed. Desktop/mobile
  connections browser checks passed at 1440/390px before this deploy request:
  mixed types, visible reasons, selected-text provenance, mapping, retry and navigation.
- Backend targeted ESLint and `git diff --check` passed. Frontend has no ESLint
  configuration; production typecheck/build and browser assertions used instead.
- `git fetch origin`: HEAD and origin/main match before release commit.
- Azure account/ACA/ACR/SWA reads passed; current image v167, deploy v168.
  Rollback: `cad79107555facr.azurecr.io/kh-prod-api:v167`.
- Existing Dockerfile and package-lock verified. No provisioning, IaC, migrations,
  credentials, environment or RBAC changes; retain deployed security configuration.

Preparation 2026-10-07 (16:55 BST): existing AZCLI recipe and production targets
retained. User explicitly approved deployment. No infrastructure, migrations,
credentials or environment changes. Existing local builds, five mocked graph /
Spark tests and desktop/mobile browser checks passed; fresh deployment
validation pending. Broken-image detector on the context-menu preview is a false
positive: the image renders only when its actual runtime URL is present.

Deployed 2026-10-07 (16:30 BST):

- Release `4980622` merged/pushed to main and feature branch.
- ACR run `ca58` succeeded. Backend v167 revision
  `kh-prod-api-vnet--0000164` is Healthy / RunningAtMaxScale with 100% traffic.
- Startup migrations completed; note reindex rebuilt 4/86 notes with 0 failures.
  New revision logs contain neither invalid image UUID lookups nor the
  forwarded-header/trust-proxy warning, including after live requests.
- SWA deployment succeeded. Custom-domain release JS/CSS both return HTTP 200
  and SHA-256 hashes match the local production build.
- No infrastructure, credentials, environment or RBAC changed.
  Backend rollback image: `cad79107555facr.azurecr.io/kh-prod-api:v166`.

Discover/workflow/startup release validated 2026-10-07 (16:26 BST):

- Both app `npx tsc --noEmit` checks and `npm run build` passed; frontend
  `npx tsc --noEmit -p tests\tsconfig.json` passed.
- Six mocked backend tests passed, including UUID-only enrichment and client
  rate-limit separation with spoofed earlier forwarded IP entries.
- Discover browser checks at 1440/390px passed before this deployment request:
  actions visible without hover, successful copy to Published, workflow failure
  and retry, clipboard denial, email-copy isolation and modal focus.
- `git diff --check` passed; source env/service lint passed. Existing app/utils
  lint findings were verified against HEAD and are unchanged by this release.
- Azure account, ACR, Container App and SWA reads confirm the existing production
  targets. Current image v166; deploy v167, retain v166 for rollback.
- No provisioning, template/RBAC, migration, secrets or environment changes.
  Existing Dockerfile/lockfile retained; ACR build must succeed before update.
- Fetched origin/main; no missing remote commits.

Deployed 2026-10-07 (15:06 BST):

- Release `e837358` merged/pushed to main and feature branch.
- ACR run `ca57` succeeded; v166 revision `kh-prod-api-vnet--0000163`
  reports Healthy / RunningAtMaxScale; latest revision receives 100% traffic.
- Startup migrations completed and DB pool warmed. Logs also show existing
  note-image UUID lookup warnings and the Express forwarded-header/trust-proxy
  warning; no new migration failure occurred. Those unrelated issues are not
  changed by this release.
- SWA production deployment succeeded. Custom-domain HTML and published JS/CSS
  return HTTP 200; both asset SHA-256 hashes exactly match the release build.
- Rollback backend image: `cad79107555facr.azurecr.io/kh-prod-api:v165`.
- No environment variables, credentials, infrastructure or RBAC were changed.
- Diagram SCSS detector's side-border finding is the pre-existing conflict/error
  banner accent, not a new card treatment; preserved outside this theme change.

Dark diagram / Discover / dialogs / Think release validation:

- Both application `npx tsc --noEmit` checks and production builds passed.
- Frontend fixture typecheck, diagram geometry/theme, dialog queue and LinkedIn
  parser/route tests passed. Mocked tests do not write production data.
- Desktop/mobile browser checks passed for diagrams (editing, pointer geometry,
  saving, conflicts, exports), Discover drafts/dialog focus and Think clear.
  Existing diagram colours remain saved unchanged; only editor contrast changes.
- Azure CLI authentication and existing ACR, Container App and SWA targets
  confirmed. Current rollback image is v165; release image will be v166.
- Dockerfile and package lock verified; actual container build is performed by
  ACR before the image update. No Bicep/templates, provisioning, policy/RBAC,
  secrets, migrations or environment changes are part of this existing-resource
  application-only release.
- Fetched origin/main; no remote commits missing from this branch.

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
