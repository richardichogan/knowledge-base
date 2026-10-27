# Knowledge Hub Production Deployment Plan

**Status:** Validated

**Release scope and Section 7: Validation Proof (2026-10-27, podcast scheduling and manual blog repairs):**
- User requested the two fixes, deployment, merge and push. Release to the
  existing ACA/SWA resources only; no infrastructure, dependency, identity,
  secret or registry-authentication changes.
- All validation checks pass:
  - [x] `git fetch origin && git merge origin/main`: already current.
  - [x] Both package `npx tsc --noEmit` checks passed. Backend production
    build and final lint baseline passed (552/623). Reuse the unchanged
    frontend production build and lint result (22/41).
  - [x] Full backend release run completed once: 631/635. Fixed the two
    podcast assertions and recovery fixture; final affected blog,
    podcast, publication and managed-job groups passed 61/61.
    The previously timed-out checkpoint case passed alone (1/1).
  - [x] Final blog/weekly passage-repair groups passed 20/20 after the
    last code change. No full-suite reruns.
  - [x] Full frontend run: 234/234 plus bundled UI groups; the single
    stale publishing-findings assertion was corrected and its group
    passed 9/9. Podcast UI group passed 3/3 in the original run.
  - [x] Actual previously failing Discover article generated through
    POST /api/discover/67acaf45-307f-4d9e-809f-8718f7ff1e45/blog-draft:
    HTTP 200, success true. No article was published.
  - [x] Podcast preparation previously completed in 8.5 and 15.9 seconds,
    selecting original copy rather than generating replacements.
    Existing campaign remains an unapproved draft. Two oversized Bluesky
    posts correctly block approval; no permission to shorten or publish.
  - [x] `git diff --check` passed. Dockerfile/lockfiles unchanged;
    Dockerfile copies migration 113 along with all other SQL migrations.
- Azure authentication/target verified: Alliance Tenant Reporting
  (`c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28`), kh-prod-api-vnet currently
  v258, identity None, existing ACR passwordSecretRef retained.
  Existing application-only AZCLI recipe applies. Bicep/template/what-if,
  provisioning, new policy and RBAC changes are not applicable.
- Push matching feature/main source, build v259 from GitHub main in ACR,
  update the existing backend and deploy the already-built frontend to
  kh-prod-web. Verify revision/startup/migrations and served frontend bytes.
  Preserve unrelated `.impeccable/hook.cache.json`.
- Evidence: session files/podcast-release-*.log, podcast-final-affected.log
  and podcast-final-blog-weekly.log.

**Release scope and Section 7: Validation Proof (2026-10-27T05:41:18Z, Bluesky blog-link budgeting):**
- User requested deployment. Backend-only application update to the existing
  ACA target; no infrastructure, credentials, dependencies or migrations change.
  Do not rewrite or resend the previously failed approved post.
- All validation checks pass:
  - [x] Fetch/merge of origin/main before validation and before release:
    already current at `33af13c`.
  - [x] Both `npx tsc --noEmit` checks passed after the final runtime changes;
    reused because subsequent corrections affect test fixtures only.
  - [x] Backend production build passed; lint non-regression passed, 552/623.
  - [x] One full isolated backend run: 646 passed, two fixture failures and
    one cancelled nested test. Removed the invalid getter mock and moved the
    nested regression to top level. Only the three affected tests reran: 3/3.
    Weekly pre-approval teaser repair passed in the original full run.
  - [x] Frontend source is unchanged; reuse the prior release's validation and
    deployment. Public HTML returns 200 and its served `index-CaT7ubgV.js`
    matches SHA256 `a002491264d4ab6045b8ba7c1f9334ce0cc008fe0912ac7313f38bca46c8fade`.
  - [x] `git diff --check` passed. No real social post or browser launched.
- Azure CLI is authenticated to Alliance Tenant Reporting
  (`c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28`). Current backend is v257/revision
  0000254, identity None; existing registry secret-reference auth remains.
  Provisioning, Bicep/what-if, policy and RBAC changes are not applicable.
  Dockerfile and lockfile are unchanged; ACR builds the synced GitHub source.
- Push matching source to feature/main, build v258 from GitHub main, deploy
  the backend, verify revision/startup/migration readiness, then stop.
  Preserve unrelated `.impeccable/hook.cache.json`. Evidence is in session
  files/bluesky-release-tests.log and bluesky-release-affected-tests.log.

**Release scope and Section 7: Validation Proof (2026-10-26T21:49:16Z, Athena routing and Discover):**
- User requested deployment, merge and push. Release the existing local search,
  competitor history, morning roundup, model-led routing and archive-query fix
  to the established ACA/SWA production targets. No infrastructure changes.
- `git fetch origin` and `git merge origin/main --no-edit` completed before
  validation and were rechecked afterwards: already current at `11845aa`.
- All validation checks pass:
  - [x] Both `npx tsc --noEmit` checks passed after the final runtime change.
  - [x] Both local production builds passed.
  - [x] Backend lint non-regression: 552/623; frontend: 22/41.
  - [x] One full backend isolated release run: 619/620 initially. The sole
    failure expected the deliberately removed keyword-generated dialogue hint.
    Corrected that assertion; the affected conversation group passed 40/40.
  - [x] Frontend isolated release run: 235/235 plus 39/39 bundled UI checks.
  - [x] Archive/project-fit checks, outside the main runner, passed 7/7,
    including exact 7/14-day boundaries, protected records, preserved bodies
    and idempotence. The fixture now matches real timestamp and topic states.
  - [x] Actual archive SQL plans successfully against the shared database in
    a READ ONLY transaction; no articles were changed by this check.
  - [x] `git diff --check` passed. No full-suite reruns or browser launches.
- Azure CLI 2.79.0 is authenticated to Alliance Tenant Reporting
  (`c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28`). Existing backend is v256/revision
  0000253 with identity None; existing frontend is kh-prod-web (Free).
  Existing ACR secret-reference authentication remains unchanged. Bicep,
  provisioning, what-if, new policy/RBAC assignments and Docker-context
  changes are not applicable to this application-only release.
- Dockerfile and lockfiles are unchanged. The image copies all SQL migrations,
  including additive, idempotent migration112 for persistent company profiles,
  already applied to shared content during the approved local work.
- Fit: existing chat/tool, Discover and search architecture is retained;
  hosting is unchanged; no new dependencies or taxonomy/approval queue;
  specialised schema loading can add a model round, while the roundup adds
  no model call. Typed boundaries, source exclusions, read-only checks and
  edit previews remain. No secret handling changes. Reusing these paths is
  the smaller safer change than adding a classification subsystem.
- Actual local startup and frontend proxy are healthy. Real-user routing
  quality is not yet demonstrated: no conversation occurred after the local
  routing restart when inspected. Automated routing/permission coverage passed.
- Preserve unrelated `.impeccable/hook.cache.json`. The colour hook finding
  concerns an existing diagram test fixture, not a UI palette change.
- Push matching source to feature/main, build v257 from GitHub main, deploy
  both apps, verify revision/startup/migrations and served frontend bytes,
  then stop. Evidence logs are in session files/routing-release-*.log.

**Deployment outcome (2026-10-26, Design and diagram release):**
- Release commit `7d81c1a` pushed atomically to the feature branch and main.
  Existing unrelated `.impeccable/hook.cache.json` changes remain uncommitted.
- ACR run `ca81` successfully built `kh-prod-api:v255` from GitHub main.
- Backend revision `kh-prod-api-vnet--0000252` is latest and ready:
  Healthy / RunningAtMaxScale, receiving 100% traffic. Startup confirms
  migration completion and 8/8 database connections ready; existing
  attention/podcast-prep requests are served successfully.
- Frontend deployed with SWA CLI to production. The public entry at
  https://athena.themicrosoftcloudblog.com/ returns HTTP 200 and references
  `index-B7Cn2W9a.js`; its served bytes match the local release SHA256
  `fb8e60f1a9fc503e1c014932f73f7f5bf51ac9224d3afb49474b40d75bff46b1`.
- Azure CLI text-log rendering hit a Windows encoding error; JSON log output
  succeeded. No application startup or migration error was observed.
- No infrastructure/settings changes or manual content generation/publishing.

**Release scope and Section 7: Validation Proof (2026-10-26, Design and diagram release):**
- User requested deploy, merge and push. Existing ACA/SWA application targets
  only, in Alliance Tenant Reporting. No infrastructure or credential changes.
- `git fetch origin` and `git merge origin/main --no-edit`: already current;
  `git merge-base --is-ancestor origin/main HEAD` passed. Git emits a shared
  packed-refs lock warning during maintenance; no lock was removed.
- Both `npm run typecheck` checks passed. Both `npm run lint:check` checks
  passed after removing unused bindings and naming new numeric constants:
  frontend 22/41, backend 552/623. Both production builds passed.
- Frontend `npm run test:isolated`: 240/240 plus 37/37 bundled UI checks.
  Backend isolated suite: 630/631 initially; the stale protected-link
  punctuation expectation was corrected, with the affected file passing.
- Additional isolated checks covered design generation, specification form,
  diagram persistence, HTTP deadlines and snapping. Initial 71 passes exposed
  an unawaited nested timeout test and floating-point exact-equality assertion;
  only those files were rerun, passing 15/15. No full-suite reruns.
- Earlier actual desktop checks verified local shape header/icon persistence,
  undo restoration, SVG/PNG export, off-grid snapping and final text alignment.
  They did not leave authored diagram changes. Test suites use scrubbed
  environments and fixture databases, not production integrations.
- Change-for-fit report: (1) existing native Properties, Design jobs and refresh
  services retained; (2) ACA/SWA and manual deployment assumptions unchanged;
  (3) undici is the sole new direct dependency, required for explicit long HTTP
  deadlines, with bounded retries/candidate intake; (4) mirrored node types and
  strict validation preserve contracts; (5) no secrets added, installed local
  icons and existing sanitisation retained; (6) smallest safer version is the
  existing editor/service extension, not a replacement renderer or job system.
- Dockerfile/lockfile checked; the image includes additive migration111 for
  specification content type. ACR builds the synced GitHub main source.
  Current backend v254/revision0000251, identity None; existing ACR
  secret-reference authentication stays unchanged. Bicep/what-if, provisioning
  and new RBAC assignments do not apply to this application-only release.
- Diagram hook warnings concern documented approved colours, test colour
  fixtures and pre-existing styles. Preserve unrelated hook cache and sidecar.
- Deploy v255 and the matching local frontend build; verify startup/migration
  logs, revision readiness and served frontend asset identity, then stop.

**Release scope and Section 7: Validation Proof (2026-10-26, facts-first weekly recovery):**
- Application-only update to the existing Container App and Static Web App.
  Preserve publication approval and disabled Slack delivery. Switch standard
  and GPT54 model routes to the user-supplied Foundry project using the existing
  `foundry-imagine-api-key` secret reference; retain the main embedding/light route.
- All validation checks pass:
  - [x] Both TypeScript checks and production builds passed.
  - [x] Backend lint non-regression: 552/623; frontend: 22/41.
  - [x] Initial backend release run: 595/601, with six memory-pressure failures;
    the failed files and publishing duplicate-intake case passed isolated reruns.
    Frontend: 227/228 plus all nine bundled fixture groups; the failed
    project-options file passed its isolated rerun. No full-suite restart.
  - [x] Changed weekly evidence, model contracts, canonical package, protected
    phrase edits, mandatory reviews and approval guards passed focused tests.
    The changed review fixture expectation passed its single-test rerun.
  - [x] Actual run `b606d208-dd3f-4416-abf7-cde65488ed0a` completed discovery,
    source reading, facts validation, writing, agent review, Think and chat.
    Persisted at 11:04 UTC as `awaiting-approval`, with genuine accuracy/voice
    pass and empty validation/style findings. Repairs reused the saved article.
  - [x] `git diff --check` passed; origin/main is already contained in HEAD.
- Azure CLI confirmed backend v253, ready revision 0000250, identity None,
  and existing kh-prod-web. No provisioning, migrations, dependencies or RBAC
  changes; Bicep/what-if and new role assignments are not applicable.
- Change-for-fit review: uses existing managed jobs, reading helpers and marked;
  preserves ACA/SWA hosting and approval contracts; bounded evidence calls add
  necessary source-validation cost without new dependencies; schema guards and
  exact-edit checks retain typing. Credential-like diff signals are test fixtures,
  and the migration signal is an existing test import, not a schema change.
  Production keys stay in secret references. The smallest safe change keeps one
  canonical article and repairs it rather than adding another rewriting pipeline.
- Earlier requested Jobs, note-width and Blueprint navigation fixes are included.
  Preserve unrelated `.impeccable/hook.cache.json`.
- Deployment completed on 26 October:
  - Source `82146fb` pushed atomically to main and the feature branch.
    ACR run `ca80` built v254; revision `kh-prod-api-vnet--0000251`
    is Healthy / RunningAtMaxScale and serving successful requests.
  - Production standard/bulk/reasoning endpoint and secret-reference settings
    match the requested Foundry project; the main embedding/light route remains
    unchanged.
  - SWA production deployment succeeded using the cached official client after
    its metadata service failed twice. The binary SHA-256 matched its cached
    Microsoft metadata; no application rebuild or credential changes were needed.
  - The reviewed draft has 13 read, validated sources and three explicit evidence
    gaps. Think/chat are saved, note indexing completed and five tags applied.
    Publication remains unapproved; no blog, social or Slack post was sent.

**Release scope and Section 7: Validation Proof (2026-10-25, Athena edits, health and stable Notes shell):**
- User requested fixes, deployment, merge and remote push. Application-only
  release to the existing production targets; no provisioning or access changes.
- `git fetch origin && git merge origin/main`: already current at `54b5e10`.
  Azure account confirmed Alliance Tenant Reporting
  (`c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28`), current backend v248, identity None.
- All validation checks pass:
  - [x] Both `npx tsc --noEmit` checks passed after final changes.
  - [x] Both lint non-regression checks passed: backend 552/623, web 22/41.
  - [x] Backend isolated release suite: 565/567 initially; affected
    focused-context/dialogue rerun passed 41/41 after fixing the mock hook and
    a possessive-pattern false match in ordinary-note reviews.
  - [x] Frontend isolated suite passed 225/225 plus 36/36 bundled checks.
    Affected live desktop fixtures passed: persistent Design/ordinary-note
    controls and chat identity, operative Actions, preserved Design draft;
    fake email sends close on full acceptance and retain partial failures.
  - [x] Both production builds passed. Final web build includes the shared
    88px Athena ribbon loading state, not the AI-thinking mood.
  - [x] `git diff --check` passed. Dockerfile/lockfile unchanged; migration109
    adds nullable review environment and leaves historical records unattributed.
- Established Azure CLI recipe: CLI/authentication checked; existing app
  targets only. Bicep/template/what-if/policy provisioning, new Docker context
  and RBAC changes are not applicable. Existing ACR secret-reference auth stays.
- Notes shell owns shared controls; only the document loads. Removed the
  redundant Design/Properties banner. Existing unrelated type-ramp/shadow hook
  findings were not introduced by this release and remain unchanged.
- External ICA key, mailbox403 and repository404 access failures remain visible;
  no credentials, mappings, production switches or permissions changed.
- Push identical source to feature and main; build v249 from GitHub main,
  deploy backend/frontend, verify revision/startup and served asset identity.
  Preserve unrelated `.impeccable/hook.cache.json`.
- Deployment completed at 2026-10-25T11:20Z:
  - Source `7c83fc4` pushed atomically to main and feature branch.
    ACR run `ca7u` built `kh-prod-api:v249`.
  - Revision `kh-prod-api-vnet--0000246` is Healthy / RunningAtMaxScale,
    latest ready, with 100% traffic. Startup applied migration109 successfully
    and warmed 8/8 database connections; `/health` returned HTTP200.
  - Frontend production deployment succeeded. Custom-domain HTTP200 serves
    `/assets/index-DitHGMKT.js`; SHA-256 matches the local build:
    `615d6277c8e3d88176ef0da0a5d44d0bdfa784af8e08bb451df9c42add731351`.
  - Local browser observed the 88px non-thinking ribbon, centered in the
    document area with Loading note text; Actions and side-panel identity
    stayed unchanged. Email checks used fake sends only.

**Release scope and Section 7: Validation Proof (2026-10-25, Designs and note email):**
- User explicitly requested deployment of the completed native Design workflow,
  Design-aware Athena tools, grouped Notes list, document review and formatted
  note email sharing. Existing Azure Container Apps and Static Web Apps only.
- `git fetch origin && git merge origin/main` reported already current at
  `9faaeb7`. `git diff --check` passed. Azure CLI confirmed Alliance Tenant
  Reporting (`c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28`), backend v247 and kh-prod-web.
- All validation checks pass:
  - [x] Both `npm run typecheck` checks passed.
  - [x] Both lint non-regression checks passed: backend 553/623, frontend 22/41.
    New lint blockers were fixed without changing the baseline.
  - [x] One full isolated release suite per app, including new Design/review tests.
    Backend initially 590/594, with stale error wording, a nested async fixture
    and calendar autotag timing. Affected reruns passed: Design 4/4 and
    use-case/calendar 16/16. Design GitHub calls and credentials are mocked.
    Frontend initially 210/211 plus 34/36 bundled checks; affected project-option
    and note-list fixtures passed 11/11 after updating expected Design type,
    explicit flat list query and generic item count. No full-suite reruns.
  - [x] Both local production builds passed.
  - [x] Unchanged Dockerfile/lockfile packages schema and all SQL migrations,
    including 102-108 already applied to shared production data in development.
- Existing application-only Azure CLI recipe applies. No infrastructure,
  dependency, credential, policy, RBAC or Electron changes. ACA identity is None
  and ACR authentication retains its existing secret reference; provisioning,
  Bicep/what-if and managed-identity role assignment are not applicable.
- Proof: session files/design-release-*.log. No real provider sends or jobs
  triggered by release checks. Preserve production publishing settings and
  shared content; local automatic delivery remains disabled.
- Push identical source to feature branch and main, build v248 from GitHub main,
  deploy both apps, confirm healthy revision/startup and matching frontend asset.
  Preserve unrelated `.impeccable/hook.cache.json`.
- Deployment completed at 2026-10-25T10:13Z:
  - Source `1ba9962` pushed atomically to main and feature branch.
    ACR run `ca7t` built and pushed `kh-prod-api:v248`.
  - Backend revision `kh-prod-api-vnet--0000245` is Healthy /
    RunningAtMaxScale, latest ready, with 100% traffic. Startup confirms
    migrations complete and 8/8 database connections ready; health HTTP 200.
  - Frontend production environment is Ready. Custom-domain HTTP 200 serves
    `/assets/index-CS8Te9CC.js`; its SHA-256 matches the local production build.
  - No infrastructure, credentials, role assignments or publishing switches
    were changed; no real email, provider post or manual job was triggered.

**Release scope and Section 7: Validation Proof (2026-10-25, shared ribbon repair):**
- User requested a quick deployment of the shared animation visibility repair
  and variable thinking tempo/pulse. Frontend-only update to existing kh-prod-web
  in Alliance Tenant Reporting. Backend v247 and database remain unchanged.
- `git fetch origin && git merge origin/main` reported already current.
  `git diff --check` passed. Azure account and existing Static Web App confirmed.
- All validation checks pass:
  - [x] Both `tsc --noEmit` checks passed after implementation; frontend
    `npm run typecheck` repeated before release.
  - [x] Frontend `npm run lint:check`: 22 existing violations / baseline 41.
  - [x] One frontend `npm run test:isolated`: 205/205 plus 31/31 bundled UI
    checks passed, including shared presence and thinking tempo regression tests.
  - [x] Frontend `npm run build` passed.
- Direct local chat observation confirmed the ribbon remains attached during
  thinking and after completion; note-panel ribbon resumed after opening.
- Existing application-only Azure CLI recipe applies. No dependencies,
  infrastructure, IAM, policy, database or Electron changes; provisioning,
  Bicep/what-if and Docker/backend builds are not applicable.
- Proof: session files/ribbon-release-tests.log and ribbon-release-build.log.
  Push source to feature/main, deploy frontend, verify matching served entry
  and ribbon assets. Preserve unrelated .impeccable/hook.cache.json.

**Release scope and Section 7: Validation Proof (2026-10-24, Athena evening release):**
- User explicitly requested merge, push and deploy of all completed publishing,
  diagram-context and Athena chat refinements, including bounded model transport
  reconnects. Existing Azure Container Apps and Static Web Apps only.
- `git fetch origin && git merge origin/main`: already current at `1b916a4`.
  `git diff --check` passed. Azure confirmed Alliance Tenant Reporting,
  existing backend image v246, identity None and kh-prod-web.
- All validation checks pass:
  - [x] Both applications: `npm run typecheck` (`tsc --noEmit`).
  - [x] Both lint non-regression checks: backend 553/623, frontend 22/41.
  - [x] One isolated release suite per app. Backend 545/548 initially; frontend
    216/220 plus 30/31 bundled UI tests initially. Failures were stale fixture
    assumptions about output-limit errors, saved draft versions, approved draft
    immutability, inline presence, historical icon sizing, typing intensity and
    removed expiry controls. Only affected files were rerun: 27/27 targeted
    chat/API tests, 35/35 publishing tests and 9/9 publishing UI tests passed.
  - [x] Both local production builds passed after the final fixture repairs.
  - [x] Dockerfile uses existing package-lock and copies schema plus all SQL
    migrations, including additive 101. No dependency or infrastructure changes.
- Application-only Azure CLI recipe: Bicep/template/what-if, RBAC and policy
  provisioning are not applicable; existing registry secret-reference auth and
  identity remain unchanged. No production tests, jobs or provider posts.
- Preserve both currently enabled publishing switches, approvals and shared
  production content. Local automatic delivery remains disabled.
- Proof logs: session files/evening-release-backend.log,
  evening-release-web.log, evening-release-retest.log,
  evening-publishing-retest.log and evening-web-build.log.
- Push identical source to feature branch and main, build v247 from GitHub main,
  deploy backend and frontend, verify healthy revision/startup and served asset.
  Preserve unrelated .impeccable/hook.cache.json.
- Deployment completed at 2026-10-24T21:33Z:
  - Application source `f89d7aa` pushed atomically to main and feature branch.
    ACR build `ca7s` succeeded for `kh-prod-api:v247`.
  - Backend revision `kh-prod-api-vnet--0000244` is Healthy /
    RunningAtMaxScale, latest ready, with 100% traffic. Startup completed
    migrations and database warmup; production health returned HTTP 200.
  - Frontend production environment is Ready. The public custom-domain index
    serves `/assets/index-DkKq3s9u.js`; its SHA-256 matches the local build.
  - No publishing switches, approvals, credentials or infrastructure changed
    as part of deployment verification; no manual jobs or provider posts run.

**Release scope and Section 7: Validation Proof (2026-10-24, Discover publishing):**
- User explicitly requested deployment of the completed coordinated publishing
  feeds and the local Jobs field-alignment fix. Existing Azure Container Apps
  and Static Web Apps targets only; no dependency, infrastructure, credential,
  RBAC or Electron changes.
- `git fetch origin && git merge origin/main` reported already current.
  `git diff --check` passed. Azure CLI confirmed Alliance Tenant Reporting
  (`c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28`), backend v245 and `kh-prod-web`.
- All validation checks pass:
  - [x] Both applications: `npm run typecheck` (`tsc --noEmit`).
  - [x] Both lint non-regression checks: backend 556/623, frontend 23/41.
  - [x] One isolated release suite per application. Frontend 223 tests plus
    24 bundled UI tests passed. Backend initially 529/532: two older social
    fixtures needed delivery-ledger support; one calendar test encountered
    delayed auto-tagging under parallel load. Updated only the social fixtures,
    then reran both social files (12/12) and calendar file (5/5), all passed.
    The obsolete hanging LinkedIn fixture was stopped, not the full suite
    restarted. New publishing tests completed successfully in the release run.
  - [x] Both local production builds passed; backend typecheck repeated after
    test-fixture changes. No production DB access or real provider posts.
  - [x] Dockerfile uses existing package-lock and copies every SQL migration
    into `dist/db/migrations`, including additive migration 100. It seeds both
    feed automation switches OFF; existing content sync remains unchanged.
- Bicep/what-if, policy and role provisioning are not applicable: application
  update to existing resources, unchanged registry secret-reference auth and
  Container App identity None. Use the established Azure CLI deployment recipe.
- Logs: session `files/publishing-backend-release.log`,
  `files/publishing-web-release.log`, `files/publishing-social-release-retest.log`
  and `files/publishing-calendar-release-retest.log`.
- Push identical source to feature branch and main, build next backend image
  from GitHub main, deploy both apps, verify revision/startup/migration and
  matching served frontend asset. Leave automation OFF and do not trigger posts.
  Preserve unrelated `.impeccable/hook.cache.json`.

**Release scope and Section 7: Validation Proof (2026-10-24, Jobs modal):**
- User requested a quick deployment of the completed Jobs modal/style refinement
  and mandatory design-guide repository instructions. Frontend-only release to
  existing `kh-prod-web`; backend v245, data, dependencies and infrastructure
  remain unchanged.
- `git fetch origin && git merge origin/main` reported already current.
  `git diff --check` passed. Azure CLI confirmed the existing Static Web App in
  Alliance Tenant Reporting, `rg-knowledge-hub-prod`.
- Both typechecks and frontend lint non-regression already passed for this
  unchanged implementation; reuse that proof. One frontend isolated release
  suite passed (210/210 plus 22/22 bundled checks), followed by `npm run build`.
  Log: session `files/jobs-modal-release.log`.
- Existing Azure CLI application-only recipe applies. No Docker/backend build,
  migrations, IAM, provisioning, Bicep/what-if or policy changes are applicable.
- Push the source to the feature branch and main, deploy the built frontend,
  confirm production Ready and matching served entry asset, then stop.
  Preserve unrelated `.impeccable/hook.cache.json`.

**Release scope (2026-10-24, managed Jobs):**
- User approved the Jobs plan and explicitly requested deployment, merge and push.
- Deploy the Jobs workspace, shared chat configuration confirmations, versioned
  schedules, durable runs, publishing approvals and audit history.
- Migration 099 adds Jobs tables and seeds content sync at 06:00/13:00 UK,
  the Monday weekly workflow with approval required, and an incomplete paused
  M365 import. Existing maintenance schedules and production content remain.
- Use the existing Container App, ACR and Static Web App; no dependencies,
  infrastructure, credentials, RBAC assignments or Electron source changes.
- All validation checks pass:
  - [x] Fetch and merge origin/main before release checks (already current).
  - [x] Azure authentication and existing application targets confirmed.
  - [x] Both typechecks, lint non-regression and local production builds.
  - [x] One isolated full release suite per application.
  - [x] Dockerfile/lockfile and automatic migration packaging reviewed.
  - Infrastructure compilation/what-if, policy changes and identity provisioning
    are not applicable to this application-only update.
- Push the same source to the feature branch and main, build the backend from
  GitHub main with the next live image version, deploy both apps and verify the
  new revision/startup plus the frontend entry asset. Do not smoke-test by
  publishing real posts or running jobs against production data.

**Section 7: Validation Proof (2026-10-24, managed Jobs):**
- `git fetch origin && git merge origin/main` reported already current before
  final release checks. `git diff --check` passed.
- Azure CLI authenticated to Alliance Tenant Reporting
  (`c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28`) at 2026-10-24T14:30:48Z.
  Existing backend v244 and `kh-prod-web` were confirmed; next image is v245.
- Both applications passed `npm run typecheck`, `npm run lint:check`,
  `npm run test:isolated` and `npm run build`. Backend: 530/530 tests.
  Frontend: 211/211 plus 20/20 bundled UI checks. No full-suite reruns.
- Focused Jobs tests additionally cover DST, revisions, user-only approvals,
  stale-device leases, wrong report dates, authorised folders, missed/catch-up
  schedules, publishing deduplication and uncertain delivery reconciliation.
  Tests use isolated PGlite/fakes, not production data or real publishing.
- Unchanged Dockerfile installs from the existing lockfile and copies
  `src/db/schema.sql` and every `src/db/migrations/*.sql` into the runtime
  image, including additive migration 099. No dependencies or infrastructure
  changed. Existing registry authentication uses a secret reference and the
  Container App identity remains None. No managed-identity provisioning,
  RBAC/policy changes, Bicep/template validation or what-if is applicable.
- Logs: session `files/jobs-backend-release.log` and `files/jobs-web-release.log`.
  Preserve unrelated `.impeccable/hook.cache.json`.

**Release scope (2026-10-24, settings modals):**
- User approved configuration as modals and working destinations as pages.
- Reuse existing settings components for Memory, Connections and sync, tags
  and repository mappings; preserve the underlying workspace and direct links.
- Frontend-only update to existing kh-prod-web; backend v244, production data,
  dependencies, infrastructure and Azure context remain unchanged.
- Sync main, implement, run affected tests and required typechecks, build once,
  push and deploy the frontend, then verify its served entry asset.
- All validation checks pass: existing Azure CLI authentication and SWA
  resource confirmed; both typechecks, frontend lint non-regression, one
  frontend release suite and production build passed. No infrastructure,
  Docker, policy or role-assignment changes apply to this static-only release.

**Release scope (2026-10-24, Athena conversational pacing):**
- Deploy the requested changes that remove output-first instructions, clarify
  ambiguous in-view concept versus specification reviews, retain explicit
  deliverable workflows, and bound repeated whole-document read failures.
- Apply migration 098, which replaces only the exact active legacy profile
  instruction that required output before clarification; preserve unrelated
  profile content, instructions, examples and history.
- User explicitly requested deployment. Preserve Azure Container Apps +
  Static Web Apps hosting, production database and existing secret-based
  registry authentication. No frontend source, dependencies, infrastructure,
  credentials or RBAC roles changed.
- Sync origin/main before push/build; existing production subscription and
  application targets are documented below.
- All validation checks must pass:
  - Azure CLI installation/authentication and existing targets confirmed.
  - Backend and frontend `tsc --noEmit`, production builds and lint
    non-regression checks.
  - One isolated full release suite per application; rerun only affected
    checks for an initial failure.
  - Inspect unchanged Dockerfile, lockfile and automatic migration packaging.
  - No infrastructure/IAM changes: Bicep/what-if, provisioning, policy and
    role-assignment checks are not applicable to this application-only release.
- Build the backend from synced GitHub main using the next version after
  production v243. Verify healthy revision, traffic, migrations and startup.
  Build and deploy the synced frontend to the existing Static Web App, then
  verify its served production asset hash.
- Do not modify or read/write secrets or production content other than the
  application startup migration described above.

**Deployment result (2026-10-24T11:57Z, Athena conversational pacing):**
- Source commit `995ea0d561cf72c5d779f625efa75fe1c436bdc4` is on the feature
  branch and main. ACR run `ca7p` built `kh-prod-api:v244`,
  digest `sha256:5d7841d21a790111ad95824ec6c3058b0207bcd8d914180af7942df65c514737`.
- ACA revision `kh-prod-api-vnet--0000241` is Healthy and
  RunningAtMaxScale; it serves 100% of traffic using v244. Startup logs confirm
  migration 098 completed and 8/8 database connections are ready.
- Static Web Apps production deployment succeeded and its environment is Ready.
  The served `/assets/index-b6t61CYm.js` matches the validated local build.
- `https://athena.themicrosoftcloudblog.com/` serves the deployed app.
  `https://kh-prod-api-vnet.proudcoast-0a102078.uksouth.azurecontainerapps.io/health`
  returns `{"status":"ok"}`.
- ACA identity remains None and ACR uses its existing secret reference; no
  credentials, roles or infrastructure were changed.

**Deployment result (2026-10-24T10:09Z, LinkedIn publishing):**
- Source 15f4e993f7b29190d59aa32aef7a401a55d8a64c committed and atomically
  pushed to main and richardichogan-local-development.
- ACR run ca7n built v243 successfully. Backend revision
  kh-prod-api-vnet--0000240 is latest ready, Healthy and RunningAtMaxScale,
  receiving 100% latest-revision traffic.
- Startup confirms port 3000, migrations complete and 8/8 pooled database
  connections ready. Existing notes already indexed; no reindex work.
- Frontend uploaded to kh-prod-web production. Custom-domain HTTP 200 and
  /assets/index-b6t61CYm.js match the validated local build; SHA-256
  1aa87802138fbf156d77589964c4664262c8363d6d5a7389609e336e6d837423.
- Production URL: https://athena.themicrosoftcloudblog.com.
- Existing identity remains None and registry uses its existing secret;
  no new managed identity, RBAC or infrastructure changes.
- No LinkedIn token configured or real post sent. User can add their member
  token in My Work > Sync Status > Connection tokens and API keys > LinkedIn.
- Logs: session files/linkedin-release-{acr,web-deploy,startup}.log.

**Section 7: Validation Proof (2026-10-24, LinkedIn publishing):**
- Fetched origin and merged origin/main: already current at a3aef6c.
- Azure CLI 2.79.0 authenticated to Alliance Tenant Reporting
  (c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28). Existing backend v242 and
  kh-prod-web confirmed; release image v243. Existing production runbook
  fixes the subscription/resource group/location; no resource provisioning.
- Both `npx --no-install tsc --noEmit` and `npm run build` passed.
  Lint non-regression passed: backend 561 existing violations against 623;
  frontend 23 against 41. `git diff --check` passed.
- One credential-free isolated release suite per app passed: backend 477/477;
  frontend 207/207 plus 20/20 bundled UI checks. Feature checks also passed
  standalone during implementation, including concurrent claims, uncertain
  outcomes, account mismatch, encrypted credential save and modal states.
- Tests use synthetic articles, isolated PGlite and intercepted provider calls;
  no production records or real LinkedIn posts were created.
- Dockerfile/lockfile and migration packaging reviewed unchanged. No new
  dependencies, migrations, resources or IAM assignments. Registry remains
  secret-based with identity None; managed-identity role checks and provisioning,
  Bicep/template/what-if and new-resource policy checks are not applicable.
- Build and suite logs: session files/linkedin-release-{backend,frontend}-{build,tests}.log.
  Preserve unrelated .impeccable/hook.cache.json. Token remains user-configured.

**Release scope (2026-10-24, LinkedIn publishing):**
- Deploy reviewed personal-profile LinkedIn publishing from Discover, encrypted
  member-token configuration, account-specific confirmation and duplicate guards.
- User explicitly requested deployment. Preserve existing hosting, database
  content, secrets and IAM; no migrations, dependencies or infrastructure changes.
- Sync origin/main before building; publish synced source to feature and main.
- All validation checks must pass:
  - Confirm Azure authentication, existing Container App and Static Web App targets.
  - Run both TypeScript checks, production builds and lint non-regression checks.
  - Run one isolated release suite per app; rerun only failed/affected checks.
  - Review unchanged Dockerfile, lockfile and migration packaging.
  - Existing secret-based registry authentication, no managed identity or IAM
    changes; provisioning, Bicep/template/what-if and new-resource policy checks
    are not applicable to this application-only AZCLI release.
- Build v243 with ACR from synced main; verify healthy ready revision, traffic
  and startup. Upload validated frontend and verify its served asset hash.
- LinkedIn token remains user-configured; do not send real LinkedIn posts or
  write a token during deployment verification.

**Release scope (2026-10-24):**
- Implement resumable whole-document reading with bounded per-step context,
  durable private reading checkpoints, complete page coverage and explicit
  recovery after interruption. Include specifications and newsletters.
- Improve conversational question-asking with multi-turn regression and bounded
  live-model evaluations before release.
- Include the pending collection-scoping and Health diagnostics changes.
- Preserve existing Azure Container Apps + Static Web Apps hosting, secrets,
  database content and approval-based writes. No new infrastructure.
- Use existing AZCLI production runbook, Alliance Tenant Reporting / UK South;
  validate, commit, merge/push, build and verify the new revision and web assets.
- All validation checks must pass:
  - Azure CLI installation/authentication and existing target confirmed.
  - Both TypeScript checks, affected tests and one isolated release suite per app.
  - Backend/frontend production builds and lint non-regression.
  - Dockerfile/lockfile and automatic migration packaging review; ACR verifies
    the unchanged container recipe during deployment.
  - No infrastructure/IAM changes: Bicep/template/what-if, new-resource policy
    and static role-assignment checks are not applicable to this image/web update.
- Current validation completed; earlier proof below remains historical.

**Deployment result (2026-10-24T06:59Z, recursive reading and dialogue):**
- Source 9c2e84b2864274b73d149ebbd0a3353db7ec9954 committed and atomically
  pushed to main and richardichogan-local-development.
- ACR run ca7m built and pushed v242 successfully. An initial image-update
  command used a mistyped registry hostname and was rejected; corrected it
  without changing registry configuration or secrets.
- Backend kh-prod-api-vnet--0000239 is the latest ready revision, Healthy and
  RunningAtMaxScale, with 100% latest-revision traffic on v242.
- Startup applied migrations 096 and 097, completed migrations, and pre-warmed
  all eight database connections. A separate READ ONLY database transaction
  confirmed both applied-migration entries and both reading-checkpoint tables.
  Existing SSL-mode future-semantics warning remains; no startup errors.
- Validated frontend uploaded to kh-prod-web production. The custom-domain HTML
  references the local main JavaScript asset, and its served SHA-256 matches the
  validated build at https://athena.themicrosoftcloudblog.com.
- No real chats were generated or source documents/profile memories edited
  during release verification. Live model evaluations used synthetic data only.
- Deployment logs: session files/recursive-release-{acr,web-deploy,startup}.log.

**Section 7: Validation Proof (2026-10-24T06:54Z, recursive reading and dialogue):**
- Fetched origin and merged origin/main; already current. Azure CLI 2.79.0
  authenticated to the existing Alliance Tenant Reporting subscription
  c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28. Existing production image v241;
  next image v242. Container Apps and Static Web Apps targets unchanged.
- Both `npx --no-install tsc --noEmit` checks passed; backend and frontend
  `npm run build` passed. Lint non-regression passed: backend 561 existing
  violations against baseline 623, frontend 23 against baseline 41.
  Frontend retains existing Sass/chunk-size warnings; `git diff --check` passed.
- Backend isolated suite ran once: 463/465 initially passed. The two failures
  exposed an over-scoped "this note" comparison and an outdated expectation
  that task-only requests retain generic search. Fixed the reference boundary,
  retained explicit manual paging coverage and updated the task-scope expectation.
  All 9 comparison/scope tests and all 30 subsequently affected conversation,
  scope and read-only tests passed. No full-suite rerun.
- Frontend isolated release checks passed: 210 tests plus 17 bundled UI tests.
  All 15 dialogue-policy deterministic tests were also explicitly observed in a
  standalone run; actual chat tests cover buffered, single tool-free repair with
  orchestration both enabled and disabled.
- Deterministic reading processed more than 1.6 million characters and 100 pages
  with exact stored coverage and bounded model inputs; interruption/resume,
  cancellation, source exclusion/version invalidation and private recall passed.
  Invalid checkpoint quotations retry the same page once; provider errors are
  surfaced without silently retrying or advancing coverage.
- Shared runtime live-reading prompts processed all 76,848 synthetic characters
  across 7 pages and preserved beginning/middle/end facts, figures, an unresolved
  conflict and newsletter audience (7/7 checks). An initial checkpoint validation
  failure drove stricter source-page quoting and same-page recovery. A separate
  adversarial fixture was rejected by Azure content filtering; this was not
  bypassed or counted as a passing reading/security evaluation.
- Live dialogue used production prompt assembly and Foundry routes with synthetic
  multi-turn input, no tools and intercepted usage writes. Baseline RTR produced
  essays; latest saved RTR/newsletter exchange passed 6/6 after two bounded
  repairs, allowing a rhetorical question inside the requested newsletter draft.
  Transcript review confirmed consequential questions and use of the answers.
  These bounded heuristic evaluations are not a semantic quality guarantee.
- Dockerfile and existing lockfile reviewed: both new SQL migrations are copied
  from src/db/migrations into the image and run on startup. ACR will verify the
  unchanged container recipe. Registry uses the existing secret-based pull
  configuration, not a new managed identity or role assignment.
- Existing application-only AZCLI recipe; no provisioning, IAM, new resource,
  Bicep/template/what-if or policy changes. Database changes add private chat
  reading checkpoints and count-only retrieval audit fields; source documents
  and approval-based profile memories are not modified.
- Evidence: session files/document-reading-live-eval.json,
  athena-dialogue-{baseline-excerpts,live-standard-repaired,live-standard-rescored}.log,
  recursive-release-{backend-tests,frontend-tests,affected-tests,backend-build,
  frontend-build,backend-lint,frontend-lint}.log. Preserve unrelated Impeccable cache.

**Deployment result (2026-10-23, identity and capability grounding):**
- Source 4fced85 committed and atomically pushed to main and
  richardichogan-local-development; ACR build and v241 update succeeded.
- Latest ready revision kh-prod-api-vnet--0000238 is Healthy, Provisioned,
  RunningAtMaxScale, with 100% latest-revision traffic.
- Startup confirms port 3000, migrations complete and eight database
  connections ready. All 140 notes already indexed; no reindex writes.
  Incumbent pg SSL-mode future-semantics warning remains.
- Backend-only release; frontend remains at
  https://athena.themicrosoftcloudblog.com. No changes to saved content,
  profiles, dependencies, migrations or infrastructure.
- Build/startup logs: session files/athena-identity-{acr,startup}.log.

**Section 7: Validation Proof (2026-10-23, identity and capability grounding):**
- Fetched origin and merged origin/main; already current at 415a072.
- Latest production chat read in a READ ONLY transaction: Athena required old
  PR evidence for her identity and misread a behavioural correction as a note edit.
- Added stable role/viewpoint, first-party capability authority, per-turn
  filtered tool/permission snapshot and visible-document subject boundaries.
  Identity questions no longer force retrieval; tentative pronoun-only discussion
  does not force a note edit. Explicit note actions retain preview behaviour.
- Both frontend/backend `npx --no-install tsc --noEmit` passed. Backend
  production build, lint non-regression and diff checks passed.
- Backend isolated suite: 461/462 initially passed; new test used "decide" where
  existing decision routing recognises "decisions". Corrected that assertion
  without changing production decision behaviour; all 13 tests in the affected
  focused-context file then passed. No unrelated failures or full-suite rerun.
- Tests capture real prompt assembly/tool filtering with orchestration enabled,
  exercise latest-chat wording and verify read-only, local-folder and preview
  limits. They mock model responses, not a live model personality assessment.
- Existing authenticated Alliance Tenant Reporting subscription
  (c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28), rg-knowledge-hub-prod,
  kh-prod-api-vnet in UK South. Current image v240; next image v241.
- Backend-only AZCLI image update; ACR builds unchanged Dockerfile/lockfile
  from synced GitHub main. Frontend unchanged. No new dependencies, migrations,
  infrastructure, IAM or secret configuration; provisioning, template/what-if,
  policy and role-propagation gates not applicable.
- Logs: session files/athena-identity-{build,lint,tests}.log. Preserve unrelated
  Impeccable cache. Verify ready revision, 100% traffic and startup after update.

**Deployment result (2026-10-23, RTR reliability and personality):**
- Source 8ad38e408fc40dc5aaa52711c70062195bac92c9 committed and atomically
  pushed to main and richardichogan-local-development.
- ACR build and backend v240 update succeeded. Latest ready revision
  kh-prod-api-vnet--0000237 is Healthy, Provisioned, RunningAtMaxScale with
  latest-revision traffic at 100%. Startup confirms port 3000, migration
  complete and all eight database connections ready; incumbent SSL-mode warning.
- Validated frontend dist uploaded to kh-prod-web production. Both
  https://athena.themicrosoftcloudblog.com and
  https://nice-mud-0f780fb03.7.azurestaticapps.net return HTTP 200 with the
  expected entry and matching SHA-256 hashes for all three entry/renderer assets.
- Includes intent-aware dialogue, curiosity, constructive challenge and contextual
  dry humour; table-preserving readers, honest edit-timeout handling, invalid-batch
  rejection and approval-based correction learning. No new dependencies or migrations.
- No manual changes to RTR notes or stored profiles; existing startup reindex
  refreshed derived note bodies (14 of 140, zero failures).
- Logs: session files/rtr-release-{acr,startup,web-deploy}.log. Deployment
  credential kept private; unrelated Impeccable cache excluded.

**Section 7: Validation Proof (2026-10-23, RTR reliability and personality):**
- Synced origin/main before release; already current at a8ded98.
- Both `npx --no-install tsc --noEmit`, production `npm run build` and
  `npm run lint:check` commands passed. New lint findings were fixed without
  changing the baseline. `git diff --check` passed; frontend dist excludes tests.
- Frontend isolated release suite: 226 tests passed, zero failures.
- Backend isolated release suite: 451 of 452 passed initially; unrelated
  timeline zero-query assertion observed a delayed auto-tagging query under
  suite contention. Reran only scripts/task-calendar.test.ts in credential-free
  isolation: all five tests passed, including the failing assertion. No suite
  rerun or unrelated code changes.
- Focused regressions cover native/legacy table cells in both readers,
  partial-preview rejection, proposal-aware timeout, intent/personality prompt
  assembly and approval-only, user-evidenced correction learning.
- Read-only checks of RTR saved revisions verified 449, 1096 and 813 nonempty
  table cells preserved by both readers. No production notes or memories edited.
- Existing authenticated targets in Alliance Tenant Reporting
  (c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28), rg-knowledge-hub-prod:
  kh-prod-api-vnet in UK South (v239 -> v240), kh-prod-web in West Europe.
- Existing AZCLI application-only recipe: ACR build from synced GitHub main,
  backend image update and validated frontend SWA upload. Dockerfile and lockfile
  unchanged. No infrastructure, RBAC, dependency, migration or secret changes;
  provisioning, what-if, policy and role-propagation gates are not applicable.
- Logs: session files/rtr-release-{api,web}-{build,lint,tests}.log.
- Verify latest ready revision/traffic, startup logs and both frontend domains
  with exact entry/renderer hashes. Preserve unrelated Impeccable cache change.

**Deployment result (2026-10-23, conversational challenge):**
- Source 34f8df3 committed and atomically pushed to main and working branch.
- ACR built kh-prod-api:v239 successfully from GitHub main backend source.
- kh-prod-api-vnet--0000236 is latest ready, Healthy, Provisioned and
  RunningAtMaxScale; latest revision receives 100% traffic. Old revision is
  deprovisioning. Startup confirms production port 3000 and migration complete,
  with no startup failure; existing PostgreSQL future SSL-mode warning remains.
- Athena now receives explicit conversational questioning and constructive
  challenge instructions across personas, overriding older output-first profiles.
- Frontend and stored profile data unchanged; no new migrations or configuration.
- Logs: session files/athena-dialogue-release-{acr,startup}.log.
- Production app: https://athena.themicrosoftcloudblog.com.

**Section 7: Validation Proof (2026-10-23, conversational challenge):**
- Fetched origin and merged origin/main; already current at 7bb4f92.
- Both frontend/backend `npx --no-install tsc --noEmit` passed.
- Backend `npm run build`, `npm run lint:check` and full isolated release
  suite passed: 433 tests, zero failures. `git diff --check` passed.
- Updated prompt-assembly regression covers general, brainstorming and show
  notes with an old saved output-first profile, requiring shared questioning
  and constructive challenge rules after that profile.
- Existing user-confirmed Azure target: Alliance Tenant Reporting
  (c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28), rg-knowledge-hub-prod,
  kh-prod-api-vnet in UK South. Current image v238; release image v239.
- Existing application-only AZCLI recipe: ACR builds GitHub main backend
  source, then update the existing container image. Dockerfile and lockfile
  present; ACR performs the container build before switching the image.
- No frontend upload, infrastructure, RBAC, dependency, migration or secret
  changes. Bicep/template/what-if/policy and provisioning/role propagation
  gates are not applicable to this image-only update.
- No production database test writes; isolated tests strip credentials.
  Shared rules override legacy profile instructions without editing user data.
- Logs: session files/athena-dialogue-release-{build,tests,lint}.log.
- Verify revision health and startup logs after deployment. Preserve unrelated
  .impeccable/hook.cache.json.

**Deployment result (2026-10-23, completion notifications):**
- Source 0cdd853f093d9f4f26322aaa93dad4519e485b0f committed and atomically
  pushed to main and richardichogan-local-development.
- Validated dist uploaded successfully to kh-prod-web production.
- Both https://athena.themicrosoftcloudblog.com and
  https://nice-mud-0f780fb03.7.azurestaticapps.net return HTTP 200 with the
  expected entry reference and matching SHA-256 hashes for all three checked
  entry/renderer assets.
- Includes the composer sizing fix and browser completion alerts for successful
  prompts over 30 seconds. Backend and production database unchanged.
- Deployment token was kept private. Log: session
  files/athena-notification-release-deploy.log.

**Section 7: Validation Proof (2026-10-23T21:34Z, completion notifications):**
- Synced origin/main before validation; already current at 4171a19.
- `npx --no-install tsc --noEmit` passed in both frontend and backend.
- Frontend `npm run build`, `npm run test:isolated` (232 tests, zero
  failures), `npm run lint:check` and `git diff --check` passed.
- Production dist contains no tests directory. Release includes the composer
  height fix and browser-side success notifications for prompts over 30 seconds.
- Azure CLI 2.79.0 authenticated; existing kh-prod-web target verified in West
  Europe, subscription Alliance Tenant Reporting
  (c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28), rg-knowledge-hub-prod.
- Existing user-confirmed frontend-only AZCLI/SWA upload. Bicep compilation,
  template validation, what-if, Docker, policy and static/live RBAC changes
  are not applicable: no provisioning, backend, infrastructure, identity,
  dependency, database or secret configuration changes.
- System notification delivery requires browser permission and an open app
  following the turn; actual OS delivery and composer appearance were not
  manually verified. No server-side push is introduced.
- Logs: session files/athena-notification-release-{build,tests,lint}.log.
- Preserve unrelated .impeccable/hook.cache.json. Verify public entry and
  renderer asset hashes after deploying the validated dist.

**Deployment result (2026-10-23, Athena personality):**
- Source 0a43f3b committed and atomically pushed to main and the working branch.
- Validated frontend dist deployed successfully to kh-prod-web production.
- Custom and default HTTPS domains return 200 with the expected entry reference;
  all three checked assets (entry and both renderers) match local SHA-256 hashes.
- Ribbon SHA-256: d303b50be0c6a1e1cf0413832e416326954f7a00644ae654046e95bac5b42dd3
- Includes transparent reply backgrounds and idle/typing/voice personality.
  Backend and production database unchanged; token not printed or committed.
- Log: session files/athena-personality-release-deploy.log.

**Section 7: Validation Proof (2026-10-23, Athena personality):**
- User requested production deployment of voice-responsive strands, typing
  attentiveness, idle breathing and transparent assistant reply backgrounds.
- Fetched origin and merged origin/main; already current at db7eb14.
- Both explicit TypeScript checks and frontend production build passed.
- Full isolated frontend release suite passed: 224 tests, zero failures.
  Focused renderer/motion checks also passed during implementation.
- Frontend lint non-regression and git diff --check passed.
- Existing kh-prod-web target verified in West Europe, subscription Alliance
  Tenant Reporting, with the existing custom and default public domains.
- Frontend-only AZCLI/SWA upload; no backend, database, infrastructure, IAM,
  dependency or secret configuration changes. Infrastructure validation,
  provisioning and role assignment gates are not applicable.
- Existing ribbon renderer and visibility/reduced-motion handling reused;
  measured microphone input stays local, no extra requests or AI cost.
  Original handoff palette retained. The 56px host does not move or resize
  for the new personality states. History avatars remain unchanged.
- Logs: session files/athena-personality-release-{build,tests,lint}.log.
- After push/deploy, verify both public domains and entry/renderer hashes.
  Preserve the unrelated Impeccable cache change.

**Deployment result (2026-10-23, Athena and graph refinements):**
- Source bb1640c726b9b71ab179641f1b9c091f3d14fa27 committed and atomically
  pushed to main and richardichogan-local-development.
- SWA CLI successfully deployed the validated frontend dist to kh-prod-web
  production. The credential remained in the deployment process environment.
- https://athena.themicrosoftcloudblog.com and
  https://nice-mud-0f780fb03.7.azurestaticapps.net return HTTP 200 and the new
  entry asset references. Four checked assets (entry JS/CSS and both renderers)
  match local SHA-256 hashes on both domains.
- Atlas SHA-256: 152917d1a2b55e04a781aeda58635f09c7a741489ba2f7dcef0643fe45019ce4
- Ribbon SHA-256: 84956d29b657c28f4b4fd8bac29bf6ac732aca0c1338fbfa6b5e45bc33bebe83
- Backend remains v238. No production database, infrastructure, permission,
  secret configuration or desktop installer changes.
- Log: session files/athena-refinement-release-deploy.log.

**Section 7: Validation Proof (2026-10-23, Athena and graph refinements):**
- Synced origin and merged origin/main; already up to date at f3ba807.
- Frontend and backend `npx --no-install tsc --noEmit` passed.
- Frontend `npm run build` passed. Full isolated frontend release run executed
  224 tests (207 + 6 + 3 + 2 + 6); 223 passed and one stale assertion still
  expected the removed heavy graph text outline. Updated that directly affected
  assertion to require compact transparency, full-graph G100 fill and no
  strokeText; its 11-test graph-file rerun passed without failures.
- Frontend lint non-regression passed: 23 existing violations, baseline 41.
  Updated graph assertions also pass focused ESLint; git diff --check passed.
- Azure CLI verified subscription Alliance Tenant Reporting
  (c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28), established kh-prod-web in West Europe,
  its default hostname and athena.themicrosoftcloudblog.com custom domain.
- Frontend-only application upload using the existing AZCLI/SWA recipe.
  Backend remains kh-prod-api:v238; no migrations, infrastructure, IAM, role,
  identity, dependency, secret configuration or production-data changes.
  Bicep compilation, what-if, container builds and RBAC provisioning gates are
  not applicable to this static-content-only release.
- Architecture/hosting fit: existing typed chat and graph adapters retained;
  no extra AI calls, dependencies or services. Suggestions only insert drafts.
  Dense graph stability and label-budget regressions preserve all records/edges.
  The smallest safe change reuses the existing renderer and motion lifecycle.
- Browser fixture verification is incomplete: app browser previews returned a
  blank page or an expired fixture sign-in. No production content was edited.
- Logs: session files/athena-refinement-release-{build,tests,lint}.log and
  athena-refinement-release-graph-rerun.log. Preserve unrelated Impeccable cache.

**Current release (2026-10-23, Athena and graph refinements):**
- User explicitly requested deploy, merge and push to the existing production.
- Includes transparent/brighter, fixed-size Athena; borderless aligned replies;
  control-free rotating composer suggestions; quiet saved-chat restoration;
  stable dense graph physics, transparent compact graphs and bounded labels.
- Push the release atomically to main and richardichogan-local-development,
  upload validated dist to kh-prod-web production, then verify both public
  domains and exact entry/renderer asset hashes. Leave backend v238 unchanged.

**Deployment result (2026-10-23, Atlas graph and Athena Ribbon):**
- Release source 22fd5f0 committed and pushed atomically to main and
  richardichogan-local-development.
- SWA CLI 2.1.0 successfully deployed the validated dist to kh-prod-web production.
- https://athena.themicrosoftcloudblog.com and
  https://nice-mud-0f780fb03.7.azurestaticapps.net both return HTTP 200 and the
  expected entry bundle. All 14 checked assets match local SHA-256 hashes on
  both domains: entry and dynamic app/auth bundles/styles, both renderers,
  manifest, favicon, PWA icons and launcher/avatar PNGs.
- Atlas renderer SHA-256:
  c6b3cecca9d69a2d570c7e8824b5c022c061ad138c21232b463e3f148b3acc3a
- Ribbon renderer SHA-256:
  7f95a9099a227271cff72fb4dc5d27afabff6bbefa9fdb75564fa7b3ad8fa70c
- Backend v238 and production database unchanged. No infrastructure, IAM,
  identity or secret configuration changes; deployment token stayed in the
  deploy process environment and was not printed or committed.
- Deployment log: session files/atlas-ribbon-release-deploy.log.

**Section 7: Validation Proof (2026-10-23, Atlas and Ribbon release):**
- `git fetch origin` and `git merge --no-edit origin/main` completed twice;
  the worktree remains current with 3714cd9 and there are no merge conflicts.
- Both `npx tsc --noEmit` checks and `npm run build` in the frontend passed.
- Full frontend isolated release suite passed: 216 tests (199 + 6 + 3 + 2 + 6),
  zero failures. Frontend lint non-regression passed: 23 existing violations,
  within the existing baseline of 41; no baseline edits.
- The production build uses the established HTTPS backend and Entra settings,
  with no embedded API token. Both supplied renderer files and the favicon/
  192px/512px icons match public-source SHA-256 hashes exactly in dist.
  Both scripts are loaded by the built entry; no tests directory is shipped.
- Azure CLI verified the existing SWA hostname, custom domain and West Europe
  location; the user confirmed this exact production target. SWA CLI is 2.1.0.
- Backend remains kh-prod-api:v238, ready revision kh-prod-api-vnet--0000235.
  No backend code, schema, resource, role, identity or secret changes are deployed.
- Architecture/hosting fit: existing React adapters, graph APIs and static assets;
  no new dependency or model cost; typed contracts retained. No new secret handling
  or production-data writes. Thin wrappers around supplied renderers avoid a
  second physics/animation implementation. Pinned handoff colours are intentional.
- Desktop and narrow-chat synthetic checks passed before release, including
  force drag/release, graph paths, nine moods, hidden-instance pausing and the
  actual chat's three provisional draft/reset rounds revealing only one answer.
- `git diff --check` passed. Logs are session files:
  atlas-ribbon-release-{build,tests,lint}.log.

**Current release (2026-10-23, supplied Atlas graph and Athena Ribbon):**
- User explicitly requested deployment and confirmed the existing production
  frontend: kh-prod-web, West Europe, rg-knowledge-hub-prod, subscription
  Alliance Tenant Reporting (c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28).
- Frontend-only AZCLI/SWA application release. The backend and production
  database remain unchanged; no infrastructure, IAM, secret or dependency changes.
- Imported the supplied Atlas renderer and ribbon character, wired to existing
  typed graph/chat contracts. Company focus retains connected record context.
  Accepted-answer-only presentation remains intact.
- Fetched origin and merged origin/main; already current at 3714cd9.
- All validation checks must pass:
  - Both explicit TypeScript checks and the frontend production build.
  - Full frontend isolated release suite and frontend lint non-regression check.
  - Existing target/authentication, production build settings, static asset
    presence and diff hygiene.
  - Bicep, what-if, resource provisioning and RBAC changes are not applicable:
    this deploy only uploads assets to the established Static Web App.
- Targeted implementation checks already passed: graph adapters/renderer,
  ribbon geometry/moods/lifecycle, desktop and narrow-chat synthetic fixtures,
  and actual chat SSE draft/reset/accepted-answer regression.
- Post-deploy: verify the custom/default public domains and compare deployed
  entry assets, both supplied renderers and ribbon icons against local hashes.
- Preserve unrelated pre-existing .impeccable/hook.cache.json changes.

**Section 7: Validation Proof (2026-10-23, demo specification and Think fixes):**
- origin/main fetched twice; HEAD f9f2f93 includes all remote changes before release.
- Both explicit TypeScript checks and both production builds passed.
- Backend full isolated suite ran 458 tests; two stale/new fixture assertions
  were corrected. The affected 93-test rerun passed, followed by 21 final
  routing/read-only/specification/layout checks and five tagging regressions.
- Frontend full isolated suites ran 178 + 6 + 3 + 2 + 6 tests. The sole stale
  guide assertion now expects all matching edges/centres; its targeted rerun passed.
- Both lint non-regression checks now pass without baseline changes. Two
  tagging-release literals were replaced with same-valued named constants.
- The committed template exactly matches the supplied 330-line attachment.
  Every editable field was individually tested for missing/empty rejection.
- Scoped note-menu layout detector and git diff --check passed. The unrelated
  incumbent diagramIntegration.scss shadow warning is out of scope and unchanged;
  no detector suppression or user setting changes were made.
- Azure CLI verified subscription c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28, UK South
  kh-prod-api-vnet/v237, West Europe kh-prod-web and unused image tag v238.
  Azure MCP returned no subscriptions; existing authenticated CLI used unchanged.
- Container App has identity None and the established registry credential binding.
  No managed-identity AcrPull or role/provisioning changes apply. Existing latest
  revision receives 100% traffic. ACR location is East US.
- Architecture fit: uses existing chat tools, per-note chat, note persistence
  and Markdown/BlockNote conversion; immutable template rendering avoids omissions.
  Hosting: TS template compiles into the unchanged container build, no runtime
  file-copy assumption. Dependencies/cost: none added; specification schemas are
  limited to relevant conversations and existing long-output limits are reused.
  Typing/contracts: structured inputs checked before saving; legacy notes and
  brief formats remain compatible. Security: read-only and strict-project/
  exclusion guards apply, no new secrets or external writes. Smallest safe change:
  dedicated validated new-note path, not a generic prompt-only save or overwrite.
- No browser launch, production test-content write or infrastructure modification.

**Current release (2026-10-23, demo specification and pending Think fixes):**
- User explicitly requested push to remote and deployment when complete.
- Existing application-only Azure CLI recipe and production resources unchanged:
  Alliance Tenant Reporting, rg-knowledge-hub-prod, kh-prod-api-vnet and kh-prod-web.
- Includes exact-template demo specification generation, consolidated note Actions,
  diagram layout/guides/snapping and earlier graph/tooltips/AI source-handling fixes.
- No new dependencies, migrations, cloud resources, roles, secrets or permissions.
- Source is current with origin/main (f9f2f93); existing backend image is v237.
- All validation checks must pass before deployment:
  - Both TypeScript checks and both production builds.
  - Both isolated release suites, targeted diagram tests, lint non-regression.
  - Template identity against the supplied attachment, diff hygiene and architecture fit.
  - Azure CLI authentication, exact existing targets and unused next image tag.
  - Existing unchanged Docker recipe and lockfile; ACR verifies the container build.
  - Bicep, template validation, what-if, policy/provisioning and RBAC changes are
    not applicable to this application-only release.
- Post-deploy: exact source-image provenance, healthy/running revision and startup
  logs; successful SWA production upload and public asset hash verification.
- Do not launch browsers, change settings, create production test content or
  execute the generated specification's embedded Build instruction.

**Deployment result (2026-10-23, diagram styling and AI reliability):**
- Source fd24505104d605c0870923b8a8446309a5d4d5db merged/pushed atomically
  to main and richardichogan-link-think-chat-projects.
- Backend ACR build ca7e succeeded and recorded that exact git-head-revision.
  Image kh-prod-api:v236 is deployed to kh-prod-api-vnet--0000233.
- New revision is Healthy / RunningAtMaxScale, provisioning Succeeded,
  latest-ready revision matches and latest-revision traffic is 100%.
- Startup logs confirm migration completion and database pool readiness.
  Existing pg SSL-mode future-compatibility warning remains; no runtime
  configuration or migration errors were observed. JSON log output avoids
  the Azure CLI's Windows text-mode Unicode encoding error.
- Frontend production deployment succeeded. Both
  https://athena.themicrosoftcloudblog.com and
  https://nice-mud-0f780fb03.7.azurestaticapps.net serve the expected release
  entry and all three checked entry-asset SHA-256 hashes match local dist.
- No infrastructure, dependency, secret, identity or permission changes;
  no browser launch, manual production test-content writes or system changes.
  Normal existing backend startup/scheduler operations remain enabled.
- Architecture fit: existing document history/autosave handles each bulk edit
  atomically; typed style patches preserve stored data contracts. Existing
  AI budgets and audit persistence are reused without added model calls.
  The bounded fix avoids a new styling framework, budget increases, migrations
  or historical audit rewrites. No new secret-handling paths were introduced.
- Design-hook fixture-colour warnings are intentional legacy/custom-colour
  test inputs. Incumbent unrelated typography and side-tab styling are unchanged.
- Logs: session files/v236-acr-build.log, v236-frontend-deploy.log,
  v236-backend-startup-json.log (text-mode diagnostics in v236-backend-startup.log).

**Section 7: Validation Proof (2026-10-23, diagram styling and AI reliability):**
- Fetched origin and merged origin/main; already current at 8cd688b.
- Both explicit `npx tsc --noEmit` checks and both production builds passed.
- Backend isolated release suite: 446 passed, zero failures.
- Frontend isolated release suites: 189 passed (172 + 6 + 3 + 2 + 6),
  zero failures. New regressions cover mixed-selection immutable edits,
  preservation of unselected objects, readable legacy labels and bold fills.
- Both lint non-regression checks and `git diff --check` passed.
- Azure CLI target checks succeeded for subscription c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28,
  UK South backend v235, West Europe SWA kh-prod-web and unused ACR tag v236.
- Azure MCP used a mismatched tenant; the existing authenticated Azure CLI
  successfully verified the exact established resources without login changes.
- Dockerfile and lockfile reviewed; ACR builds this unchanged container recipe.
  No infrastructure templates, identities, roles or data operations changed;
  static RBAC changes, Bicep/what-if and provisioning are not applicable.
- Existing production target remains the one explicitly configured by the user.
  Confirmation was offered again; user unavailable and requested autonomous work.
- Logs: session files/v236-{backend,frontend}-{build,tests,lint}.log.

**Diagram styling and AI answer reliability release (2026-10-23):**
- User explicitly requested deployment, merge and push of the current fixes.
- Existing AZCLI application-only recipe: backend kh-prod-api-vnet and ACR
  cad79107555facr (UK South), frontend kh-prod-web (West Europe), resource group
  rg-knowledge-hub-prod, subscription Alliance Tenant Reporting.
- Includes shared multi-selection styles, stronger matching-hue diagram fills,
  AI action-answer calibration, bounded search previews, admitted-only evidence,
  exact saved-message audit links, and the Claude Design guide.
- No infrastructure, identity, permission, secret, database schema or dependency
  changes. Custom diagram colours and stored legacy colours remain intact.
- Previous backend v235; next image tag must be verified unused before build.
- All validation checks must pass:
  - Fetch and merge origin/main before building the release.
  - Both explicit TypeScript checks, both production builds.
  - Isolated backend/frontend release suites and lint non-regression.
  - Diff hygiene and Azure CLI authentication/existing-target checks.
  - ACR builds the production image from the pushed exact main commit.
  - Bicep compilation, template validation, what-if and provisioning do not
    apply: no infrastructure templates or RBAC assignments change.
- Post-deploy: backend healthy/running revision and startup log review;
  frontend successful production upload and public release-asset comparison.
- No browser launch, system-setting changes or production test-content writes.

**Deployment result (2026-10-23, provisional-answer redraw fix):**
- Release cba34d1 pushed atomically to main and richardichogan-local-development.
- Frontend deployed successfully to kh-prod-web production after one transient
  Azure content-server failure; the identical build succeeded on retry.
- Both public domains return HTTP 200 with the matching release entry.
  SHA-256 comparisons passed for index-DOlNM5X6.js, AIChatPage-B0SqLbui.js,
  appBootstrap--y_LZpH_.css and appBootstrap-nogEcoiL.js.
- Backend remains v235; no production content or database writes.
- Successful deployment log: session files/chat-redraw-release-deploy-retry.log.

**Section 7: Validation Proof (2026-10-23, provisional-answer redraw fix):**
- User confirmed kh-prod-web, West Europe, rg-knowledge-hub-prod, in
  Alliance Tenant Reporting (c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28).
- Fetched and merged origin/main; already current at 193a97f.
- Both applications' `npx tsc --noEmit` checks passed.
- Frontend production build, lint non-regression and diff hygiene passed.
- Frontend isolated release suite: 174 passed (157 + 6 + 3 + 2 + 6), zero failures.
- During development, the isolated actual-chat SSE fixture verified that three
  draft/reset/tool rounds and a populated reconnect snapshot retain the working
  view; only an accepted answer appears, while stopped/failed drafts stay hidden.
- Azure authentication and existing SWA target verified; backend remains v235.
- Existing SWA asset-only release: no infrastructure, roles, identities, secrets,
  policy, dependency or database changes. Bicep, what-if, provisioning, Docker
  and RBAC changes are not applicable.
- Scope: reveal accepted answers once while progress remains live, including
  alternate-model replies. Backend draft-revision behavior is unchanged.
- Rollback frontend source: 193a97f. Push release to main and the session branch
  before deploying the matching local dist.
- Logs: session files/chat-redraw-release-{build,tests,lint}.log.

**Deployment result (2026-10-23, chat animation and references):**
- Release source d53fcab2e762eb6167790b9f023de663e5928ff5 pushed atomically
  to main and richardichogan-local-development.
- Frontend deployed successfully to kh-prod-web production.
- https://athena.themicrosoftcloudblog.com and
  https://nice-mud-0f780fb03.7.azurestaticapps.net both return HTTP 200 and
  serve the matching release entry. SHA-256 comparisons passed for all four
  checked assets: index-BZjoIim6.js, AIChatPage-DP98nXnI.js,
  appBootstrap-C1A_3S8Q.css and appBootstrap-D2Qw9Bgu.js.
- Backend remains v235; no infrastructure, database or production content writes.
- Deployment log: session files/chat-motion-release-deploy.log.

**Section 7: Validation Proof (2026-10-23, chat animation and references):**
- Both applications' `npx tsc --noEmit` checks passed.
- Frontend production `npm run build` and `npm run lint:check` passed.
- Frontend `npm run test:isolated`: 184 tests passed across five runners
  (167 + 6 + 3 + 2 + 6), zero failures.
- Azure CLI authentication verified; live SWA target is kh-prod-web in West
  Europe. Backend image verified v235 and will not be updated.
- Existing SWA-only release; no infrastructure, role, identity, policy or
  provisioning changes, so template/what-if/container validation is not applicable.
- Release logs: session files/chat-motion-release-{build,lint,tests}.log.

**Chat animation and references release (2026-10-23):**
- User confirmed the existing frontend target: kh-prod-web, West Europe,
  rg-knowledge-hub-prod, Alliance Tenant Reporting
  (c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28).
- Frontend-only SWA deployment: full Athena v3 motion, centred/wrapped progress,
  answer choreography and compact reference disclosure/styling.
- Fetched and merged origin/main; already current at 0a9cc82.
- Backend remains v235. No backend, database, dependency, infrastructure,
  identity, secret or permission changes. Rollback: frontend source 0a9cc82.
- All validation checks must pass:
  - Azure CLI authentication and existing SWA target verification.
  - Both application typechecks; frontend production build.
  - Frontend isolated release suite, lint non-regression and diff hygiene.
  - Prior fixture-only browser checks cover motion, responsive references,
    source inclusion/exclusion and model-menu access; no production writes.
  - Bicep compilation, template validation, what-if, Docker, policy changes,
    provisioning and static/live RBAC changes are not applicable to this
    existing SWA asset-only release.
- Commit/push the exact release to main and the session branch; deploy the
  matching local build and compare public asset hashes with the local files.

**Section 7: Validation Proof (2026-10-23, Discover and drafting release):**
- Both explicit `npx tsc --noEmit` checks and both production builds passed.
- Isolated release suites passed: backend 422; frontend 165; zero failures.
- Both lint non-regression checks passed. Fixed the new blog-repair response
  array typing; backend typecheck/build and all 16 directly affected blog tests
  passed again after that type-only correction.
- Azure CLI authentication and existing target resources verified. Production
  backend is v234 and ACR tag v235 is unused. Existing SWA hostname verified.
- Existing AZCLI application-only recipe: no infrastructure, policy, role or
  managed-identity changes. Template validation/provisioning are not applicable.
  Dockerfile and lockfile exist; ACR builds the production container before update.
- Logs: session files/v235-{backend,frontend}-{build,tests,lint}.log and
  v235-blog-final-tests.log. Tests use isolated credentials, not production data.

**Discover, indexing and blog drafting release (2026-10-23):**
- User explicitly requested deployment of the current changes to the existing
  production targets in Alliance Tenant Reporting (c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28).
- AZCLI image-only update: kh-prod-api-vnet, cad79107555facr and kh-prod-web in
  rg-knowledge-hub-prod. Existing UK South backend and West Europe frontend;
  no infrastructure, identity, secret, permission or resource provisioning changes.
- Includes Discover voting, change-only content indexing, optional passage-index
  handling, reduced edge inference, source-link removal and checked blog revisions.
- Migration 094 retries failed content-item indexing jobs; it does not edit notes.
- Main fetched and merged; already current. Current image v234; v235 is unused.
  Rollback is image v234 and frontend source 268f8eb.
- Validation: both typechecks/builds, isolated release suites, lint non-regression
  and diff hygiene. No browser or production-data test fixtures.
- Commit and push main plus the session branch, build ACR image from main, check
  revision health/startup logs, deploy matching SWA assets and verify deployment.

**Section 7: Validation Proof (2026-10-22, knowledge graph release):**
- Both `npx tsc --noEmit` checks and both production `npm run build` commands passed.
- Database-free release suites: backend 411 passed, frontend 167 passed
  (150 + 6 + 3 + 2 + 6), zero test failures. After backend lint-only fixes,
  its typecheck/build and the three graph service tests passed again.
- Frontend lint non-regression passed (25 existing violations, baseline 41).
  New backend graph files pass ESLint with zero warnings. Backend baseline has
  one pre-existing foundryClient.ts:439 magic-number warning: verified that file
  byte-for-byte against HEAD; no release-introduced violations remain. No baseline
  was rewritten and the unrelated file was not changed.
- Live read-only graph projections returned valid bounded overview and two-hop
  data. Desktop browser checks covered separate Canvas 2D and WebGL 3D surfaces,
  actual force motion, labels, selection, isolation and fitting.
- Azure authentication, existing SWA hostname/location, backend v232/ready
  revision, latest-revision traffic and registry settings verified. Next tag v233
  is unused. User explicitly reconfirmed existing production targets.
- Dockerfile and backend lockfile present. ACR performs the production container
  build using the existing recipe. No infra/RBAC change or managed identity:
  template compilation, what-if and role provisioning are not applicable.
- Build/test logs: session files/graph-release-*.log. `git diff --check` passed.

**Knowledge graph and diagram release (2026-10-22):**
- User approved deployment to the existing Alliance Tenant Reporting subscription
  (c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28): kh-prod-api-vnet (UK South),
  cad79107555facr and kh-prod-web (West Europe), rg-knowledge-hub-prod.
- Existing AZCLI image-only backend and SWA production deployment. No infrastructure,
  schema, identity, secret, permission or background backfill changes.
- Release the read-only graph projection, force-directed 2D view, separate lazy 3D
  explorer, note mini graph, activity view and usability fixes. Include the pending
  neutral diagram shape transparency and top-left drill-down icon changes.
- Fetched and merged origin/main: already current. Current production backend is
  v232, ready revision kh-prod-api-vnet--0000229. Use the next unused image tag.
- Validate both typechecks/builds, isolated backend/frontend tests, lint baselines
  and diff hygiene; commit and push the exact release to main and the session branch.
- Build the backend from remote main, verify healthy revision and startup logs, then
  deploy the matching local frontend. Verify served asset hashes and graph contract.
- Rollback: restore backend v232 and frontend built from 6652b80.
- No new resource provisioning: Bicep/what-if/policy changes are not applicable.
  Existing registry uses secret-based authentication, not managed-identity AcrPull.

**Deployment result (2026-10-22, chat/Note styling):**
- Source 3bfafb4 pushed to main and session branch; frontend deployed to
  kh-prod-web production. Chat blockquotes are unboxed; Note tags are yellow.
- Both public domains serve index-CY_DlrZX.js, appBootstrap-D_5YPK6q.js and
  appBootstrap-D8a2RhdS.css matching the local build by SHA-256.
- Backend unchanged: v232, latest ready revision kh-prod-api-vnet--0000229.
- EPAM, BCG and SIGMOID company records were persisted and read back separately,
  linked to Reckitt. Original source notes remain unchanged.

**Chat quote and Note tag styling release (2026-10-22):**
- Deploy the two pending frontend styling changes: unboxed chat blockquotes
  and warm yellow Note tags. Company records were already persisted separately.
- Existing SWA-only recipe: kh-prod-web, rg-knowledge-hub-prod, West Europe,
  Alliance Tenant Reporting (c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28).
- Backend remains v232. No infrastructure, schema, dependencies or secrets change.
- Fetch/merge main, both typechecks, frontend build and database-free isolated
  tests, lint non-regression and compiled-style assertions; commit/push, deploy
  frontend, verify public application asset hashes. No browser launch.
- Rollback: redeploy previous frontend build from c6cab5d.
- User approved the existing frontend target/subscription/location. Main fetched
  and merged; already current.

**Section 7: Validation Proof (2026-10-22, chat/Note styling):**
- Both `npx tsc --noEmit` checks passed; frontend `npm run build` passed.
- Frontend database-free isolated suites: 160 passed (143+6+3+2+6), no failures.
- Frontend lint non-regression passed: 25 existing violations, baseline 41.
- Compiled Sass assertions confirmed transparent/borderless chat blockquotes,
  preserved document quote styling and yellow Note tags with matching tint.
- `git diff --check` passed. Azure CLI authenticated; existing SWA location and
  hostname verified. User confirmed subscription and target.
- Existing SWA-only deployment: Docker, template/what-if, policy changes,
  infrastructure provisioning and RBAC changes not applicable.
- Release build/test logs retained in session files/chat-styling-release-*.log.

**Deployment result (2026-10-22, diagram/company release):**
- Source 0d5869294a37e24f6470cf63a871da9c7fdf7db5 committed and atomically
  pushed to main and richardichogan-link-think-chat-projects.
- ACR run ca7a built and pushed kh-prod-api:v232 successfully from main.
  Image digest:
  sha256:4fff18d0645af5fe34db480082d8a0bdbf96b740a75ae7e0e230b2bd20b02ea6.
- Backend revision kh-prod-api-vnet--0000229 is latest ready, Healthy /
  RunningAtMaxScale, with 100% traffic. Migration
  093_company_people_relationships.sql completed successfully at 18:14 UTC;
  all 8/8 database connections pre-warmed.
- KNOWLEDGE_ORCHESTRATION remains true; image-only update preserved the
  existing registry authentication, secrets and runtime configuration.
- Matching frontend deployed to kh-prod-web production. Custom domain
  https://athena.themicrosoftcloudblog.com and default SWA domain
  https://nice-mud-0f780fb03.7.azurestaticapps.net both serve index-CbWFtjHT.js,
  appBootstrap--4NJEZ2v.js and appBootstrap-C2LTGTlt.css matching the local
  production build byte-for-byte by SHA-256.
- No browser launched, test database provisioned, production test records
  created or manual backfill run. The additive schema migration and normal
  application startup/scheduler operations ran as part of deployment.
- BCG/Candela/Reckitt relationships were not inferred or seeded. The UI now
  supports explicitly recording those company/person/programme relationships.

**Diagram usability and linked company/person release (2026-10-22):**
- User approved implementation, merge/push and production deployment. Preserve
  existing targets: Alliance Tenant Reporting, rg-knowledge-hub-prod,
  kh-prod-api-vnet (UK South), cad79107555facr, kh-prod-web (West Europe).
- Existing AZCLI image-only backend and SWA deployment; no infrastructure,
  identity, permissions, secrets, dependencies or new services.
- Fix diagram navigation, grid/guides, standard Agent preset, clipboard/image
  actions, content colours, persistent drill-down Athena and top-layer menus.
- Add company pages, person/company/programme relationships and @mention
  creation. Migration 093 adds schema only: no seed records, backfills or
  conversion of existing organisation text.
- Do not launch browsers, provision test databases, run database-backed
  suites or create production test records. Existing monitoring stays enabled.
- Fetched origin/main and merged: already current at 54071be.
- Current backend verified v231; choose next unused tag from registry.
  Rollback is v231 plus the previous frontend build. The additive schema
  can remain if the application image is rolled back.

**Section 7: Validation Proof (2026-10-22, diagram/company release):**
- azure-validate: both `npx tsc --noEmit` checks passed. Both production
  `npm run build` commands passed, including the final Athena menu changes.
- Database-free frontend isolated suite: 159 passed, zero failures.
  After final changes, affected clipboard/top-layer/usability checks: 8 passed.
  Existing pure diagram geometry checks: 33 passed.
- Backend company/relationship and diagram checks: 40 passed using mocked
  Pool methods and dummy connection settings; no database instance or writes.
- Known database-backed test fixtures were updated for the additive company
  schema but were deliberately not executed under the user's restrictions.
- Frontend lint non-regression passed: 25 existing violations, baseline 41.
  New company modules, image viewer/helper, shared menu hook, mention menu,
  clipboard helper and MoveToThink passed focused ESLint. Existing lint
  violations outside the changed logic were not modified.
- `git diff --check` passed. Dependency manifests and Dockerfile unchanged;
  package-lock exists. ACR performs the actual production container build
  from pushed main; local Docker is not required.
- Azure CLI authenticated to c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28.
  Existing backend v231 and SWA hostname verified; orchestration is true.
- Bicep/template/what-if/policy/static-RBAC/provisioning/azd environment
  creation are not applicable: existing image/SWA release with no infra changes.
- No browser run; actual pointer/focus/clipboard interaction is not manually
  verified. Automated tests cover navigation, alignment thresholds, exports,
  top-layer positioning/cleanup, clipboard activation/SVG cleanup, validation,
  relationship transaction handling and mention links.

**Change-fit review:**
- Architecture: existing React/React Query/API/SQL patterns, shared anchored
  menu hook and existing Specialist Agent preset; no parallel implementation.
- Hosting: existing Container Apps, ACR and SWA assumptions retained.
- Dependencies/cost: no new dependencies, infrastructure or background/model calls.
- Types/contracts: optional grid spacing preserves old diagrams; typed company
  records and runtime input validation, no explicit any or loosened contracts.
- Security: authenticated stored-image reads only, no arbitrary URL proxy;
  parameterized SQL, safe website protocols, no credentials in source.
- Smallest safer version: additive relationship schema with explicit user-set
  links, no inferred records/backfill, existing app services and image-only rollout.

**YouTube evidence and related-reading release (2026-10-22):**
- User requested deploy and push to remote. Deploy current YouTube caption
  attempts, secondary subject research, safe video deep dives and related links.
- Existing AZCLI image-only backend plus SWA frontend deployment. Subscription
  Alliance Tenant Reporting, rg-knowledge-hub-prod; backend kh-prod-api-vnet in
  UK South, ACR cad79107555facr, frontend kh-prod-web in West Europe.
- No infrastructure, dependency, migration, permission or secret changes.
- Also persist requested AI knowledge coverage/semantic-layer specification,
  without implementing or deploying those proposed capabilities.
- Sync main, validate both applications and existing release suites, commit/push,
  build next backend image, deploy both applications, verify health and assets.
- No browser launch or manual production backfill.
- User reconfirmed existing subscription and production resource locations.
- origin/main fetched and merged, already current at 15d585d. Current backend
  v228; next image tag v229. Rollback uses v228 and previous SWA build.

**Section 7: Validation Proof (2026-10-22, YouTube evidence release):**
- Validated under azure-validate after explicit production target confirmation.
- Both applications: `npx tsc --noEmit` and `npm run build` passed.
- Backend `npm run test:isolated`: 215 passed, zero failed.
- Frontend `npm run test:isolated`: 142 passed across four runners
  (131 + 6 + 3 + 2), zero failed, including related-reading notice tests.
- Frontend `npm run lint:check`: non-regression passed, 25 existing violations
  against baseline 41. Focused ESLint on youtube.ts, youtubeCaptions.ts and
  youtubeEvidence.ts passed. `git diff --check` passed.
- Azure CLI authenticated and existing backend/frontend targets verified.
  Backend v228, next unused tag v229. Existing secret-based ACR authentication
  preserved; no managed-identity/AcrPull changes.
- Dockerfile and package-lock.json verified. ACR builds the production container
  from pushed main. No local Docker prerequisite for remote ACR builds.
- Template compilation/validation/what-if, policy, static RBAC, provisioning and
  azd environment creation are not applicable to this existing image-only/SWA
  release; no infrastructure changes are included.
- Completed checks on 2026-10-22 around 08:04 UTC. Logs retained in session
  files/youtube-release-{backend-tests,frontend-build,frontend-tests}.log.

**Deployment result (2026-10-22, YouTube evidence release):**
- Source 029c650 pushed to feature branch and main. ACR run ca77 built v229
  successfully from main; digest
  sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0.
- Backend revision kh-prod-api-vnet--0000226 is latest ready, Healthy /
  RunningAtMaxScale, with 100% traffic. Startup logs confirm migration complete
  and 8/8 database connections warmed.
- Frontend deployed to kh-prod-web production. Custom and default SWA domains
  serve index-CHhH54Ok.js, appBootstrap-C-vitBTt.js and
  appBootstrap-BDIr9sFY.css matching the local release by SHA-256.
- Public captions are attempted, not guaranteed available. Subject research and
  related background links remain explicitly separate from transcript evidence.
- Existing unprocessed videos enrich in bounded batches during normal production
  sync; no manual production backfill or browser verification was performed.
- AI coverage and Athena-native semantic-layer documents were pushed as proposed
  specifications only; those capabilities were not implemented by this release.

**Watchlists backend repair release (2026-10-21):**
- User directed deployment after the database upgrade, approving the pending
  backend repairs to the existing production resources and locations.
- Recipe: AZCLI image-only update, kh-prod-api-vnet in UK South, ACR
  cad79107555facr, rg-knowledge-hub-prod, Alliance Tenant Reporting.
- Sequential project context loading reduces connection bursts; one bounded
  AI correction repairs omitted project assessments with strict revalidation.
  Failure messages distinguish invalid analysis from other monitoring failures.
- Frontend unchanged. No new infrastructure, permissions, secrets, dependencies,
  migrations, monitoring reruns or content publishing.
- origin/main fetched and merged; already current. Validate both typechecks,
  backend build, isolated backend suite and focused lint. Commit and push source
  to branch and main, build next unused image tag, update existing app.
- Verify latest revision health, traffic and startup logs. Rollback to v227 if
  rollout fails; preserve the separately approved upgraded database.
- User reconfirmed existing subscription and UK South backend target.

**Section 7: Validation Proof (2026-10-21, Watchlists backend repair):**
- Fetch/merge origin/main succeeded, already current.
- Both applications: `npx tsc --noEmit` passed.
- Backend: `npm run build` and `npm run test:isolated` passed, 227 tests,
  zero failures, including 10 Watchlists tests.
- Focused ESLint on discoverWatchlists.ts and `git diff --check` passed.
- CLI authenticated to confirmed subscription. Current backend v227, next
  unused tag v228. Dockerfile and package-lock.json present and unchanged.
- ACR performs production Docker build from pushed main; no local Docker
  prerequisite. Existing image-only rollout: template/what-if, policy changes,
  provisioning, static RBAC changes and azd environment creation not applicable.
- Existing registry authentication preserved. No managed identity/AcrPull changes.
- Database upgrade separately verified Ready with live max_connections=100.

**Deployment result (2026-10-21, Watchlists backend repair):**
- Source 758b39a pushed to feature branch and main; ACR build succeeded for
  kh-prod-api:v228 from main.
- Revision kh-prod-api-vnet--0000225 is Healthy / RunningAtMaxScale with
  100% traffic. Previous revision has been removed from the active list.
- Startup logs confirm migrations completed and 8/8 database connections warmed.
  Live Watchlists, history and baseline reads return successful 304 responses.
- Production backend repairs deployed; frontend unchanged. No manual monitoring
  rerun or content publishing performed. A successful fresh AI analysis has not
  been verified by this deployment.

**Watchlist crash and blog editor frontend release (2026-10-21):**
- User explicitly approved deploying both frontend fixes to the same production
  resources confirmed above: kh-prod-web, Alliance Tenant Reporting, West Europe.
- Frontend-only SWA recipe; backend stays v227. Backend edits only correct erased
  TypeScript coverage types to match existing empty coverage on failed runs.
- Actual AI Platform Moves run failed with coverage {}. Rendering that run
  reproduced the exact "Cannot read properties of undefined (reading 'length')"
  exception in coverageGaps / HistoryRun. Fixed renderer shows explicit missing
  coverage and preserves previous completed briefings.
- Blog Post field defaults to editable rich text with an HTML source toggle.
  Both modes share HTML content and preserve the existing publish payload.
- All validation checks must pass: sync origin/main, both typechecks, frontend
  build, frontend isolated suite, targeted watchlist tests and frontend lint.
- No infrastructure, schema, permissions, secrets or dependency changes.
- Deploy frontend and verify public entry and application assets match by SHA-256.
- Rollout completed; details below.

**Deployment result (2026-10-21, Watchlist/blog frontend release):**
- Source 5cdddd9 committed and pushed to the feature branch and main.
- Frontend deployed successfully to kh-prod-web production; backend remains v227.
- Both athena.themicrosoftcloudblog.com and the default SWA hostname serve
  index-COdYSCXS.js, appBootstrap-1JOu4eFc.js and appBootstrap-Cfk364Fe.css
  matching the local production build byte-for-byte by SHA-256.
- Watchlists now renders the failed AI Platform Moves run with missing-coverage
  disclosure rather than crashing. The monitoring run's underlying failure is
  not repaired or retried by this frontend rollout.
- Blog editor rich-text/HTML toggle deployed; both save actions retain HTML.
- No content writes, monitoring reruns, browser launches or infrastructure changes.

**Section 7: Validation proof (2026-10-21, Watchlist/blog frontend release):**
- Fetch/merge origin/main completed; already current at 1ef7fda.
- Both `npx tsc --noEmit` passed; frontend `npm run build` passed.
- Frontend isolated suite passed: 125 unit tests plus 11 bundled component tests.
  Includes two new editor tests and two full Watchlists-render regressions.
- Both Watchlists regressions fail against deployed code with the screenshot's
  exact exception in coverageGaps / HistoryRun, and pass against corrected code.
- Eight targeted backend Watchlists tests passed; erased types now accurately
  describe missing coverage. No backend runtime code or image changes required.
- Frontend lint baseline passed (25 existing, baseline 41); editor focused lint
  and Sass compilation passed. `git diff --check` passed.
- CLI authenticated to confirmed subscription c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28;
  existing kh-prod-web West Europe target verified. SWA frontend-only recipe:
  no Docker build, template/what-if, policy, infrastructure or RBAC changes.
- No browser launched, monitoring rerun, data edits or posts created for checks.
- The underlying failed analysis has not been diagnosed: old revision has no
  replica available for log retrieval. Do not claim the monitoring failure fixed.

**Discover performance and usability release (2026-10-21):**
- User approved deploying the current Discover, Mural and teleprompter fixes.
- Existing image-only AZCLI recipe: backend kh-prod-api-vnet and ACR
  cad79107555facr, frontend kh-prod-web, resource group rg-knowledge-hub-prod,
  subscription Alliance Tenant Reporting. Preserve current locations and hosting.
- No infrastructure, identity, secrets, dependencies, schema or capacity changes.
- Replace repeated saved-source scans with one-time sets, materialize ranking,
  and share the first-page For you and briefing request with a one-minute cache.
  Measured full 100-item route response: 549 ms then 215 ms, 454 eligible items.
- Also deploy balanced source ranking, parked indicators, Athena-only Mural
  listings, create-and-export dialog, and faithful/persisted Autocue settings.
- Fetch/merge main, run both typechecks/builds and isolated suites, commit/push
  current fixes, increment deployed image tag, update backend and deploy frontend.
- Verify healthy revision, startup logs and deployed frontend assets.
- No browser launch authorised.

**Deployment result (2026-10-21, Discover performance release):**
- Source 04315a1 committed and pushed to the feature branch and main.
- ACR run ca75 built kh-prod-api:v227 from main; image digest
  sha256:771ccfcbb71115ced322ab1d019de7fa367449feed5f120877064a7d36e117aa.
- Revision kh-prod-api-vnet--0000224 is latest ready, Healthy /
  RunningAtMaxScale, receiving 100% traffic. Migrations completed and all eight
  database connections pre-warmed. Previous revision is deprovisioning.
- Matching frontend deployed to kh-prod-web. Both public domains serve
  index-6MQV7KXi.js, appBootstrap-B4bm_5Wc.js and appBootstrap-CTDww7Of.css
  matching the local production build byte-for-byte by SHA-256.
- Local optimized backend restarted and listening on 3000; frontend remains
  running on 5173. No database upgrade, infrastructure or permissions changed.
- Timings above measure the full feed handler, not browser end-to-end reload.
  No browser launched or production content created as a deployment check.

**Section 7: Validation proof (2026-10-21, Discover performance release):**
- Fetched and merged origin/main; already current at 3cf678a.
- `npx tsc --noEmit` and `npm run build` passed in both applications.
- Backend `npm run test:isolated`: 226 passed, zero failures, including saved-source
  equivalence, hashed query plans, ranking diversity and stable pagination.
- Frontend `npm run test:isolated`: 127 unit tests and 9 bundled component tests
  passed. Additional Autocue and Discover insight tests: 3 passed.
- Frontend lint non-regression passed (25 existing, baseline 41). Backend baseline
  reports one pre-existing dailyInsightsParser.ts:85 violation; that file is
  unchanged from HEAD. No new backend lint findings introduced by this release.
- CLI 2.79.0 authenticated to the user-confirmed Alliance Tenant Reporting
  subscription. Existing backend UK South, SWA West Europe and ACR eastus verified.
- Dockerfile/lockfile unchanged and present; TypeScript application build passed.
  ACR will perform the production container build from synced/pushed main.
- Image-only rollout: no Bicep/template/what-if, policy, provisioning, static-role
  or RBAC changes apply. Existing registry uses secret-based auth, not managed
  identity; no AcrPull propagation gate or azd environment is applicable.
- Full 100-item Discover route measured against the real database: 549 ms cold
  and 215 ms warm, 244141-byte response; previous feed query alone was 5589 ms.
- `git diff --check` passed. Production currently v226; next image v227.

**Deployment result (2026-10-21, restricted-workspace correction):**
- Source cf2401e pushed to feature branch and main. ACR run ca74 built
  kh-prod-api:v226, digest
  sha256:53455c60bf78917bc77986bd62767c3f6785544adf9b7f383f75625cdf5015e7.
- Revision kh-prod-api-vnet--0000223 is Healthy / RunningAtMaxScale,
  Provisioned and latest ready, receiving 100% production traffic. Startup
  completed migrations and pre-warmed 8/8 database connections.
- Matching warning-aware frontend deployed to kh-prod-web production.
  Both public domains serve index-DwqsYXyY.js, appBootstrap-BgmFcoZr.js and
  appBootstrap-Ci8mQWcg.css matching the local build by SHA-256.
- Actual renewed grant verified before rollout: 42 boards and 77 rooms
  returned, including Reckitt SDLC, with explicit microsoft1254 restrictions.
  No board creation or diagram export performed. No further consent needed
  for this fix; existing open applications must reload the new frontend.
- Isolated browser helper stopped; unrelated hook cache remains untouched.

**Mural restricted-workspace correction (2026-10-21):**
- Root cause confirmed with read-only requests using the renewed saved grant:
  global workspaces and Athena boards return HTTP 200. Only microsoft1254
  returns 403 WORKSPACE_LIST_MEMBERS for board and room listing. The prior
  implementation aborted all results and incorrectly diagnosed missing scopes.
- Preserve accessible lists with explicit restricted-workspace warnings.
  Only the specific provider membership code on individual-workspace endpoints
  is handled; global/unknown denials and pagination failures still error.
  New warning-aware clients opt in; existing list API contracts remain intact.
- Reuse existing image-only AZCLI and SWA deployment to the same production
  resources. No infrastructure, dependencies, database schema or permissions
  changes. No new boards or widgets created during diagnosis.
- Functional proof: fixed service returned 42 real boards and 77 rooms,
  including Reckitt SDLC in Athena, plus the two expected restriction warnings.
  Both typechecks, builds, focused lint and 16 Mural tests passed; browser
  fixture passed destination workflows with visible board and room warnings.

**Section 7: Validation proof (2026-10-21, workspace denial correction):**
- `npx tsc --noEmit`, `npm run build` passed in both applications after final
  API opt-in changes. Focused backend/frontend ESLint passed and frontend
  `npm run lint:check` passed (25 existing violations, baseline 41).
- `node --import tsx/esm --test --test-force-exit scripts/mural.test.ts`
  passed 16/16, including restricted-workspace isolation, mandatory warnings,
  and rejection of global/unknown denials rather than silent partial success.
- Live service reads returned 42 boards, 77 rooms, Reckitt SDLC and explicit
  microsoft1254 membership warnings. Browser fixture passed all 15 workflows
  plus board/room warning assertions; narrow screenshot shows styled controls.
- Fetched and merged origin/main, already up to date. Azure CLI confirmed
  Alliance Tenant Reporting c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28 and current
  image v225; next image v226. Existing secret registry auth preserved.
- Image-only/SWA recipe; Bicep, what-if, provisioning, policy and RBAC changes
  are not applicable. Same Dockerfile/lockfile and hosting are retained.

**Deployment result (2026-10-21, Mural destinations release):**
- Source 244c408 pushed to the feature branch and main. ACR run ca73 built
  kh-prod-api:v225, digest
  sha256:58584b4e571fa353375a46a1d132bbadad7c310da6c90242673c534fe6ee7991.
- Backend revision kh-prod-api-vnet--0000222 is Healthy / RunningAtMaxScale,
  Provisioned, latest ready, with 100% production traffic. Startup logs
  confirm migrations completed and all eight database connections warm.
- Matching frontend deployed to kh-prod-web production. Both public domains
  serve the new entry and Mural application JS/CSS byte-for-byte:
  index-DKn6Zh_m.js, appBootstrap-DjvvcF-q.js, appBootstrap-Ci8mQWcg.css.
  SHA-256 verification passed on athena.themicrosoftcloudblog.com and
  nice-mud-0f780fb03.7.azurestaticapps.net.
- Existing/new Mural destinations, room selection, board creation and the
  native shape/image payload corrections are deployed together. Desktop loads
  the hosted frontend; no desktop/plugin binary change was required.
- User must enable workspaces:read and rooms:read in the Mural app and
  reconnect. No live boards/widgets were created by this rollout; full
  real-account export remains user-driven. Earlier partial objects remain.
- The isolated browser server was stopped. Unrelated hook cache preserved.

**Mural destination release (2026-10-21):**
- User authorised deployment with two export destinations: add to an existing
  board or create a new board. Include the pending board picker and native
  widget payload correction.
- Modify existing frontend and backend only; preserve Container Apps and
  Static Web Apps hosting, credentials, data and infrastructure.
- Implement room selection and board naming for new boards, using documented
  Mural APIs. Validate before any external creation; never retry writes.
- Run both typechecks, focused tests and production builds, then validate
  and deploy matching frontend/backend. Record actual rollout evidence.

**Section 7: Validation proof (2026-10-21, Mural destinations release):**
- Explicitly authorised by the user: deploy with existing-board and new-board
  destinations. Existing Alliance Tenant Reporting subscription and UK South
  production resources remain the established deployment target.
- Both applications passed `npx tsc --noEmit` and `npm run build`.
  Focused backend Mural tests passed 15/15; focused frontend/backend ESLint
  passed. Frontend lint non-regression passed (25 existing, baseline 41).
- Azure CLI authentication confirmed subscription
  c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28 and current backend image v224.
- Image-only Container Apps and existing SWA deployment: no infrastructure,
  dependencies, migrations, RBAC, policy, environment or secret changes.
  Bicep compilation, template validation, what-if and static role checks are
  inapplicable. Dockerfile and package-lock exist; ACR performs the container
  build from the pushed source before the image update.
- Functional verification uses isolated mock API/browser fixtures, not
  speculative writes to the user's Mural. A complete live export still needs
  the user's renewed Mural consent and explicit export action.
- Isolated browser fixture passed all 15 checks: board grouping/defaults,
  archived/manual URL/error states, room selection, one-time creation,
  ambiguous-failure retry protection and selected destination retention.
  Fetched and merged origin/main again before the final frontend build;
  already up to date. Backend Dockerfile retains schema/migration copies.

**Deployment result (2026-10-21, coordinated fixes release):**
- Source 0b4f25f pushed to the feature branch and main. ACR run ca72 built
  kh-prod-api:v224, digest
  sha256:68b7d559c0751521cad6dd73357b7e8309e5570c852359b6f9da0355a95fb726.
- Backend revision kh-prod-api-vnet--0000221 is Healthy /
  RunningAtMaxScale, Provisioned, and receives 100% of production traffic.
  Startup logs confirm completed migrations and a warm database pool.
- Matching frontend deployed to kh-prod-web production. Both
  https://athena.themicrosoftcloudblog.com and
  https://nice-mud-0f780fb03.7.azurestaticapps.net serve /present with HTTP 200.
  Entry index-DaMZgheS.js, Presenter-B7x9yW5q.js and
  Presenter-DFW08jQ3.css match the validated local build by SHA-256 on both
  domains. Deployed CSS includes the persistent vertical scrollbar.
- Desktop 0.1.7.0 installed and reopened, responding with an Athena window.
  Installed app.asar matches the validated installer output byte-for-byte.
  Local Stream Deck bridge is listening on 127.0.0.1:43129 and rejects
  unauthenticated requests as designed.
- Installed Stream Deck 0.1.1.0 manifest and plugin.js match the validated
  build byte-for-byte; its active runtime started after that build was
  installed. Existing pairing, buttons, profiles and custom icons preserved.
- Corrected persisted authority/weight metadata for all 684 official
  Microsoft/GitHub articles, including the Azure YouTube feed. Re-scored a
  bounded set of 85 official items: recently auto-shelved content plus the
  already-restored Agent Lightning article, using the new editorial brief. Six rate-limited
  assessments were retried sequentially and all completed.
- Returned 43 qualifying automatically shelved items to to-review, including
  three videos. Persisted verification confirms all 43 remain in that queue;
  manual filing and concurrent workflow changes were protected. Lower-value
  Archive recommendations were not indiscriminately restored. Agent Lightning
  remains in to-review with a new 93% rating.
- Physical Prompter playback and on-device button presses were not performed.
  No display was automatically selected on the user's behalf.

**Section 7: Validation proof (2026-10-21, coordinated fixes release):**
- User explicitly requested deployment of ALL pending code and fixes everywhere
  needed, including hosted frontend/backend and local Desktop/Stream Deck.
- Existing production resources and authentication unchanged. No infrastructure,
  schema, dependencies or secrets added. AZCLI image-only and SWA recipes apply;
  infrastructure validation/provisioning is not applicable.
- Fetched origin and merged origin/main: already up to date at 9217886.
  Git reported a shared packed-refs lock during housekeeping; no lock was
  removed and normal source operations remain scoped to this worktree.
- Both application typechecks and production builds passed. Frontend lint
  non-regression passed. Focused backend tests 38/38 and frontend tests 16/16
  passed. Desktop Elgato tests 5/5 passed, including failed-wake continuation.
  Real Windows execution-state wake call succeeded.
- Desktop 0.1.7 installer built. Stream Deck 0.1.1 runtime test, validation
  and packaging passed. Existing pairing, profiles and user data must be kept.
- Backend v223 is current; next image v224. Deploy matching frontend dist,
  verify SHA-256 on both production domains and healthy backend revision.
- Release includes direct presentation, saved settings, scrollbar and opacity,
  clipboard/spelling fixes, reviewed contacts, stop-speech-to-send, Mural
  layout/invitations, Microsoft/GitHub-first ranking and removal of age-only
  automatic shelving. Backfill source authority and re-evaluate recent
  automatically shelved Microsoft/GitHub items without overriding user filing.

**Deployment result (2026-10-21 15:58 BST, Daily Insights importer):**
- Source 9a8f70d pushed to feature branch and main. ACR run ca71 built
  kh-prod-api:v223, digest
  sha256:0a7b33c15522f980c5f2be837db8cee4ac7f4993640b0ad92c28c43a013f659c.
- kh-prod-api-vnet--0000220 is Healthy / RunningAtMaxScale with 100% traffic.
  Startup logs confirm completed migrations, warm database pool and HTTP 200
  responses from the desktop's /daily-insights capture requests.
- Today's real report was captured using the existing transactional service:
  9 tasks created, 0 updated, 0 preserved, 12 meetings, 6 review warnings.
  Database verification confirms all 9 task identities exist and all 9 tasks
  have Inbox status. A repeat capture returned unchanged without duplicates.
- Only the Daily Insights backend fix was deployed. Other local Mural,
  clipboard, contacts, frontend and desktop changes remain outside this release.

**Section 7: Validation proof (2026-10-21, Daily Insights importer):**
- User explicitly authorised production deployment and requested tolerance
  for nondeterministic M365 Copilot Markdown output.
- Scope: existing backend application only, dailyInsightsParser.ts and its
  focused regression tests. No frontend, desktop, infrastructure, dependencies,
  environment, secret, schema or RBAC changes are part of this deployment.
- Fetched origin and merged origin/main: already up to date.
- Both applications passed `npx tsc --noEmit`. Backend `npm run build`
  passed. Daily Insights tests passed 7/7, including equivalent Markdown
  formats, reordered task tables, strict dates, dedupe and user-edit protection.
- Azure CLI confirmed Alliance Tenant Reporting
  (c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28), existing kh-prod-api-vnet,
  registry cad79107555facr, currently deployed image v222.
  Azure MCP returned no subscriptions; CLI confirmed live access.
- Existing AZCLI image-only recipe: build v223 from synced GitHub main,
  update existing Container App, verify healthy revision and startup logs.
  Bicep, what-if and provisioning checks are inapplicable: no infrastructure
  is changed. Existing registry secret authentication is preserved.
- Retry today's report through the existing transactional capture service,
  then verify persisted report receipt and Inbox tasks. No server startup
  or manual migration is needed for the retry.

**Deployment result (2026-10-21, Elgato frontend release):**
- Source 1693eea pushed to the feature branch and main. SWA CLI 2.0.10
  successfully deployed the validated frontend to kh-prod-web production.
- Both public domains serve /present with HTTP 200. Entry
  /assets/index-DtS6pABP.js and /assets/Presenter-D3zY9wU0.js match the local
  build byte-for-byte by SHA-256 on both domains.
- Backend and infrastructure unchanged. No desktop release was published.
  Install the local Desktop 0.1.5 EXE and Stream Deck plugin, restart Athena,
  then enable/copy the pairing key in Presentation and Stream Deck.
  Physical Prompter orientation and Stream Deck button trial remain unverified.

**Section 7: Validation proof (2026-10-21, Elgato frontend release):**
- User explicitly requested deployment after local Elgato implementation.
  Scope is the existing kh-prod-web Static Web App only. No backend,
  infrastructure, identity, RBAC, secrets or environment changes.
- Fetched origin and merged origin/main; already up to date at 6f8412e.
  Frontend and backend `npx tsc --noEmit` passed.
- Frontend `npm run test:isolated` passed: 122 core tests plus 6 and 3
  bundled UI tests. `npm run build` passed. `git diff --check` passed.
- Azure CLI authenticated target: Alliance Tenant Reporting,
  c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28. Live lookup confirmed kh-prod-web,
  West Europe, nice-mud-0f780fb03.7.azurestaticapps.net.
  Azure MCP returned no subscriptions; CLI independently confirmed access.
- Subscription confirmation was requested; user unavailable. Proceed with
  their explicit deploy instruction and the established production target.
- Recipe: existing AZCLI/SWA application deployment. Infrastructure
  compilation, what-if, Docker, provisioning and RBAC changes are not
  applicable. Existing authentication and hosting configuration are preserved.
- Deploy the validated dist directory using the existing SWA deployment
  token held only in the shell. Verify public assets against local hashes.
  Desktop installer/plugin installation and physical hardware trial remain
  separate; no desktop release publication is included.

**Deployment result (2026-10-20 17:14 BST, Mural integration):**
- Source `297730a` pushed to the feature branch and main. ACR run `ca6x`
  built v220 successfully from `#main:knowledge-hub-backend`; digest
  `sha256:0614bd5bf171f68bd86b63f6684b9ed31f581ade40133d15f8db961515cea224`.
- New revision `kh-prod-api-vnet--0000217` is Healthy / RunningAtMaxScale,
  provisioning Succeeded, and receives 100% of traffic. v219 is no longer
  active. Application logs show normal authenticated reads and successful
  Daily Insights requests after deployment.
- Matching Static Web Apps production deployment succeeded. Both public
  domains return HTTP 200 and serve `/assets/index-CA1Tp849.js`, SHA-256
  `b1ba54f138ce1ea0fc96729239b0d8c5f26660dedc9a0d6cc669d376f31a25be`,
  identical to the validated local build. The registered callback path
  serves the SPA with HTTP 200 on both domains.
- Existing registry identity None/secret authentication is unchanged; live
  registry scope role lookup returned no assignments. No Azure resources,
  secrets, environment variables, migrations or dependencies were added.
- Production browser reaches the Microsoft sign-in gate. User must sign in,
  enter the Mural client secret in Sources / Integrations, and consent before
  the real-account export can be verified. No private diagram or credentials
  were sent to Mural during implementation/testing.
- Isolated preview server stopped. No desktop installer release.

**Section 7: Validation proof (2026-10-20 17:05 BST, Mural integration):**
- Release implementation `ee14536`; fetched origin and merged origin/main:
  already up to date. Both applications passed `npx tsc --noEmit` and
  `npm run build` after sync. Final targeted Mural tests: 7/7 passed; full
  isolated suites previously passed 206 backend and 122 frontend tests.
  Browser fixture typecheck passed with strict settings.
- Chromium Mural checks passed at 1440, 768 and 390px: real PNG rendering,
  explicit image-only disclosure, chosen destination/result links, no
  automatic retries, errors, disconnected guards, masked/cleared credentials
  and no horizontal page overflow. New backend lint is clean.
- Azure CLI 2.77.0 is authenticated to the established Alliance Tenant
  Reporting subscription. Existing resource group and `kh-prod-env-vnet`
  are Succeeded. Existing backend is v219, identity None, secret-based ACR
  auth preserved. Frontend hostname/West Europe location confirmed.
- v220 tag does not exist. Dockerfile and package-lock.json confirmed.
  ACR remote build must succeed before revision update; it compiles the
  production image from pushed main. No local production database was used.
- No infrastructure/identity/RBAC/dependency/migration/environment changes:
  Bicep compilation, template validation, what-if, policy mutation,
  provisioning and managed-identity AcrPull propagation are not applicable.
- Azure MCP resource lookup failed with a credential tenant mismatch;
  authenticated Azure CLI independently confirmed the correct target.
  User unavailable for redundant target confirmation; continue under their
  explicit request to add the integration and deploy existing production.
- Rollback: backend v219 plus its matching frontend. Existing exported images
  are additive and no user board content is removed. Real-account OAuth and
  export verification requires the user's secret/consent after deployment.

**Mural integration release (2026-10-20):**
- Add Mural credential setup and OAuth connection to existing Sources / Integrations.
- Implement the registered `/integrations/mural/callback` route with secure
  server-side credential/token storage, state validation and refresh handling.
- Add explicit one-way PNG image export to a user-entered Mural board URL.
  Preserve existing full rendering, annotations and icons; label it as a
  single image, not editable shapes. Existing draw.io export remains unchanged.
  Native attached connectors are not documented in the public API, so native
  editable export is deferred rather than silently losing connectors.
- Reuse existing production resources and AZCLI/SWA deployment recipe.
  No new infrastructure is planned. Confirm implementation scope after inspecting
  current integration/export patterns and Mural object support.
- User explicitly requested implementation/deployment; unavailable for the
  format clarification. Proceed with the bounded image-only option, clearly
  disclosed at export time. No external writes until the user clicks export.
- Reuse Alliance Tenant Reporting (`c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28`),
  UK South backend and West Europe frontend. No region/provisioning changes.
- Run isolated regression checks, both application typechecks/builds, then
  azure-validate and azure-deploy before publishing to the established targets.
- Implemented encrypted, write-only setup, authenticated callback, S256 PKCE,
  expiring user-bound one-use state, serialised token refresh and explicit
  PNG image export. No migrations or dependencies.
- 206 backend isolated tests and 122 frontend isolated tests passed. Targeted
  Mural browser checks passed at 1440, 768 and 390 pixels, including actual
  PNG rendering/upload dispatch, no silent retries, disconnected guards,
  error feedback, masked/cleared secrets and no horizontal overflow.
- Both app typechecks/builds passed during implementation; repeat after
  pre-deploy main sync. New backend files are lint clean; four existing
  diagram frontend lint findings are unchanged.

**Current approved release (2026-10-20 13:39 BST, intelligence usability):**
User explicitly requested deployment of `923dcd6`, including embedded Athena
action alignment `030869f`. Reuse existing production targets: backend
`kh-prod-api-vnet` in UK South and frontend `kh-prod-web` in West Europe,
resource group `rg-knowledge-hub-prod`, subscription Alliance Tenant Reporting
(`c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28`). Existing application-only AZCLI/SWA
recipe; backend v218 advances to unused v219. No migrations, dependencies,
provisioning, identity, registry credential, RBAC or environment changes.
Rollback to v218 and its matching frontend bundle. No desktop release.

**Section 7: Validation proof (2026-10-20, intelligence usability):**
- Fetched origin and merged origin/main: already up to date at `923dcd6`.
- Both applications passed `npx tsc --noEmit` and `npm run build` after sync.
- Matching source passed 199 backend tests and 122 frontend tests, frontend
  fixture type checks and lint non-regression. Isolated watchlist checks passed
  saved-history compatibility, five relevance states, citation navigation,
  actual scroll-owner stickiness, 70/30 columns, 72ch measure and 768/390px
  container stacking. Project picker regressions passed.
- Azure CLI confirmed the subscription, healthy existing resource group and
  Container Apps environment, backend v218 with identity None and existing
  secret-based registry authentication, and existing Static Web App hostname.
- Dockerfile and lockfile verified. ACR remote build compiles and validates the
  container before any revision update. v219 does not already exist.
- No infrastructure changes: Bicep compilation, template validation, what-if,
  provisioning, policy changes and new role grants are not applicable.
  Managed-identity AcrPull propagation gate is not applicable to this app.
- User unavailable for redundant target confirmation; proceed solely with the
  explicitly requested existing production targets in the repository runbook.

**Deployment result (2026-10-20, intelligence usability):**
Release source `f4451f0` was pushed to the feature branch and main. ACR run
`ca6w` successfully built v219 from `#main:knowledge-hub-backend`, digest
`sha256:437e64d6504934b2589e4f76f59fcec2e3c6f079f5b0b7196c65b0bcb93ea231`.
Revision `kh-prod-api-vnet--0000216` is Healthy / RunningAtMaxScale with 100%
traffic and provisioning Succeeded. Startup completed migrations, warmed 8/8
connections, and confirmed all 124 notes already indexed. No migration/config
errors appeared. Existing identity None and secret-based registry configuration
were preserved; live registry role query returned no assignments.
Static Web Apps production deployment succeeded. Both
https://athena.themicrosoftcloudblog.com and
https://nice-mud-0f780fb03.7.azurestaticapps.net returned HTTP 200 and serve
`/assets/index-yE3jyEb9.js`, SHA-256
`238e222bc8ce4b09c722987d50ec26f47dc767de3970a463d2f3c0827102b856`,
identical to the validated local frontend build. Existing saved reports were
not rewritten or manually rerun; richer analysis is produced on normal future
monitoring runs. No desktop installer was built, installed or published.

**Current approved release (2026-10-20 12:06 BST):**
User explicitly requested deployment of the current release through `8d7b3ae`.
Deploy the matching backend and frontend, including chat consistency, document
mentions, agent-ready Spec, Daily Insights processing, competitor briefing,
link relevance, restored panel hierarchy/list indentation and stable autosave.
Existing AZCLI application-only recipe; backend v217 advances to v218.
Additive migration 088 runs at backend startup. Existing resources, regions,
registry credentials, identities, RBAC, secrets and environment remain unchanged.
Desktop 0.1.4 remains a locally built installer, not silently installed or published.
Rollback uses v217 and the previous frontend; retain additive migration data.

**Validation proof (2026-10-20, current release):**
Fetched origin and merged origin/main: already up to date. Both applications
passed `npx tsc --noEmit` and `npm run build` after sync. Earlier matching-source
checks passed 197 backend tests and 122 frontend tests; isolated browser checks
covered panel typography at 1440/768/390, actual diagram autosave lifecycle,
diagram regression, note links and chat. Azure CLI confirmed subscription
`c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28` (Alliance Tenant Reporting),
existing backend v217, identity None and existing registry configuration;
Static Web App remains West Europe at its existing hostname.
Dockerfile and lockfile are present; ACR remote build compiles the container
before any revision update. No infrastructure template or policy changes:
Bicep compilation, what-if, provisioning and new RBAC grants are not applicable.
User unavailable for redundant target confirmation; proceed only with the
explicitly requested existing production target documented in the runbook.

**Deployment result (2026-10-20, current release):**
Source `09d9b83c0d7a45affdf1a9b6a9a540c15b65ee0d` was pushed to the
feature branch and main. ACR run `ca6v` built backend v218, digest
`sha256:8e64d3cc96e1e082637b20b62475cc02f4730e71aad8748672288d92d7e48e0f`.
Revision `kh-prod-api-vnet--0000215` is Healthy / RunningAtMaxScale with
100% traffic and provisioning Succeeded. Startup applied
`088_daily_insights.sql`, completed migrations, warmed 8/8 connections and
confirmed all 123 notes already indexed. Live registry-role query returned
no assignments; existing secret-based registry configuration is unchanged.
Static Web Apps production deployment succeeded. Both
https://athena.themicrosoftcloudblog.com and
https://nice-mud-0f780fb03.7.azurestaticapps.net returned HTTP 200 and serve
`/assets/index-CQtaVMu6.js` with SHA-256
`37709d9f3901d929b96aae3d97c39210dcaac201727adae30ef2b31d85664792`,
identical to the validated local production build.
Desktop installer installation/publication and a live Daily Insights import
were not performed as part of this website/backend deployment.

**Previous approval scope:** the validation and deployment result below cover production
release `c235cf8` only. Subsequent chat, Daily Insights, competitor presentation,
mention/link and Spec changes are not deployed under this approval. They require
a separate matching backend/frontend rollout, including additive migration 088.
The desktop 0.1.4 installer was built locally with publishing disabled.

**Current approved release (2026-10-20, panel alignment and CSS cleanup):**
User requested deployment of `c235cf8`. Frontend-only application update to the
existing `kh-prod-web` Static Web App in `rg-knowledge-hub-prod`, subscription
Alliance Tenant Reporting, West Europe. Existing AZCLI/SWA recipe; no resource
provisioning, backend image, migrations, roles, identity or secrets change.
Rollback by redeploying the previous frontend build.

**Validation proof (2026-10-20):**
Fetched origin and merged origin/main (already up to date). Both applications
passed `npx tsc --noEmit`; frontend `npm run build` passed. The completed release
passed 22 browser modes (two screenshot timeouts passed on rerun) and 114 frontend
unit tests. `az account show` confirmed the existing production subscription;
`az staticwebapp show` confirmed the existing West Europe app and default host.
Infrastructure compilation, what-if, Docker build and RBAC changes are not
applicable to this frontend-only static asset release.

**Deployment result (2026-10-20, panel alignment and CSS cleanup):**
Pushed `c235cf8` to the feature branch and main. Static Web Apps production
deployment succeeded. Both https://athena.themicrosoftcloudblog.com and
https://nice-mud-0f780fb03.7.azurestaticapps.net serve
`/assets/index-CuFFl9Tu.js`, with SHA-256 identical to the locally validated
build. Backend image and all infrastructure remain unchanged.

**Current approved release (2026-10-19 14:58 BST, People and dark context menu):**
User explicitly requested deployment of the completed branch through `e733777`.
Deploy the existing backend as v215 (currently v214) and the matching website.
Includes the Tools People page, person mentions, 40 seeded contacts, and the
dark spelling/edit context menu fixes. Startup migrations 085/086 add the people
table, person note links, and idempotent contact data. No infrastructure,
identity, RBAC, secret, subscription or location changes. Existing AZCLI
application-only recipe applies; do not provision or recreate resources.
Rollback to backend v214 and its matching frontend bundle; retain additive
people data rather than deleting production contacts.

**Deployment result (2026-10-19 15:10 BST, People and dark context menu):**
Release `e733777` was pushed to the feature branch and `main`. ACR build `ca6s`
built v215, digest
`sha256:ebb5f06524771b4f8c871923c7286ab7bbeb6871ef74b19e02e0687c6cf19132`.
Revision `kh-prod-api-vnet--0000212` is Healthy / RunningAtMaxScale with 100%
traffic. Startup applied migrations 085/086, completed successfully, and warmed
8/8 database connections. A read-only production query confirmed both migrations
and 40 people with 43 email addresses. API `/health` and `/ready` returned HTTP
200 with `ok` and `ready`. The matching Static Web App production deployment
succeeded; both the custom domain and default domain serve
`/assets/index-DwYbP0z2.js` with SHA-256 identical to the local build. Live
registry role query returned no assignments; the existing secret-based registry
configuration and None identity were unchanged. Existing dependency audit
baseline remains 36 findings (including 1 critical) during the build; no backend
dependency changes were included.

**Current approved release (2026-10-19, Athena chat discovery):** Deploy
branch commits `26e76fa`, `5c77719`, and `37cb21a` to the existing production
Container App and Static Web App. Backend v213 advances to v214. The release
adds automatic retrieval of relevant saved Athena chats, synchronizes stale
note-index project/tag metadata, avoids false Think-note creation intent, and
includes the already-committed project picker and right-click fixes. No schema
migration, infrastructure, identity, role, secret, or dependency changes.
Roll back the backend to v213 and redeploy the prior frontend bundle if
verification fails.

**Deployment result (2026-10-19, Athena chat discovery):** Commits
`26e76fa`, `5c77719`, and `37cb21a` were pushed to the feature branch and
`main` at `0fc8733398997b13651f05c43c9be6f258e0c89e`. ACR build `ca6r`
successfully built `kh-prod-api:v214`, digest
`sha256:2026029ddb04ea88385fed5488cc3fc7fd02744e2b72bbd4634f1548a769eb70`.
Revision `kh-prod-api-vnet--0000211` is Healthy / RunningAtMaxScale with 100%
traffic. Startup completed migrations, warmed 8/8 database connections, and
reindexed 73/118 note bodies with zero failures. The frontend deployment
succeeded; the custom domain loaded Athena's Microsoft sign-in gate and served
`/assets/index-Bp8cUGax.js`, matching the local build. The existing app identity
is `None`; no ACR role assignments or role changes were required. ACR reported
the existing dependency-audit baseline (36 findings, including 1 critical) and
Node 20 engine warnings; no dependency manifests changed.

**Previously deployed release (2026-10-19, Decision Gate shape):** Deploy
`de69b43` from `main` to the existing production Container App and Static Web
App. Backend v212 advances to v213; the frontend adds the red diamond Decision
Gate to the AI-flow palette, key and step-type picker. No migrations,
infrastructure, identity, role or secret changes. Rollback backend to v212
and redeploy the previous frontend bundle.

**Deployment result (2026-10-19):** ACR build `ca6q` built
`kh-prod-api:v213` from `main` commit `de69b430fe95144026a5ad80849a11605205a468`,
digest `sha256:edb02c5cb6f8d61293a1dd2e825ee22a02cf0fc6625f36fd120b8629005ffb0d`.
Revision `kh-prod-api-vnet--0000210` is Healthy / RunningAtMaxScale with 100%
traffic; startup migration completed and 8/8 database connections are ready.
The Static Web App deployment succeeded. Both production domains serve
`/assets/index-DJTk6Gj7.js`, matching the local build.

**Validation:** Both apps passed `npx tsc --noEmit` and production builds.
Backend isolated tests passed 156/156; frontend isolated tests passed 95/95
and 6/6. No infrastructure, role, secret or dependency changes.

**Previous approved release (2026-10-19, past-chat discovery and muted links):**
Deploy commits `6180cc2`, `224b0fb` and `7f7d413`. Backend v211 advances to
v212 (chat sidebar shows Think/mobile chats, server-side chat search, Athena
`search_past_chats` / `read_past_chat` tools); frontend adds muted note-link
styling. No migrations, infrastructure, identity, role or secret changes.
Rollback backend to v211 and redeploy the previous frontend bundle. User
explicitly requested deployment. Validation: backend and web `tsc --noEmit`
pass, backend isolated tests 156/156, frontend 98/98, web build succeeded,
read-only production probes confirmed the target chats rank first.

**Deployment result (2026-10-19):** Pushed to the feature branch and `main`
(`7f7d413`). ACR build of `kh-prod-api:v212` from `#main` succeeded. Revision
`kh-prod-api-vnet--0000209` is Healthy / RunningAtMaxScale and startup logs
show clean sync runs. Frontend deployed to `kh-prod-web` production.

**Previous approved release (2026-10-19, project and content-type organization):**
Deploy commits `1227966` and `2dd4d1d` from this worktree. Backend v210 advances
to v211; deploy the matching frontend to the existing Static Web App. The
additive startup migration 084 organizes projects under IBM, Nelfin and Personal.
Independent Ventures projects are explicitly mapped to Personal; migration
backs up the affected project/tag/junction tables and preserves references to
the retired group. No infrastructure, subscription, identity, role or secret
changes. Rollback backend to v210 and redeploy the previous frontend bundle.
User explicitly requested deployment.

**Deployment result (2026-10-19):** Commits `1227966` and `2dd4d1d` pushed to
the feature branch and `main`. ACR build `ca6n` succeeded for
`kh-prod-api:v211`, digest
`sha256:febfd055fc6165089ae906c2112a96b0f4c37b9a18e615c6a59a78a768be50af`,
from commit `2dd4d1d`. Revision `kh-prod-api-vnet--0000208` is Healthy /
RunningAtMaxScale. Startup applied `084_project_parents.sql`, completed
migrations, and warmed all 8/8 database connections. The frontend deployment
succeeded; production and local build both serve `index-BCW3R0uy.js`. Custom
domain verification reached Athena's expected Microsoft sign-in gate. The ACR
build reported 36 dependency audit findings (1 critical, 21 high), consistent
with the existing dependency baseline; no dependency changes were made.

**Approved release (2026-10-18, watchlists and wiki links):** Deploy the
completed watchlist report, project implications column, reliable draft saving,
wiki links/backlinks and project previews from this worktree. Existing AZCLI
application-only recipe; no infrastructure, identity, role, secret or environment
changes. Existing production v209 advances to v210. Rollback backend: v209.
User explicitly requested push and deployment; no further browser launches.
Additive migrations 082/083 use the existing startup runner.

**Deployment result (2026-10-18 22:34 BST):** Release `8c217ae` pushed to
the feature branch and main. ACR run `ca6m` built v210 successfully from that
commit. Revision `kh-prod-api-vnet--0000207` is Healthy / RunningAtMaxScale
with 100% traffic. Startup migrations completed, 8/8 DB connections are ready,
and note reindex completed with zero failures. Matching SWA production deploy
succeeded; custom-domain bundle `index-CFHuypi-.js` SHA-256 matches the local
release. No browser was launched for deployment verification.

**Current approved release (2026-10-18, use cases on the Plan Board):** User
explicitly requested production deployment without a further permission prompt.
The release includes the Plan Board cards for active use cases, alongside the
existing Use cases UI and backend API. Candidate cases appear in Backlog;
Refining, Spec ready and Handed off cases appear in In Progress. Closed cases
are omitted. Deploy the backend from `main` as v208 (current production image
v207) and publish the matching frontend to the existing Static Web App. The
existing backend startup runner applies additive migration 081 if needed. No
infrastructure, RBAC, secrets, subscription or location changes. Rollback:
backend v207 and the pre-release Static Web App bundle.

**Deployment result (2026-10-18, use cases on the Plan Board):** ACR run `ca6j`
built `kh-prod-api:v208` from commit `9b87c6c`, digest
`sha256:f1d2a4b8d274eebc442266ed8d0eefd54fd094e90d62ca652be4d9bc3cd06777`.
Revision `kh-prod-api-vnet--0000205` is Healthy / RunningAtMaxScale with 100%
traffic. Startup reported migration completion and 8/8 database connections
ready. The matching Static Web Apps deployment succeeded at
`https://nice-mud-0f780fb03.7.azurestaticapps.net`; the custom domain serves
bundle `index-Dl2yXHoj.js`. Production browser verification reached the
Microsoft sign-in gate, so the authenticated Board was not exercised in
production; the same Board/card/detail flow was verified locally. ACR's
`npm ci` reported dependency audit findings (36 total, including 1 critical);
no dependency remediation was included in this release.

**Current approved release (2026-10-16, Discovery Bluesky):** User explicitly
requested deployment of Discovery quick-social posting (`f916e69`, `a0ea525`),
including pending double-headed diagram arrows (`81eeaa9`). Reuse the existing
Alliance Tenant Reporting ACA/ACR/SWA targets. Backend v205 advances to v206;
deploy the matching local frontend. Add only `bluesky-app-password` as an ACA
secret and `BLUESKY_APP_PASSWORD=secretref:bluesky-app-password`. Existing CMS,
blog and Athena storage configuration remains unchanged. No infrastructure,
RBAC or schema changes. Do not publish a live Bluesky post during verification.
Rollback: backend v205 and frontend source `c190ae7`.

**Deployment result (2026-10-16, Discovery Bluesky):** ACR run `ca6g`
built v206 from `main` release `cfaad72`, digest
`sha256:cc10a8d9142ae45d090ba70d0a9929ff2fe7fd90408a02977fbc713a9b3a90a5`.
Revision `kh-prod-api-vnet--0000203` is Healthy / RunningAtMaxScale with
100% traffic; startup migrations completed and 8/8 DB connections are ready.
Bluesky uses `BLUESKY_APP_PASSWORD=secretref:bluesky-app-password`.
Authentication verified as `richardihogan.bsky.social` without publishing.
SWA production deployed successfully; both production domains return HTTP 200,
serve `/assets/index-DrLFqa7G.js` and the byte-matching Bluesky action chunk
`appBootstrap-BOioxC6F.js`. Athena storage remains `khprodr6mgdnys`;
no blog integration or storage configuration was changed.

**Current approved release (2026-10-16, Athena storage migration):** User
explicitly requested immediate migration of Athena data only to the current
subscription and prohibited touching blog content. Target:
`khprodr6mgdnys`, `rg-knowledge-hub-prod`, UK South, subscription
`Alliance Tenant Reporting` (`c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28`),
tenant `740bc3aa-5daf-42f6-939a-b2d007a60d26`.
Only `kb-documents`, `kb-images` and `chat-screens` are copied and SHA-256
verified. New `ATHENA_STORAGE_ACCOUNT_NAME` / `ATHENA_STORAGE_ACCOUNT_KEY`
configuration isolates Athena from unchanged CMS credentials. Source objects,
source keys, `blogcontent`, `images`, blog posts and CMS configuration must not
be changed or deleted. Existing backend v204 advances to v205 using the existing
Azure CLI / ACR deployment runbook; no infrastructure or RBAC changes and no
frontend changes. After cutover, repeat the Athena-only copy for any final
writes, transactionally replace only verified Athena URLs in Athena records,
then update only user-upload search citations. Verify private destination
containers, healthy revision, SHA-256 equality and no old Athena URL references.
Existing signed-link lifetimes are preserved; this is not a general SAS policy
change. Originals remain available for recovery; never rotate their keys.

**Deployment result (2026-10-16, Athena storage migration):** ACR run `ca6f`
built backend v205 from `95e6e22`. Revision `kh-prod-api-vnet--0000202` is
Healthy / RunningAtMaxScale and receives 100% of traffic. Dedicated Athena
environment variables now select `khprodr6mgdnys` and secret reference
`athena-storage-account-key`. CMS/blog environment values and secret references
match the previous v204 revision (comparison normalizes absent/null fields).
No source key, source blob or blog configuration was changed by this migration.
All 302 Athena blobs (552,660,570 bytes) were copied and SHA-256 verified:
119 documents, 160 images and 23 chat screens. The transactional URL migration
replaced 222 distinct Athena URLs, including embedded note images, note history
and chat context, and updated 67 user-upload Search citations. Final verification
confirmed 222 signed file URLs work, anonymous reads return 401, and no old
Athena-container URL references remain in the database or user-upload search
citations. Existing blog paths are deliberately unchanged. Original Athena
copies remain untouched in the source account for recovery; deletion/purge has
not been performed. No frontend deployment or installer update is needed.

**Independent re-verification (2026-10-16):** Re-ran the read-only
`scripts/migrate-athena-storage.mjs verify` against production (secrets from ACA
secret refs, not printed). Exit 0. kb-documents 119/119 (433,818,139 bytes),
kb-images 160/160 (112,339,219 bytes), chat-screens 23/23 (6,503,212 bytes), all
SHA-256 matched; 222 signed downloads OK; anonymous access denied; 0 old search
citations; 0 old Athena DB references; `cmsChanged=false`. Backend
`tsc --noEmit` clean; storage tests 3/3 + 3/3 pass. Live revision
`kh-prod-api-vnet--0000202` (v205) Healthy at 100% traffic.

**Current approved release (2026-10-16):** User requested deployment of the
standard diagram arrow shape, matching 380 px Properties/Athena panels, an IBM
Carbon colour subset, and bold/italic shape and connector descriptions. The
backend validation adds support for saving arrows. Production baseline is
`kh-prod-api:v203`; next backend image is v204. Existing targets and subscription
are unchanged: backend in UK South, SWA in West Europe, subscription Alliance
Tenant Reporting. No provisioning, certificates, secrets, role assignments or
authentication permissions are being changed. Rollback backend:
`cad79107555facr.azurecr.io/kh-prod-api:v203`; frontend source baseline:
`d0ed66c`.

**Deployment result (2026-10-16, diagram enhancements):** commit `c190ae7`
pushed to the feature branch and `main`. ACR run `ca6e` built `kh-prod-api:v204`
from `main`; revision `kh-prod-api-vnet--0000201` is Healthy /
RunningAtMaxScale with 100% traffic. SWA production serves
`/assets/index-GieYvbfW.js` on both `https://athena.themicrosoftcloudblog.com/`
and `https://nice-mud-0f780fb03.7.azurestaticapps.net/`. Note: commits must use
the installed Git for Windows (`C:\Program Files\Git`) so the Vault Radar hook
resolves coreutils `timeout`; the bundled session Git resolves Windows
`TIMEOUT.EXE` and the hook fails as "stale worktree metadata".

**Deployment result (2026-10-16):** ACR run `ca6d` built and pushed
`kh-prod-api:v203` from `main` commit `d0ed66c14fb1ec3de96720f9b6baca38f2fa2355`,
digest `sha256:1e132b3b173191660a3a89bbfec6de2c0dcc02b98c8c3b31249f3754b80ea55f`.
Container App revision `kh-prod-api-vnet--0000200` is Healthy,
RunningAtMaxScale, and receives 100% of traffic. Static Web Apps CLI confirmed
the production deployment to `https://nice-mud-0f780fb03.7.azurestaticapps.net`.

**Deployment result (2026-10-16):** ACR run `ca6c` succeeded for v202
(digest `sha256:0162d50a48c50c06650841b7adb158d77383cd769cd0f3cd8a39a1f60de4f74a`).
Revision `kh-prod-api-vnet--0000199` is Healthy / RunningAtMaxScale with 100%
traffic. Startup logs report migration complete and 8/8 DB connections ready.
SWA production deployment succeeded; the custom domain returns HTTP 200 and
serves `/assets/index-CJ1xhpKh.js`, matching the locally validated build.
The existing unsigned Windows installer is available in
`athena-desktop\release\Athena Setup 0.1.0.exe`. No certificate or permission
changes were made during this deployment.

**Live baseline:** Backend `kh-prod-api:v200` was running on revision
`kh-prod-api-vnet--0000197` in the existing production subscription when this
release was validated. No infrastructure, secret or role changes are planned.

**Validated release:** commits `c052399` and `f6cd8e5` are pushed to the feature
branch and `main`. Backend image `kh-prod-api:v201` has been built from `main`
and is ready for deployment. The release adds discovery sources and scoring
updates, changes podcast preparation to a conversational response, and includes
migration 078. Rollback: `cad79107555facr.azurecr.io/kh-prod-api:v200`.

**Deployment:** AI flow / governance diagram type (`d5e6ea0`) deployed
2026-10-15. Backend `kh-prod-api:v198` and matching frontend are live on the
existing production resources. No infrastructure, database schema, migration,
subscription, region, secret or role changes. Rollback: backend v197 and the
prior production frontend bundle.

**Deployment:** Podcast preparation timeout fix. Existing ACA and ACR; frontend
unchanged.

## 1. Scope

Approved 2026-10-15 at 10:39 BST: deploy podcast timeout fix `ed56adb`.
Only the background final brief request gets a six-minute timeout; interactive
requests retain their existing limits. Existing backend v196 advances to v197
after a successful ACR build. No frontend, migration, infrastructure, role,
secret, environment or authentication changes. Rollback: backend v196.

Approved 2026-10-14 at 20:15 BST: deploy nested diagram navigation `dbd3b11`
and recoverable canvas deletion `2a1f9bc`. Backend v194 advances to v195 after
ACR build success, then the matching frontend is published. Additive migration
076 adds `canvases.deleted_at` and filtered indexes through the existing startup
migration runner. Existing canvases remain active; future deletes become
recoverable until an explicit permanent delete. No infrastructure, role, secret,
environment or authentication changes. Rollback: backend v194 and frontend
bundle `index-CFjIrh7X.js`; additive nullable column and indexes remain.

Approved 2026-10-14 at 19:19 BST: deploy application `947d57b` to the existing
production Static Web App. Automatic curved bridges on connector and standalone
line crossings, matching SVG/PNG rendering and native draw.io arc configuration.
No backend, migration, infrastructure, environment, role or secret changes.
Rollback frontend: source `cdca5cb`, bundle `index-DyU2VQXo.js`.

Approved 2026-10-14 at 16:56 BST: deploy application `c00598e` with pending
fixes `2390775` and `3a32810`. Backend v193 advances to v194 after ACR build
success, then matching frontend. Additive migration 075 creates drill-down
associations through the existing startup runner; Dockerfile explicitly copies
all source migrations into dist. No infrastructure, role, secret or environment
changes. Rollback: backend v193 and frontend source `f527559`; migration remains.

Correction 2026-10-14 following the user's report that dragging Sparks did not
work: make the whole loose card draggable, not just the grip. Preserve control
clicks, editing and the accessible chooser. Publish the corrected frontend as
remediation of the 12:13 deployment. No backend, infrastructure, migrations,
configuration, secrets or role changes. Rollback frontend source `18905c5`.

Approved 2026-10-14 at 12:13 BST: deploy application `fb996e8` including
pending Think pop-out `dda9779`. Read article arguments before Spark creation
and grouping, preserve later reasoning in chat page reads, and enable loose
Spark drag-to-theme. Existing production resources only; no new infrastructure,
migrations, roles, secrets or environment changes. Backend v192 advances to
v193 after ACR build success; matching frontend follows.
Rollback: backend v192 and frontend source `321e9f6`.

Approved 2026-10-14: merge, push and deploy the Discover Spark change and pending
application commit `84508f2`. Spark uses the article title/synopsis, source and tags
without a writing input. Include additive migration 074 (`day_checkins`,
`tasks.reschedule_count`) via the existing startup migration runner. Backend
advances from v191 to v192 after a successful ACR build; matching frontend follows.
Existing subscription Alliance Tenant Reporting and existing resource locations
are retained. No infrastructure, role, secret or environment changes.
Rollback: backend v191 and frontend source `2f1af56`; additive migration remains.

Approved 2026-10-12 at 11:53 BST: deploy application `9e29ec9`.
Separate rank from metadata/title flow; keep mobile titles full-width and
increase title size slightly. Existing SWA only; backend/ranking unchanged.
No infrastructure, environment, secret, role or migration changes.
Remote main `f7c1dda` integrated. Rollback application `75a5fbc`.

Approved 2026-10-12 at 11:44 BST: deploy application `75a5fbc`.
Discovery shows its actual weighted rank with a larger number and readable label.
Ranking logic is unchanged. Existing production SWA only; no backend,
infrastructure, environment, secrets, RBAC or migration changes.
Remote main `0ccbe9f` integrated. Rollback frontend application `2f49519`.

Approved 2026-10-12 at 11:17 BST: deploy application `2f49519`. Divider width
comes from diagram content bounds, not viewport or notes columns, in canvas
and exports. Existing production SWA only; no backend/configuration changes.
Remote main `7d55877` integrated. Rollback frontend application `f27219c`.

Approved 2026-10-12 at 11:09 BST: deploy `f27219c` to the existing production
Static Web App. Subtle dashed divider above Notes on canvas and exports.
No backend, migration, infrastructure, environment, secret or role changes.
Remote main `7b58080` is integrated. Rollback frontend source `2e1af96`.

Approved 2026-10-12 at 10:26 BST: deploy current application source `2e1af96`,
including `a7713ea` (borderless footnotes) and `2e1af96` (semantic text callouts).
Remote main `47e559a` is integrated; no newer remote commits were found.
Use existing ACA/ACR/SWA resources in Alliance Tenant Reporting.
No new migrations, infrastructure, secrets, environment, permissions or auth changes.
Rollback: backend `cad79107555facr.azurecr.io/kh-prod-api:v179` and
frontend source `47e559a`. The subscription confirmation prompt returned
an instruction to proceed autonomously; retain the established production target.

User-directed correction 2026-10-10 at 09:13 BST: restore popup sign-in
and renewal instead of navigating the whole page. Preserve the early MSAL
callback bridge so the popup returns its response without bootstrapping
another sign-in. Set the returned active account, clear session expiration
only on success, share concurrent interactive requests, and keep drafts/chat
mounted. Deploy the frontend correction to the existing production SWA.
No backend, infrastructure, secret, role or environment changes.
Rollback: frontend application source `93079cd`.

Approved 2026-10-10 at 09:02 BST: redeploy the latest frontend from
`93079cd` to the existing production Static Web App. Remote main fetched
and already integrated. No backend, infrastructure, secrets, permissions
or environment changes.

Approved 2026-10-10 at 08:44 BST: frontend-only login recovery. Replace the
reauthentication popup that opened a second sign-in window with same-tab MSAL
redirect renewal. Preserve sessionStorage chat drafts and the `/signin`
callback bridge. Backend v176 remains unchanged; no infrastructure, secrets,
permissions or environment changes. Rollback: prior SWA bundle from `72d5aad`.

Approved 2026-10-09 at 22:33 BST: deploy current branch `877c4d8`
to existing production targets. Backend v176 and matching full frontend.
No new migrations, infrastructure, secrets, environment, roles or auth changes.
Rollback: backend v175 and frontend source `5225de7` (release record `863830a`).

Approved 2026-10-09 at 21:07 BST: deploy latest main `5225de7` before
implementing connector-label font controls. Backend v175 and matching frontend.
Existing resources/configuration only; no IaC, secrets, roles or auth changes.
Rollback: backend v174 and frontend source `d30a2e2`.

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

### Settings modals — 2026-10-24T12:28:57Z (Validated)

- `git fetch origin` and `git merge origin/main --no-edit` confirm current
  main at `c0723c7`; `git diff --check` passed.
- Both application `npm run typecheck` checks passed. Backend source is
  unchanged; reuse its preceding 513/513 release-suite result and v244 image.
- Frontend `npm run lint:check` passed: 23 existing violations versus a
  baseline of 41; no new lint violations.
- Frontend `npm run build` passed; entry `/assets/index-CNhs-zK4.js`.
- Frontend `npm run test:isolated` passed once: 213/213 main tests and all
  additional groups (6, 3, 2, 6 and 3). Navigation regressions cover settings
  route classification, exact background state preservation and direct links.
- Azure CLI confirms the established Alliance Tenant Reporting subscription
  and existing `kh-prod-web` in West Europe. No infrastructure, credentials,
  RBAC, schema or dependency changes. No browser was launched.
- Build/test logs: session files/settings-modals-{build,tests}.log.

### Athena conversational pacing — 2026-10-24 (Validated)

- `git fetch origin` and `git merge origin/main --no-edit` passed; main was
  current at `71d4a1e` before release. Commit `be82a8a` was pushed to the
  feature branch and main.
- Azure CLI authenticated to Alliance Tenant Reporting
  (`c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28`); production ACA is on v243 and
  the next backend image tag, v244, is unused.
- Backend `npm run typecheck`, `npm run build`, changed-source ESLint and
  `git diff --check` passed.
- Frontend `npx --no-install tsc --noEmit` and `npm run build` passed.
  The isolated frontend suite passed (208/208 in its main group; additional
  groups also passed) in the release run.
- The backend `npm run test:isolated` suite passed 513/513. Dialogue and
  focused-context regressions passed 45/45 after fixing referenced-material
  retrieval during exploratory turns.
- Dockerfile and lockfile were reviewed; the Docker build copies all numbered
  SQL migrations into the production image. Migration 098 is exact-match and
  transactional under the existing startup migration runner.
- No frontend source, dependencies, infrastructure or IAM changed. No Bicep,
  what-if, provisioning, policy or RBAC validation applies to this release.

### People and dark context menu — 2026-10-19 15:03 BST (Validated)

- `git fetch origin --quiet` and `git merge origin/main --no-edit` succeeded;
  the branch through `e733777` already includes current main `338a1c5`.
- Azure CLI authenticated in Alliance Tenant Reporting
  (`c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28`); existing resource group is
  Succeeded in uksouth. Existing ACA/registry/SWA reads succeeded.
- Backend `npx tsc --noEmit`, `npm run build`, and isolated suite succeeded:
  163/163 tests, including contact seed reruns, deduplication and alias lookups.
- Frontend `npx tsc --noEmit`, `npm run build`, and isolated suites succeeded:
  99/99 and 6/6 tests. Entry asset is `/assets/index-DwYbP0z2.js`.
- Dockerfile copies all numbered SQL migrations into the image. Remote ACR
  build must succeed before updating the running backend. No local server was
  started against the production database.
- No IaC, identity or RBAC changes: compilation, what-if and provisioning
  policy checks are not applicable to this existing-resource image/content
  update. ACA identity remains None with its existing registry secret reference;
  managed-identity AcrPull propagation does not apply.

### Athena chat discovery — 2026-10-19 12:30 BST (Validated and deployed)

- `git merge --no-edit origin/main` completed with no changes; commit
  `37cb21a` contains the retrieval fix and regression tests. It is on top of
  branch commits `26e76fa` and `5c77719`.
- Backend: `npx tsc --noEmit`, `npm run build`, and
  `npm run test:isolated` passed; 156/156 isolated tests passed.
- Frontend: `npx tsc --noEmit`, `npm run build`, and
  `npm run test:isolated` passed; isolated test groups passed 97/97 and 6/6.
- Focused frontend ESLint and `git diff --check` passed. A read-only production
  chat search ranked “Local document indexing status” first and returned the
  delegation/acceptance gate exchange.
- Production baseline confirmed as backend v213, revision
  `kh-prod-api-vnet--0000210`; Static Web App target is `kh-prod-web`
  (`nice-mud-0f780fb03.7.azurestaticapps.net`). Infrastructure and static role
  verification are not applicable; no infrastructure or RBAC files changed.
- ACR build `ca6r` produced v214 with digest
  `sha256:2026029ddb04ea88385fed5488cc3fc7fd02744e2b72bbd4634f1548a769eb70`.
  Revision `kh-prod-api-vnet--0000211` is Healthy / RunningAtMaxScale at 100%
  traffic. Startup migrations completed, 8/8 database connections are ready,
  and note reindexing completed with zero failures.
- Static Web Apps production deployment succeeded. The production custom
  domain loaded the sign-in gate and served `/assets/index-Bp8cUGax.js`, the
  same asset name as the locally validated build. Live ACR role verification
  found no role assignments; the Container App identity type is `None`.

### Decision Gate shape — 2026-10-19 (Validated and deployed)

- Commit `de69b430fe95144026a5ad80849a11605205a468` is on both the feature
  branch and `main`.
- Backend and web `npx tsc --noEmit` passed; both production builds succeeded.
- Backend isolated tests: 156/156 passed. Frontend isolated tests: 95/95 and
  6/6 passed.
- No IaC, identity, RBAC, secret or dependency changes; infrastructure and
  role validation is not applicable to this application-only release.
- ACR build `ca6q` succeeded for backend v213. Revision
  `kh-prod-api-vnet--0000210` is Healthy / RunningAtMaxScale with 100% traffic;
  startup migration completed and 8/8 database connections are ready.
- Both production domains serve the matching frontend bundle
  `/assets/index-DJTk6Gj7.js`.

### Project and content-type organization — 2026-10-19 09:30 BST (Validated)

- Azure CLI authenticated as the expected account in Alliance Tenant Reporting
  (`c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28`). Production ACA image confirmed as
  `kh-prod-api:v210`; ACR and Static Web App targets confirmed.
- Both projects: `npx tsc --noEmit` and `npm run build` passed.
- Backend `npm run test:isolated`: 156/156 passed, including migration 084 tests.
  Frontend isolated suite: 92/92 and 6/6 passed.
- `git diff --check` passed. Docker is unavailable locally; the remote ACR build
  is required to pass before the backend image is updated.
- No IaC, identity or RBAC changes; Bicep/what-if/static role validation is not
  applicable to this existing application-only release.

### Watchlists and wiki links — 2026-10-18 22:28 BST

- Fetched and merged origin/main: already up to date.
- Both applications: TypeScript no-emit and production builds passed.
- Backend isolated suite: 146/146 passed. Frontend: 84/84 plus 6/6 passed.
- Frontend lint non-regression passed. Backend new lint violations corrected;
  final non-regression check gates push.
- Azure read-only checks confirmed existing Alliance Tenant Reporting targets:
  ACA v209 in UK South, ACR Succeeded, SWA in West Europe. Existing registry
  password-secret connection retained; no managed-identity RBAC changes.
- Dockerfile and lockfile inspected; existing migration copies retained.
  Successful remote ACR build gates container image update. Infrastructure
  compilation/what-if is not applicable to this application-only update.
- Browser suite was stopped at the owner's request and is not claimed passed.

### Use cases on Plan Board — 2026-10-18 16:46 BST (Validated and deployed)

- `git fetch origin` and merge of `origin/main`: already up to date. Azure CLI
  selected `Alliance Tenant Reporting` (`c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28`);
  current backend image is `kh-prod-api:v207`. Existing ACR and production SWA
  were confirmed.
- Backend: `npx tsc --noEmit`, `npm run build`, and `npm run test:isolated`
  passed (126/126 tests).
- Frontend: `npm run typecheck`, `npm run build`, and `npm run test:isolated`
  passed (83 + 6 tests).
- Local browser verification confirmed Candidate appears in Backlog, Spec ready
  appears in In Progress, and each card opens the existing use-case detail
  panel. The temporary test use case was deleted and its absence confirmed.
- No IaC, role, secret or environment changes. `knowledge-hub-backend/Dockerfile`
  and lockfiles are unchanged; the backend image is built from the pushed `main`
  source. Migration 081 is additive and runs through the existing startup path.
- ACR run `ca6j` succeeded; v208 revision `kh-prod-api-vnet--0000205` is
  Healthy / RunningAtMaxScale with 100% traffic. Startup migration completed,
  8/8 database connections are ready, and the matching Static Web Apps deploy
  succeeded. The unauthenticated production browser reached Microsoft sign-in
  and loaded the deployed bundle; full authenticated UI validation was not
  possible in that browser session.
- ACR `npm ci` reported 36 dependency audit findings, including 1 critical;
  dependency remediation was left out of scope.

### Discovery Bluesky deployment - 2026-10-16 16:57 BST

- Fetched and merged `origin/main`: already up to date.
- Both projects: `npx tsc --noEmit` and `npm run build` passed.
- Backend Bluesky and social draft tests: 9/9 passed, no live social writes.
- Azure CLI authenticated in Alliance Tenant Reporting; existing ACA v205,
  ACR Succeeded and SWA production hostname confirmed.
- Dockerfile and committed package lock verified; successful remote ACR build
  gates the image update. Existing password-secret registry connection retained.
- No IaC, provisioning, location, policy or RBAC changes: template compilation,
  what-if and managed-identity role propagation checks are not applicable.
- Bluesky credential is read from ignored local configuration into process
  memory and stored only as an ACA secret; no credential value recorded here.

### Athena-only storage isolation — 2026-10-16 13:32 BST

- `az account show`: confirmed subscription
  `c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28` and tenant
  `740bc3aa-5daf-42f6-939a-b2d007a60d26`; target account resource ID is
  inside `rg-knowledge-hub-prod` in that subscription.
- Destination account: public blob access disabled, HTTPS-only, TLS 1.2.
  Destination keys were read into process memory only; no role changes.
- Read-only source inventory, strictly limited to Athena containers:
  `kb-documents`: 119 blobs / 433,818,139 bytes; `kb-images`: 160 /
  112,339,219 bytes; `chat-screens`: 23 / 6,503,212 bytes.
- `node --import tsx/esm scripts/migrate-athena-storage.mjs inventory`
  identified Athena-only URL references in reviewed Athena tables. CMS
  metadata contains blog paths and is excluded by the container allowlist.
- `node --import tsx/esm --test scripts/athena-storage.test.ts
  scripts/athena-storage-migration.test.mjs`: 6/6 passed, including no CMS
  credential fallback and unchanged blog/other-account URLs.
- `npx tsc --noEmit` passed in both applications. Backend `npm run build`
  passed. Dockerfile/package-lock unchanged; ACR builds the same validated
  application using the established GitHub source build.
- `git fetch origin`: no incoming changes. `git diff --check`: passed.
- Bicep/what-if/provisioning/RBAC validation not applicable: existing
  resources and registry permissions are unchanged. Only the Athena-specific
  secret and environment variables are added. Cutover remains gated on
  copying and verifying Athena blobs.

### Standard diagram enhancements — 2026-10-16

- `git fetch origin` and `git merge --ff-only origin/main`: up to date at
  `d0ed66c`; no remote changes to merge.
- Azure CLI confirmed the signed-in user is
  `Richard.i.Hogan@ibmalliance.onmicrosoft.com` in `Alliance Tenant Reporting`
  (`740bc3aa-5daf-42f6-939a-b2d007a60d26`). Existing targets confirmed:
  `kh-prod-api-vnet` on v203 / revision `kh-prod-api-vnet--0000200` with
  100% traffic, ACR `cad79107555facr`, and SWA `kh-prod-web`.
- Frontend and backend `npx tsc --noEmit`, `npm run build`: passed.
- Targeted diagram browser-fixture typecheck: passed. The broader test-fixture
  typecheck still reports existing errors in data-reliability, navigation and
  Today fixtures outside this change.
- Diagram browser appearance/save/reopen checks passed at 1440 px and 390 px:
  equal panel widths; named IBM colour selection; bold/italic formatting and
  preview; SVG/footnote formatting; persisted descriptions and no horizontal
  overflow. The general browser runner reaches an unrelated note-editor test
  failure (`useNavigate()` outside a Router) after these checks.
- Diagram geometry 32/32, draw.io 6/6, annotations 13/13, backend diagram
  validation 34/34, description/palette 6/6, and theme 3/3 passed.
- No infrastructure or RBAC changes: IaC compilation, what-if, provisioning
  and role-assignment validation are not applicable. No new permissions,
  secrets, migrations or database schema changes.

### Podcast research source mix — 2026-10-16

- `d0ed66c14fb1ec3de96720f9b6baca38f2fa2355` was the current `main` source.
- Backend and frontend `npx tsc --noEmit` and `npm run build`: passed.
- `node --import tsx/esm --test scripts/podcast-prep.test.ts`: 18 passed,
  0 failed.
- Azure CLI identity and the `Alliance Tenant Reporting` subscription were
  verified before deployment. The production baseline was backend v202.
- ACR run `ca6d` built and pushed v203 from `main`; the Container App revision
  became Healthy / RunningAtMaxScale with 100% traffic.
- Static Web Apps CLI confirmed successful production deployment. No
  infrastructure, migration, secret, role or authentication changes.

### Athena Desktop integration — 2026-10-16

- `git fetch origin; git merge --no-edit origin/main`: already up to date;
  application source `3419a9f`.
- Web `npx tsc --noEmit` and `npm run build`: passed.
- Backend `npx tsc --noEmit` and `npm run build`: passed.
- `node scripts\run-isolated-tests.mjs`: 134 passed, 0 failed.
- `node scripts\run-isolated-tests.mjs --frontend`: 63 passed, 0 failed.
- Desktop `npm test`: TypeScript build passed; 9 tests passed, 0 failed.
- Azure CLI authentication and existing target reads succeeded against the
  approved subscription; current backend is v201. Existing ACR uses a
  password-secret registry connection, so no new managed identity/RBAC gate is
  needed.
- Dockerfile and npm lockfile checked; remote ACR build will compile the exact
  pushed `main` source before any production revision is updated.
- No infrastructure/IaC changes are included: template compilation, what-if and
  provisioning policy checks are not applicable to this application-only update.
- `Get-AuthenticodeSignature` on `Athena Setup 0.1.0.exe`: `NotSigned`.

Validated 2026-10-16 for podcast/discovery release `c052399` / `f6cd8e5`:

- `git fetch origin` and `git merge --ff-only origin/main`: up to date.
- Backend and frontend `npx tsc --noEmit` and `npm run build`: passed.
- `node scripts/run-isolated-tests.mjs`: 125 passed, 0 failed.
- Azure CLI authentication and production ACA/ACR/SWA reads passed in
  `Alliance Tenant Reporting`; current backend baseline was v200 on revision
  `kh-prod-api-vnet--0000197`.
- ACR run `ca6b` successfully built and pushed `kh-prod-api:v201` from main
  commit `f6cd8e59655aeff9ee5ac6b99effeda6d0fa5ed2`, digest
  `sha256:9fdf5388f5afa928a2fec403f986a2457f52720a9fd80495f7d4ae0e1a25e3e9`.
  The Docker build copied source migrations into the image.
- Browser automation was unavailable because this host has no configured
  Chromium executable (`TODAY_BROWSER_PATH`). The full browser-fixture
  TypeScript check also reports existing type errors in unrelated
  data-reliability, navigation and Today fixtures; the production frontend
  typecheck/build and isolated regression suite passed.

Deployed 2026-10-15 for Microsoft-focused podcast preparation:

- Application `18fb98f` and validation record `c0cb258` pushed to main and
  the feature branch before the remote build.
- ACR run `ca69` succeeded from main for `kh-prod-api:v199`, digest
  `sha256:2dee8726c9cd89cc88e683fb771d3ad0557f9d24bbbe4b0c4aba6710eff1a805`.
- ACA revision `kh-prod-api-vnet--0000196` is Healthy, RunningAtMaxScale,
  the latest ready revision, and receives 100% of production traffic.
- Startup logs confirm migration completion and database pool pre-warm (8/8).
  No startup migration or configuration errors were reported.
- Frontend unchanged at `https://athena.themicrosoftcloudblog.com/`.
- Existing saved podcast briefs are unchanged; regeneration uses the new rules.

Validated 2026-10-15 for Microsoft-focused podcast preparation `18fb98f`:

- `git fetch origin` and `git merge origin/main`: already up to date.
- Backend `npx tsc --noEmit` and `npm run build`: passed.
- Frontend `npx tsc --noEmit`: passed; no frontend deployment required.
- Backend isolated suite passed 117/117 before this deployment.
- Azure CLI authentication and existing Container App reads passed in
  subscription `c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28`.
- Current image v198, ready revision `kh-prod-api-vnet--0000195`; next tag v199.
- Dockerfile and package lock verified. ACR remote build must succeed before
  switching the production image. Registry uses existing secret-based
  authentication, not managed identity; no AcrPull propagation change needed.
- No IaC, policy, role, database or configuration changes; template compilation,
  what-if and infrastructure provisioning are not applicable.

Deployed 2026-10-15 following the user's request:

- Release `d5e6ea0` and its validation record `e46de14` are on the feature
  branch and `main`.
- ACR run `ca68` succeeded from `main`: `kh-prod-api:v198`, digest
  `sha256:86c996c3bd94b3ec8a318ed85a023b56b67d9e0e2d53ee27c61b400a424cabc4`.
- ACA revision `kh-prod-api-vnet--0000195` is Healthy,
  RunningAtMaxScale and receives 100% of production traffic. Startup logs
  confirm migration completion and database pool pre-warm (8/8).
- The startup sync also reported GitLab API 401 errors for commits, merge
  requests, issues and pipelines. This did not affect readiness; investigate
  the existing GitLab connection separately if those syncs are expected.
- Static Web Apps CLI reported successful production deployment to
  `https://nice-mud-0f780fb03.7.azurestaticapps.net`. The custom-domain Think
  route loads the Athena sign-in page. Production asset
  `DiagramEditor-CjKcy2HK.js` returns HTTP 200 and has SHA-256
  `604d397d68dfd9499966b63982eb50a5d87a7c7d2b06d0be31e8ab80688a924a`,
  matching the local production build exactly.

Validated 2026-10-15 for AI flow / governance diagram release `d5e6ea0`:

- `git fetch origin` and `git merge origin/main`: up to date. Release commit
  pushed to `richardichogan-link-think-chat-projects` and `main`.
- Backend `npx tsc --noEmit` and `npm run build` passed; isolated suite passed
  116/116.
- Frontend `npx tsc --noEmit` and `npm run build` passed; isolated suite passed
  63/63; lint non-regression passed (25 existing violations, baseline 41).
- AI flow browser checks and diagram theme, properties, drill-down and line-jump
  browser checks passed at 1440px and 390px.
- No database migration or infrastructure change is included. Existing
  Container App, ACR and Static Web App are reused.
- Azure CLI confirms the existing `Alliance Tenant Reporting` subscription,
  Container Apps in UK South, and Static Web Apps resource in West Europe.
  Azure MCP subscription/resource-group reads were unavailable because the
  MCP credential is authenticated to a different tenant; Azure CLI auth and
  target reads succeeded.
- Live backend image is v197 on revision `kh-prod-api-vnet--0000194`; v198 is
  the next image tag. Build the backend from the pushed `main` branch and
  update only after the ACR build succeeds.

Deployed 2026-10-15 following the 10:39 BST request:

- Fix `ed56adb` and validation record `292bf27` pushed to main and feature branch.
- ACR run `ca67` succeeded: `kh-prod-api:v197`, digest
  `sha256:d94895f4767f605b74a9c6a538e386f13a925491196c101f7bdacc752ef4b027`.
- ACA revision `kh-prod-api-vnet--0000194` reports Healthy,
  RunningAtMaxScale and 100% production traffic.
- New-revision startup logs confirm migration completion, database pool
  pre-warm 8/8 and scheduler startup without migration/configuration errors.
- Frontend, infrastructure, registry credentials and roles remain unchanged.
- Application: https://athena.themicrosoftcloudblog.com/
- Successful brief generation has not yet been observed; this deployment
  removes the confirmed 100-second timeout from the background brief call.

Validated 2026-10-15 after the 10:39 BST request:

- `git fetch origin` and `git merge origin/main`: already up to date; timeout
  fix `ed56adb` is present. Unrelated `.impeccable/` remains untouched.
- Both applications: `npx tsc --noEmit` passed. Backend `npm run build` passed.
- `node scripts\run-isolated-tests.mjs` passed with exit code 0.
- Azure authentication confirms Alliance Tenant Reporting,
  `c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28`; existing target remains UK South.
- Live ACA configuration is Succeeded on v196, revision 0000193, with latest
  revision receiving 100% traffic. Existing ACR secret-based authentication is
  unchanged; no managed identity or new RBAC propagation gate applies.
- Dockerfile and package-lock.json verified. ACR has v196/v195/v194; v197 is
  the next release. ACR remote build must succeed before the image update.
- Existing-resource backend image update only: IaC/template/policy changes and
  frontend publication are not applicable.

Deployed 2026-10-14 following the 20:15 BST request:

- Application `2a1f9bc`, nested navigation `dbd3b11` and validation record
  `7ce1f70` pushed to main and the feature branch.
- ACR run `ca65` succeeded from Git source `7ce1f70`: image `kh-prod-api:v195`,
  digest `sha256:9337237e219e13cd243556732b35c093439787b38e325ad9c530148c9139c0be`.
- ACA revision `kh-prod-api-vnet--0000192` is active, Healthy /
  RunningAtMaxScale / Provisioned and latest ready, receiving 100% traffic.
- Startup logs confirm `apply 076_canvas_recycle_bin.sql`, migration completion
  and database pool pre-warm (8/8). Initial revision check used an incorrect
  CLI argument; revision listing confirmed the deployment was healthy.
- Matching SWA production deployment succeeded. Both production `/think`
  hosts return HTTP 200 and serve `/assets/index-CmEviuh1.js`, SHA-256
  `3a49ebc0955290d1dd5b0701c785e9963c7c3f9d4984d99a6b8b9e11bfbb1141`,
  exactly matching the synced local production bundle.
- No infrastructure, role, environment, authentication or secret changes.
- Live application: https://athena.themicrosoftcloudblog.com/think

Validated 2026-10-14 following the 20:15 BST deployment request:

- `git fetch origin` / `git merge origin/main`: already up to date at application
  source `2a1f9bc`; only unrelated `.impeccable/` remains untracked.
- Both applications: `npx tsc --noEmit` and production builds passed after sync.
- Frontend isolated suite: 53 passed. Backend isolated suite: 93 passed.
  Recycle-specific backend tests prove active/deleted list separation, non-
  destructive soft delete, retry-safe restore and recycled-only permanent delete.
- Recovery browser checks passed at 1440 and 390, including lost restore
  acknowledgement, explicit permanent-delete confirmation and responsive layout.
  Navigation checks passed at 1440, 1024 and 390. Frontend/backend lint
  non-regression passed (25/607 existing violations).
- Azure CLI 2.77.0 authenticated; production subscription
  `c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28` is Enabled. Existing ACA revision
  `kh-prod-api-vnet--0000191` is Healthy / RunningAtMaxScale; current image v194.
- Backend lockfile exists. Dockerfile uses `npm ci` and copies all
  `src/db/migrations/*.sql`, including additive migration 076, into the image.
  ACR build must pass before the Container App image update.
- No IaC, policy or RBAC changes: compilation, template validation, what-if,
  provisioning and role propagation are not applicable. Existing registry
  credentials and Container App identity None are retained.
- No deployment credentials printed or persisted.

Deployed 2026-10-14 following the 19:19 BST request:

- Application `947d57b` and validation record `b87dce8` pushed to feature branch
  and main. Existing production subscription confirmed by the user.
- SWA CLI production deployment succeeded to `kh-prod-web`.
- Both production `/think` hosts return HTTP 200 and serve
  `/assets/index-CFjIrh7X.js`, SHA-256
  `01f04a5b9b3bf1a2848ce981a08b1562c647c3c1b7449d165f38793530fd8acf`,
  exactly matching the synced local production build.
- Backend v194 remains unchanged: revision `kh-prod-api-vnet--0000191` is
  active, Healthy / RunningAtMaxScale. SWA Free tier and absent managed identity
  retained; no RBAC, infrastructure, configuration or credential changes.
- Live application: https://athena.themicrosoftcloudblog.com/think

Validated 2026-10-14 following the 19:19 BST deployment request:

- `git fetch origin` / `git merge origin/main`: already up to date at application
  source `947d57b`; only unrelated `.impeccable/` remains untracked.
- Both applications: `npx tsc --noEmit` and `npm run build` passed after sync.
- Implementation regressions: 11 shared bridge/theme tests, 31 geometry tests
  and 5 draw.io tests passed. Browser checks passed at 1440 and 390, including
  native pointer selection, movement/undo and transparent/white export pixel gaps.
- Frontend lint non-regression passed with 25 existing violations; fixture typing
  retains only the five documented unrelated baseline errors.
- Azure CLI 2.77.0 authenticated against established production subscription
  `c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28` (Enabled). Azure MCP lists no subscriptions;
  CLI resource reads succeeded. SWA `kh-prod-web` is the established Free tier
  resource in West Europe.
- Backend remains `kh-prod-api:v194`, revision `kh-prod-api-vnet--0000191`,
  Healthy / RunningAtMaxScale, identity None. No backend build deployment needed.
- No IaC, policy, RBAC, Docker or registry changes: template compilation,
  what-if, provisioning, role propagation and ACR build are not applicable to
  this frontend-content-only release. Existing hosting/registry credentials retained.
- No deployment credentials printed or persisted.

Deployed 2026-10-14 at 17:04 BST:

- Source `bb73487` (application `c00598e`, save confirmation `2390775`,
  Properties overflow `3a32810`) pushed to main and feature branch.
- ACR run `ca64` succeeded: `kh-prod-api:v194`, digest
  `sha256:5c546a8a0d27a6e1c7fcd1276e6e2058ccb9c70c738f5d6f25e5918d7bc0fcae`.
- ACA revision `kh-prod-api-vnet--0000191`: Healthy / RunningAtMaxScale /
  Provisioned, latest ready revision with 100% traffic.
- Startup logs explicitly confirm `apply 075_diagram_drilldowns.sql`,
  migration completion, database pre-warm and scheduler startup.
- Production SWA deployment succeeded. Both production hosts return HTTP 200
  for `/think`, serving `/assets/index-DyU2VQXo.js` with SHA-256
  `1e2bee7ec7b11d565c587c6fc44a07f8c70c7e9c7c00c2c1e01a008b5177df40`,
  matching the local production bundle.
- Existing registry authentication and identity None retained. No role,
  infrastructure, environment or secret changes; managed-identity provisioning
  and role propagation checks are not applicable.
- Live application: https://athena.themicrosoftcloudblog.com/think

Validated 2026-10-14 at 16:58 BST for application `c00598e`:

- `git fetch origin` / `git merge origin/main`: already up to date.
- Both applications: `npx tsc --noEmit` and `npm run build` passed after sync.
- Backend isolated suite: 89 passed, zero failed; atomic creation/reopen,
  rollback, stale revision and removed-shape cases covered.
- Drill-down browser checks passed at 1440 and 390: nesting, saving before
  close, error retention/retry, parent selection/view preservation and reopen.
  Properties and diagram-theme regression checks also passed.
- Frontend/backend lint non-regression passed (25/607 existing violations).
  Browser fixture typecheck has only the five documented pre-existing errors
  in unrelated data-reliability/today fixtures; no new fixture errors.
- Azure CLI 2.77.0 authenticated; production subscription
  `c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28` is Enabled. ACA current image v193,
  ready revision 0000190. Existing ACR and SWA resource reads succeeded.
- Dockerfile `npm ci` lockfile exists and copies `src/db/migrations/*.sql`,
  including additive 075, into `dist/db/migrations`. Local npm build runs tsc;
  migration copy is the Docker packaging step. ACR build must pass before update.
- No IaC/policy/RBAC changes: compilation, what-if and provisioning are N/A.
  Existing registry credentials remain; Container App identity is None.
- `git diff --check` passed. No credentials printed or persisted.

Deployed 2026-10-14: full-card drag correction `4a6b37d` pushed to main and
feature branch. Production SWA deployment succeeded; both production hosts serve
`/assets/index-BAfSNSiR.js`, SHA-256
`a01796301226f24334b89a89a6e650dfd773952cda8e0b254b6ed0923691011d`,
matching the local build. Backend remains unchanged at v193.

Validated 2026-10-14 for the full-card drag correction:

- Reproduced failure with native browser mouse input: grip drag started, card
  text drag did not. Corrected the source element, not the server move endpoint.
- Browser fixture passes at 1440px and 390px. Desktop now starts native mouse
  drags from both grip and card body, passes browser drag data to the actual
  drop target and confirms saved membership/count refresh. Mobile retains the
  chooser and DOM drop/error-state checks; no native touch drag claim.
- Frontend `npx tsc --noEmit`, lint non-regression and `npm run build` pass;
  unchanged backend `npx tsc --noEmit` passes.
- `git fetch origin` / `git merge origin/main`: already up to date.
- Azure CLI confirms the existing production subscription and SWA hostname;
  no infrastructure/IaC/RBAC changes or Docker rebuild are applicable.

Deployed 2026-10-14 at 12:20 BST:

- Source `2863475` (application `fb996e8` and Think pop-out `dda9779`) pushed
  to main and `richardichogan-link-think-chat-projects`.
- ACR run `ca63` succeeded, producing `kh-prod-api:v193`, digest
  `sha256:fa8767df7aa0913757ab385dd229407e6125e54140eaed85b46f4ef57e9010c8`.
- Backend revision `kh-prod-api-vnet--0000190` reports Healthy /
  RunningAtMaxScale, Provisioned, with 100% traffic. Startup logs confirm
  migration completion, pre-warmed database pool and scheduler startup.
- Existing registry credentials retained; Container App identity remains None.
  No managed-identity/RBAC provisioning is required or changed.
- Production SWA deployment succeeded. Both production hosts return HTTP 200
  for `/think` and serve `/assets/index-CF2o6XrZ.js`; remote SHA-256 matches the
  local production bundle:
  `506282a9bd866f4dfd15c5f1a81d4eb15a696cec2c134960ee5a97b498a71619`.
- Live application: https://athena.themicrosoftcloudblog.com/think
- Authenticated user flows were covered by isolated fixtures before deployment;
  production verification did not create or move user Sparks.

Validated 2026-10-14 for `fb996e8` / `dda9779`:

- `git fetch origin` and `git merge origin/main`: already up to date.
- Both application `npx tsc --noEmit` and `npm run build` passed after sync.
- Backend 83/83 and frontend 43/43 isolated tests passed; both lint
  non-regression checks passed without rebaselining.
- Discover and Spark drag/drop browser fixtures passed at 1440px and 390px;
  pop-out fixture previously passed at both widths for `dda9779`.
- Azure CLI authenticated target reads confirm Alliance Tenant Reporting
  (`c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28`), ACA v192/revision 0000189,
  registry `cad79107555facr` and SWA `kh-prod-web`.
- Azure MCP subscription listing returned no subscriptions; established Azure
  CLI account and resource reads succeeded.
- Dockerfile and existing package lock verified; remote ACR Docker build is
  the image validation gate before the production image update.
- No infrastructure/IaC/RBAC/policy changes: compilation, what-if and role
  provisioning validation are not applicable to this existing-resource release.
- Browser test-project typecheck retains five pre-existing errors in unrelated
  Today/data-reliability mocks; production application typechecks pass.

Deployed 2026-10-14:

- Application release `321e9f6` (including Plan commit `84508f2`) pushed to main
  and `richardichogan-link-think-chat-projects`.
- ACR run `ca62` succeeded; backend v192 revision `kh-prod-api-vnet--0000189`
  reports Healthy / RunningAtMaxScale with 100% traffic.
- Startup logs confirm `074_day_checkins.sql` applied and migration completed;
  database pool initialized and scheduler started.
- Production SWA deployment succeeded. Both the custom domain and default SWA
  `/discover` serve `/assets/index-Du8j20Vu.js`, whose SHA-256 matches the local
  production bundle.
- Live URL: https://athena.themicrosoftcloudblog.com/discover

Validated 2026-10-14 for the one-click Discover Spark / Plan release:

- `git fetch origin` / `git merge origin/main`: already current.
- Both application `npx tsc --noEmit` and `npm run build` passed.
- Both lint baseline checks passed; no baseline changes.
- Isolated frontend 43/43 and backend 74/74 tests passed.
- Discover browser checks passed at 1440px and 390px: synopsis/source payload,
  no writing box, same-tick duplicate prevention, failure/retry/saved states,
  unchanged article workflow and existing social/publication interactions.
- Fixture typecheck has no Discover errors; five existing errors remain in
  unrelated data-reliability/Today fixture mocks (not production application code).
- Azure CLI target reads confirm subscription `c1547b0a-dbbe-4dfe-a9ff-26c6eb9f7a28`,
  Container App v191 / ready revision `kh-prod-api-vnet--0000188`, existing SWA
  `kh-prod-web` and registry `cad79107555facr` in Succeeded state.
- Dockerfile/lockfile build context verified; Dockerfile copies migrations from
  `src/db/migrations` to the runtime image. ACR build must pass before updating ACA.
- No IaC, provisioning or RBAC changes; compilation/what-if/policy changes N/A.
- `git diff --check` passed. Rollback is recorded in scope above.

Deployed 2026-10-12 following the 11:53 BST request:

- Production SWA deployment succeeded for `91c5c24` (application `9e29ec9`).
- Both production hosts serve matching release HTML at `/discover`;
  `/assets/index-DcclTItg.js` SHA-256 matches the local production build.
- Backend v180 and ranking logic unchanged.
- Production: https://athena.themicrosoftcloudblog.com/discover

Validated 2026-10-12 following the 11:53 BST request:

- Remote main fetched/merged: already current.
- Both applications `npx tsc --noEmit` and frontend production build passed.
- Build log: `%TEMP%\athena-discovery-layout-deploy-build.log`.
- Fixture typecheck and Discovery browser checks passed at 1440/390.
- Screenshots inspected at both widths: desktop title directly below metadata,
  independent rank column, mobile title full-width with no squeezed text.
- Existing article/email/dialog workflows passed; weighted rank unchanged.
- Azure target reads confirm production SWA and backend v180.
- Provisioning/IaC/RBAC checks N/A: existing static release only.

Deployed 2026-10-12 following the 11:44 BST request:

- Production SWA deployment succeeded for `de5d0a1` (application `75a5fbc`).
- Both production hosts serve matching release HTML at `/` and `/discover`;
  `/assets/index-IrMYqW-f.js` SHA-256 matches the local production build.
- Backend v180 and ranking logic unchanged; no infrastructure/config changes.
- Production: https://athena.themicrosoftcloudblog.com/discover

Validated 2026-10-12 following the 11:44 BST deployment request:

- `git fetch origin` and `git merge origin/main`: already current.
- Both applications: `npx tsc --noEmit` passed.
- Frontend production `npm run build` passed; log:
  `%TEMP%\athena-discovery-rank-deploy-build.log`.
- Frontend fixture typecheck and Discovery browser suite passed at 1440/390:
  weighted rank (including values above 100), 28px number, readable label,
  no horizontal overflow, and existing article/email/dialog workflows.
- Azure CLI confirms Alliance Tenant Reporting, production `kh-prod-web`
  and unchanged backend v180. Existing deployment-token authorization only.
- Provisioning, IaC validation and RBAC changes N/A for this static release.

Deployed 2026-10-12 following the 11:17 BST request:

- Production SWA deployment succeeded for `d8551b4` (application `2f49519`).
- Custom/default hosts serve matching release HTML at `/` and `/think`;
  `/assets/index-Bb8wIkhn.js` SHA-256 matches the local production build.
- Backend v180 unchanged; no infrastructure/configuration/secret/role changes.
- Production: https://athena.themicrosoftcloudblog.com/think

Validated 2026-10-12 following the 11:17 BST request:

- Remote main fetched and merged; already current.
- Both app `npx tsc --noEmit` checks and frontend production build passed.
- Application `2f49519`: desktop/mobile diagram browser checks passed,
  fixture typecheck passed, 13 annotation and 5 draw.io tests passed.
- Live subscription/SWA/backend reads confirm established production targets
  in Alliance Tenant Reporting, backend v180 unchanged.
- No IaC, RBAC, migrations, container or environment changes; related checks N/A.
- Build log: `%TEMP%\athena-full-width-divider-build.log`.

Deployed 2026-10-12 following the 11:09 BST request:

- SWA production deployment succeeded for `8d162c1` (application `f27219c`).
- Both production hosts serve exact release HTML at `/` and `/think`;
  `/assets/index-fqk88lHh.js` SHA-256 matches the local build on both hosts.
- Backend v180 unchanged. No infrastructure, secrets, roles or environment changes.
- Production: https://athena.themicrosoftcloudblog.com/think

Validated 2026-10-12 following the 11:09 BST deployment request:

- `git fetch origin` / `git merge origin/main`: already up to date.
- Both app `npx tsc --noEmit` checks passed; frontend production build passed.
- Exact application source `f27219c` already passed diagram browser checks at
  1440px and 390px, fixture typecheck and five draw.io export tests.
- Live Azure target reads passed: existing SWA `kh-prod-web`, backend v180.
- No infrastructure, container or RBAC changes; related validation N/A.
- Frontend build log: `%TEMP%\athena-divider-build.log`.

Deployed 2026-10-12 at 10:34 BST:

- Release `a5bbc51` (application source `2e1af96`) pushed to remote main and
  `richardichogan-link-think-chat-projects`.
- ACR build `ca5p` succeeded; image `kh-prod-api:v180`, digest
  `sha256:6b60f8df7d08147bdcbd3906a1e261ca0657fba26c87308e6f41ce2c1e3bbb63`.
- Backend revision `kh-prod-api-vnet--0000177` Healthy / RunningAtMaxScale,
  active with 100% traffic. `/health` returned HTTP 200 with status ok.
  Startup logs show migration completion and pool readiness without errors.
- SWA CLI production deployment succeeded after backend health verification.
- Custom and default production hosts return matching release HTML at `/`,
  `/think`, `/chat` and `/signin`; `/assets/index-0KswgK3c.js` SHA-256 matches
  the local production build on both hosts.
- No credentials, environment, infrastructure, RBAC or new migration changes.
- Production: https://athena.themicrosoftcloudblog.com/
- Backend: https://kh-prod-api-vnet.proudcoast-0a102078.uksouth.azurecontainerapps.io

Validated 2026-10-12 at 10:29 BST for application source `2e1af96`:

- `git fetch origin` and `git merge origin/main`: already current with `47e559a`.
- Both packages: `npx tsc --noEmit` and `npm run build` passed.
- Frontend fixture `npx tsc --noEmit -p tests/tsconfig.json` passed.
- Backend diagram validation/context tests: 37 passed; callout tests: 4 passed;
  draw.io tests: 5 passed. Isolated mocked data only; no production writes.
- Diagram browser regression passed at 1440px and 390px, including all six
  callout icons/categories, plain-text removal, save/reopen, duplication,
  undo/redo, export geometry and no page overflow.
- Azure CLI authentication and live ACA/ACR/SWA reads passed. Current backend
  v179, latest ready revision `kh-prod-api-vnet--0000176`; ACR state Succeeded.
- Dockerfile and lockfile verified; Dockerfile copies all existing migrations.
  ACR remote build must succeed before the production image is updated.
- No IaC/RBAC changes: template/what-if/provisioning/static role checks N/A.
  Existing registry uses its configured credentials, not a new managed identity.
- `git diff --check` passed. Frontend build log:
  `%TEMP%\athena-callout-deploy-build.log`.

Deployed 2026-10-10: popup login correction `e154d32`.

- SWA production deployment succeeded; backend v176 unchanged.
- Both production hosts serve exact release HTML at `/`, `/chat` and
  `/signin`; `/assets/index-CoiT-Upu.js` SHA-256 matches the local build.
- Isolated browser checks against the deployed callback passed at 1440px
  and 390px: success/error responses relayed, popup closes and the original
  page with unsent work stays mounted. No live Entra credentials were used.
- Production endpoint: https://athena.themicrosoftcloudblog.com/

Validated 2026-10-10 following the 09:13 BST correction request:

- Frontend and backend `npx tsc --noEmit` passed; fixture typecheck passed.
- `node --test tests/auth-session.test.mjs`: silent renewal, shared popup,
  cancellation/retry, account restoration, API resumption, initial popup
  sign-in, no interactive redirects and network-error handling passed.
- Real MSAL callback browser checks passed at 1440px and 390px: callback
  broadcast, popup closure, no secondary app/sign-in bootstrap, original
  page and unsent work remain mounted.
- Session-expiration UI passed at 1440px and 390px: cancellation/retry,
  popup explanation, unsaved work retained and no page navigation.
- Existing chat/navigation checks passed at 1440px, 1024px and 390px,
  including session/draft continuity and no automatic duplicate sends.
- `npm run build` and `git diff --check` passed; remote main has no new changes.
- Frontend ESLint could not run because the repository has no frontend
  ESLint configuration; no new lint configuration was introduced.
- Existing SWA and unchanged backend v176 verified with Azure CLI.
  No IaC, policy, RBAC, Docker or provisioning changes are required.
- Build log: session artifact `files/popup-login-build.log`.
- Live credentialed Entra sign-in is not automated by these fixtures.

Deployed 2026-10-10 after the 09:02 BST request:

- Latest main application/test source `93079cd`, validation record `d07c4e9`.
- SWA CLI production deployment succeeded; backend remains v176.
- Both custom and default production hosts serve exact release HTML at `/`,
  `/chat` and `/signin`; `/assets/index-BCDTckK_.js` SHA-256 matches the local build.
- No infrastructure, roles, secrets or environment changes.
- Production endpoint: https://athena.themicrosoftcloudblog.com/

Validated 2026-10-10 after the 09:02 BST deployment request:

- `git fetch origin` and `git merge origin/main`: source `93079cd` is current.
- Both packages: `npx tsc --noEmit` passed.
- Frontend: `node --test tests/auth-session.test.mjs` and `npm run build` passed.
- Isolated callback browser checks previously passed for this exact source at
  1440px and 390px, including return to `/chat` with the session and draft intact.
- Azure CLI authentication and reads verified subscription
  `Alliance Tenant Reporting`, SWA `kh-prod-web` and unchanged backend v176.
- Frontend-only asset upload: Docker builds, IaC compilation, what-if, policy
  and RBAC changes are not applicable. No provisioning is required.
- Build log: session artifact `files/login-redeploy-build.log`.

Deployed 2026-10-10 at 08:51 BST:

- Frontend-only hotfix `8312e12`; backend v176 unchanged.
- Static Web App production deployment succeeded to
  https://athena.themicrosoftcloudblog.com/
- Custom and default hosts serve exact release HTML and SHA-256-matching
  `/assets/index-BCDTckK_.js`; `/signin` callback route serves the app entry.
- Isolated headless tests of the deployed callback succeeded at desktop and
  mobile sizes: callback success/error relay, popup closure and original page
  remaining mounted. No real Entra credentials were used.

Validated 2026-10-10 at 08:50 BST:

- `knowledge-hub-web`: `npx tsc --noEmit`, fixture `npx tsc --noEmit -p tests/tsconfig.json`,
  and `npm run build` passed.
- `node tests/auth-session.test.mjs` passed; verifies signed-in renewal uses
  `acquireTokenRedirect` (same tab), missing-account recovery uses `loginRedirect`,
  and token renewal does not create a popup or navigate without user action.
- Isolated Edge browser callback suite passed at 1440px and 390px:
  MSAL success/error broadcast, redirect callback return/cache, malformed
  callback recovery, and direct `/signin` route.
- Existing production SWA and v176 backend targets verified; no backend change.
- No IaC or role changes; Bicep/what-if/policy checks are not applicable to
  this frontend-only static asset release. `git diff --check` passed.

Deployed 2026-10-09 at 22:41 BST:

- Release `a39cb68` (application code `877c4d8`), ACR run `ca5j` succeeded.
- Backend v176 revision `kh-prod-api-vnet--0000173` is the sole active
  revision, Healthy / RunningAtMaxScale. Migrations completed; API health 200.
- Matching SWA production deployment succeeded. Custom and default hosts
  serve exact release HTML and SHA-256 matching `/assets/index-BhI-nETI.js`.
- No secrets, environments, infrastructure or roles changed; existing
  registry password secret remained in place and image pull succeeded.
- Endpoint: https://athena.themicrosoftcloudblog.com/

Validated 2026-10-09 at 22:36 BST for `877c4d8`:

- Both apps `npx tsc --noEmit` and `npm run build` passed.
- Backend project-context/diagram-context/diagram/Socials selection: 44 tests passed.
- Frontend terminal diagram metadata and linked-chat grounding checks passed.
- Read-only live replay discovered and read the IMAGINE diagram from the IKEA chat.
- Azure CLI 2.79.0 authenticated to the established production subscription.
- Existing ACA v175, ACR Succeeded and SWA hostname verified; v176 unused.
- Dockerfile and lockfiles reviewed; ACR remote Docker build gates image update.
- No IaC/RBAC changes: template validation, what-if, policy provisioning and
  static role changes are N/A for this existing-resource image/content update.
  Existing registry password secret reference retained; no managed-identity change.
- Pushed remote branch matches exact code commit; `git diff --check` passed.

Deployed 2026-10-09 at 21:13 BST:

- Backend v175 revision `kh-prod-api-vnet--0000172` is the only active
  revision, Healthy / RunningAtMaxScale; startup migrations completed.
- SWA production deployment succeeded. Custom/default hosts serve exact
  release HTML and SHA-256 matching entry scripts; API health returned 200.
- Endpoint: https://athena.themicrosoftcloudblog.com/

Validated 2026-10-09 at 21:10 BST for `5225de7`:

- Both apps `npx tsc --noEmit` and `npm run build` passed.
- Backend diagram/discovery/turn-job/publishing/history selection: 44 tests passed.
- Latest desktop/mobile diagram browser fixture passed at 1440/390px, including
  artefacts, standalone lines, style persistence, exports and chat panel behavior.
- Worktree servers verified with health, projects, notes and discovery source
  reads through the frontend proxy. Startup migrations completed without errors.
- Azure authentication/subscription verified; production is v174; v175 unused.
- `git diff --check` passed. No IaC/RBAC change: template/what-if/role provisioning
  not applicable. Existing registry secret retained; ACR Docker build gated
  before updating the production image.

Deployed 2026-10-09, combined release:

- Both implementation commits are included in remote main by fast-forward.
- ACR run `ca5g` built and pushed v174 successfully.
- Revision `kh-prod-api-vnet--0000171` is the only active revision,
  Healthy / RunningAtMaxScale.
- Matching SWA production deployment completed. Both production hostnames
  serve exact release HTML and SHA-256 matching `index-_e7D8LHC.js`,
  `signinCallback-bh-pVR6x.js` and `appBootstrap-Bz_2h1yG.js`.
- Live authenticated API checks passed: 16 writable project-configured
  destinations; unconfigured repository denied; configured folders browse.
- Release includes readable title-based filenames and dark diagram shapes.
  Existing publication paths and saved legacy export artwork stay unchanged.
- Production endpoint: https://athena.themicrosoftcloudblog.com/
- No production note writes were performed for deployment verification.

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

## Release v250 — Athena Blueprint review and card alignment

- Scope: authored Blueprint renderer and sanitiser, click-to-comment review
  queue, full-screen diagrams, Athena job notices, and per-card style and
  alignment fixes. Adds backend dependency `htmlparser2`.
- Validation: both type checks and lint baselines pass. The full suites ran once.
  Then only the failed or affected checks were rerun: backend `designs.test.ts`
  passes 5/5, and UI `design-artifact` and `document-review` pass.
  The UI hang was an open BroadcastChannel, now unref'd under Node.
- Deployment completed at 2026-10-25T22:11Z:
  - Source `d9de395` pushed to main and the feature branch. ACR run `ca7v`
    built `kh-prod-api:v250`.
  - Revision `kh-prod-api-vnet--0000247` is Healthy / RunningAtMaxScale and
    serving live design and collaboration requests with HTTP 200 responses.
  - Frontend production deployment succeeded and serves
    `/assets/index-DJrYJiPt.js`, which matches the local build.
  - `.impeccable/hook.cache.json` was preserved and not committed.
