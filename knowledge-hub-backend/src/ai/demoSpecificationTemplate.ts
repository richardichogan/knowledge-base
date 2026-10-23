/** User-supplied IMAGINE demo specification, version 1. */
export const DEMO_SPECIFICATION_TEMPLATE = `# IMAGINE demo specification: <name>

## How to complete this specification

Copy this file into \`docs/prds/<demo-id>.md\`, or supply equivalent business text.
Administrators can paste it into the PRD field of **Demo builder** (\`/demo-builder\`);
see the [operating guide](../demo-development.md).

**The owner supplies business facts and decisions, not a technical design.** Complete
sections 1-2 and the business requirements you know in sections 3-8. The coding agent
derives the technical details, implementation, registrations and evidence crosswalk
from that same brief. Do not create a competing specification or silently reduce scope.
Unknown inputs stay unresolved with an owner and an explicit blocker. Blank tables,
proposed designs and this template are not approvals or evidence of working behavior.

**New builds only.** Leave of Absence and Turnaround are deployed, working references.
Do not enroll, modify, reseed or republish them to satisfy this specification. Preserve
all other existing demos and drafts as well. The construction baseline is
[the full demo construction method](../demo-build-reference.md); executable phase
semantics are defined in [new-build phase acceptance](../demo-phase-acceptance.md).

## 1. Business outcome and the primary demonstration

- Demo name and original requirement/source references:
- Business problem, people affected and reason to demonstrate it:
- Observable business outcome, including the final receipt:
- Explicit non-goals and claims the demo must not make:
- Primary scenario name (the agent assigns and retains its scenario ID):
- Starting actor, record state and required data:
- Business policy/rule sources; identify unavailable sources:
- Protected decision that must wait for an authorized human:
- What that approval permits, and what it does **not** prove:
- Expected final result and where the user sees it:

Supply the simple, multi-step story **at initiation**, not after implementation.
Retain it through workforce design, deployment, channel operation and final acceptance.
The agent must not substitute a seeded completed case or a different, easier story.
Add as many rows as the agreed scenario needs.

| Step | Actual actor/role | Starting condition and action | Automated work or human wait | Visible result and receipt/evidence |
|---|---|---|---|---|
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |

## 2. People, authority and acceptance ownership

| Persona | Own/assigned/shared record scope | Can see | Can do | Must not see/do |
|---|---|---|---|---|
| <business role> | | | | |

- How cases and decision-makers are assigned:
- Delegation/acting-on-behalf rules and actual versus represented actor:
- Authentication versus explicitly approved presenter simulation:
- Access onboarding, revocation and effects on existing sessions:

Name actual people through the approved identity process. The agent must not invent
account assignments, aliases or sign-off. Keep credentials and sensitive personal
data out of this specification.

| Responsibility | Actual person / approved identity reference | Decision or review required |
|---|---|---|
| Business owner | Unresolved | Original scope, fidelity, protected decisions and final acceptance |
| Technical reviewer | Unresolved | Implementation coverage and technical evidence |
| Evidence custodian | Unresolved | Storage, access, retention and preservation of failures |
| Presenter / acceptance reviewer | Unresolved | Agreed browser/channel demonstration and event authorization |

One person may hold several roles only when actually agreed. For builder evidence,
the owner and technical reviewer must be identified by their actual sign-in \`userId\`s
and have the existing demo-admin access. Role names alone are not authenticated users.

## 3. Outcome 1 - Define the complete agent workforce

**Business input:** describe the work and judgement required, who is accountable,
who decides, and where people or deterministic rules must remain in control.
The coding agent proposes justified agents; the owner need not design an agent catalogue.

For each agent, human, rule, system or orchestrator member, complete:

| Member / kind | Responsibility and justification | Inputs / grounding | Outputs / consumers | Tools / allowed actions | Accountable owner / escalation |
|---|---|---|---|---|---|
| <member> | | | | | |

The agent completes the following definition from the agreed business facts, using
existing schemas and platform views rather than a separate metadata system:

| Required area | Specification and observable acceptance |
|---|---|
| Agent/member properties | Author role, capabilities, limitations, structured I/O, instructions/specification, interaction modes and truthful lifecycle/version metadata. Persist them and show the authored values in unified details for every member kind. Derived defaults are not sufficient. |
| Governance | Identify policy sources, permitted actions, refusal conditions, human boundaries, escalation and any policy-backed thresholds. Prove enforcement on allowed and denied paths; do not invent thresholds or compliance claims. |
| Orchestration | Specify triggers, ordered handoffs, typed outputs, durable attempts/claims, human waits, completion receipts and failure/recovery. Every declared agent must be invoked by the actual workflow. |
| Hierarchy | Define reporting relationships using actual member IDs and agreed leads. Org chart and detail navigation must resolve; no dangling or cyclic reporting links. Stage order is not a reporting hierarchy. |
| Ownership | Keep accountable owner, responsible executor, decision-maker and escalation recipient explicit and distinct. Do not replace ownership with an agent label. |
| Observability | Specify events and correlation across agent/model/tool versions, workflow steps, human decisions and receipts. Define which source proves each claimed action/outcome. |
| Dependencies and composition | Author applications, data/context sources, policies, knowledge assets, consumed services and provided capabilities. Exercise dependency/service maps and composition/BOM with this demo's actual definitions. |
| Coverage and maturity | Populate agreed process coverage and maturity and exercise the shared views. Label design-time analysis; do not present it as measured operation or deployment evidence. |
| Evals | Register per-agent grounding/tool, output, authority/refusal, invalid-input and dependency-failure cases in existing persistence/UI. Definitions are not results; authorized live runs require separately retained results and failures. |

Retain the exact workforce, vertical, member and catalogue identities and every
\`realAgentId\` binding in the agent-owned technical specification. Apply every row of
the construction method's four-outcome acceptance matrix. Missing promised properties,
org chart, dependency map, governance or eval surfaces block G1; a seeded workforce
or populated catalogue alone does not pass it.

## 4. Outcome 2 - Deploy and verify the agents in Foundry

**Business input:** identify the existing environment and required systems/data,
permitted operations and who can authorize them. Use references, not secrets.

| Record/system | Authoritative source and sensitivity | Required read/write | Intended fidelity | Permission/consent owner | Success receipt/read-back and failure behavior |
|---|---|---|---|---|---|
| <dependency> | | | live / approved simulation / not integrated | | |

Simulation needs an actual approval reference and must be disclosed. Intended \`live\`
fidelity is neither an observed connection nor permission to invoke it. Missing
configuration or a failed live request must surface explicitly, never switch to mock,
seed or stale data.

The agent prepares, without executing unauthorized live operations:

- Mirrored records/types, repositories, migrations and ordered setup prerequisites.
- Inventory/adoption of existing Foundry agents before proposing new resources.
- Exact expected catalogue-to-Foundry bindings, model, instructions, tools, grounding,
  connections and definition/version verification for every declared agent.
- The idempotent demo publisher, registered builder publication path and deployment
  script, including partial-outcome diagnosis and separately authorized repair.
- Application release identification: commit, environment, backend revision/image,
  frontend artifact and reviewed non-secret configuration/policy/data-version basis.

| Declared agent | Catalogue ID / expected deployment ID | Required definition, model, tools and connections | Invocation/eval scenario | Evidence and unresolved prerequisite |
|---|---|---|---|---|
| <agent> | Agent derives exact identities | | | Not recorded |

G3 requires the exact application release. G4 requires current remote definition and
workforce read-back **and actual invocation/eval outcomes for every agent**. A deployment
name, local seeder hash, lifecycle label or successful publish response is insufficient.
An uncertain/partial publication must not be blindly replayed; reconcile read-only
first and confirm the original worker has stopped before authorizing repair.

## 5. Outcome 3 - Make the primary Digital Steward work in Teams/M365

- Primary Digital Steward and its business responsibility:
- Required channel(s): Teams, M365, or both, as explicitly agreed:
- Grounded questions it must answer, and the permitted sources/record scope:
- The primary scenario's conversational initiation request:
- Protected action, actual approving human and permitted approval/rejection behavior:
- Status and final receipt that must return to the conversation:

Complete one row per agreed channel. A web link or an installed app alone is not
workflow initiation or a working channel.

| Channel | App/bot, installation and callback references | Signed-in actor, case scope and tool authentication | Tools/runtime/workflow connection | Human approval and returned receipt | Evidence / blockers |
|---|---|---|---|---|---|
| <agreed channel> | | | | | Not recorded |

The agent must wire the supporting harnesses end to end: channel registration,
installation prerequisites, consent/authentication, verified identity and case scope,
grounding and scoped tool handlers, workflow dispatch, durable human wait, authorized
decision callback, duplicate/late-action handling and correlated status/receipt return.
Document the actual recipients, permitted sender/mailbox and number of real human
accounts required; bots and access packages are not human approvers.

G5 requires an actual authorized conversation in **each agreed channel** that answers
grounded questions and initiates the scenario, waits for the human boundary, and
returns the observed result. Verify refusal for unauthorized actors/actions and
explicit errors for missing tools, consent or unavailable dependencies. Published
Steward definitions and a separate action-card bot are not proof they work together.

## 6. Outcome 4 - Operational Intelligence, confidence and full audit

**Business input:** state the operational questions, audience, allowed record scope
and withheld information. Supply real baselines for any savings/impact claim; unknown
baselines must not become invented percentages.

The agent specifies and implements the existing OI endpoint/panel and shared surfaces:

| Metric / operational question | Persisted source and calculation | Window / denominator / units | Audience and redaction | Unmeasured or failed-source behavior | Assertion and observed evidence |
|---|---|---|---|---|---|
| Agent attempts, successes, failures and outcomes with receipts | | | | | Not recorded |
| Human waits, intervention and recovery | | | | | Not recorded |
| Latency, token use or cost where measured | | | | | Not recorded |
| <business-specific question> | | | | | Not recorded |

**Confidence and assurance:** state which activity carries model-reported confidence,
its source and limitations. Separately identify grounding/evidence quality and
governance assurance. Missing confidence is unmeasured, not zero or a fabricated score.
Confidence never grants authority or proves successful execution. Any decision
threshold needs an actual policy source and owner decision.

**Full audit for the agreed scenario:** define mandatory events for intake, attempts,
agent/tool invocation and outputs, handoffs, waits, actual human decisions, downstream
effects, receipts, failure, retry and recovery. Retain case/run/attempt correlation,
actual actor, relevant version, chronology and outcome with appropriate redaction.
Reconcile primary and recovery runs against the mandatory event list; missing events
must be visible and block acceptance. Preserve earlier failures and partial outcomes.
Secondary \`recordInteraction\` telemetry is not a substitute for the canonical audit.

G6 requires working behavioral checks plus live metric/assurance reads and audit
outcome evidence. Empty dashboards, design relationships and seeded history do not
prove operational activity.

## 7. Outcome 5 - A simple, complete demonstration

Use the primary story from section 1, with a concise presenter walkthrough. Show
what happens automatically, why a human is waiting, who acts next and what proves
completion. Use labelled starting fixtures, not pre-completed outcomes.

| Persona | Entry point | Intake / queue / case detail | Evidence, decision and receipt | Loading, wait, failure and recovery behavior |
|---|---|---|---|---|
| <business role> | | | | |

Wire actual client/API/workflow/repository paths and the agreed workforce, unified
agent details, tools/grounding, governance, Steward/channels, OI, selectors, navigation,
stack and guided tour. Preserve the unified details page's tabs and header buttons
across member kinds/deployment states. Use Carbon and accessible, truthful states.

| Story | Given / starting data | Actor and action | Observable outcome | Must never happen | Scenario ID / assertion / evidence |
|---|---|---|---|---|---|
| Primary happy journey | | | | | Not recorded |
| Disjoint/unauthorized person | | | | | Not recorded |
| Missing policy, model, tool or system | | | | | Not recorded |
| Ambiguity, rejection or request for information | | | | | Not recorded |
| Retry, duplicate/concurrent action or restart | | | | | Not recorded |
| Late change, late result or partial execution | | | | | Not recorded |

Use credible, non-vacuous actor/data separation, including disjoint decision-makers
where applicable. Record brief-backed non-applicability rather than silently dropping
a promised scenario. The agent exercises actual behavior with controlled dependencies;
the user verifies browser/channel usability. G7 requires genuine owner acceptance
of the original story and exception/recovery for the exact candidate.

## 8. Constraints, unresolved decisions and live authorization

- Existing environment/configuration references:
- Protected exemplars and behavior that must remain unchanged:
- Intended presentation environment/event:
- Agreed evidence storage/access, retention and custodian (otherwise unresolved):

| Unresolved decision or dependency | Responsible person | Affected requirement / phase | What resolves the blocker | Status |
|---|---|---|---|---|
| <decision> | | | | Unresolved |

Record authorization separately for deployment/publication, agent evaluations,
channel messages, downstream writes and access grants. Building a publisher or
passing a gate does not authorize its execution.

| Proposed live operation | Exact target/environment and scope | Authorizing person and actual approval reference | Limits / recovery prerequisites | Authorization status |
|---|---|---|---|---|
| <operation> | | | | Not authorized until supplied |

Without authorization, build and test offline only. Do not create cloud resources,
send messages, grant/revoke access, run side-effecting evaluations or fabricate
human acceptance. Do not use another demo's policy, accounts or approval as consent.

## 9. Phase acceptance - do not advance on missing proof

The agent maps these phases to the existing versioned contract; this table is not
a second gate implementation. Each accepted phase requires **every criterion and
its accepted predecessor**. Safe independent implementation may continue while a
phase is blocked; the accepted phase and readiness claim must not advance.

| Phase | Pass criteria | Required evidence | Accountable reviewer | Blocks progression |
|---|---|---|---|---|
| G0 - Initiation | Original actor, starting data, ordered story, human boundary, fidelity and final receipt agreed | Owner review of the retained primary scenario/scope | Business owner | Missing scenario, unresolved authority/policy or unagreed fidelity |
| G1 - Workforce | All section 3 definitions and shared properties/maps/coverage/governance implemented; per-agent eval cases registered | Structural and behavioral assertions using this demo's data | Technical reviewer | Missing members/properties/ownership, broken relationships, unenforced controls or absent eval cases |
| G2 - Offline scenario | Real client/API/agent/tool/human-wait/receipt/OI slice, channel implementation, privacy and durable recovery/audit; every release check passes | Exact registered behavioral assertions and release-check results for the candidate | Technical reviewer | Scaffold-only paths, untested promised behavior, failed checks, mock-on-error or unsafe duplicate/late work |
| G3 - Application release | Exact commit, backend revision/image and frontend artifact deployed to the agreed environment | Deployment receipt and reviewed release/configuration identity | Technical reviewer | Wrong/missing artifact or revision, failed release or unavailable deployment evidence |
| G4 - Foundry operation | Every declared agent and staged workforce matches the reviewed definition; actual invocation and required eval outcomes | Per-agent live read and live outcome | Technical reviewer | Name-only checks, identity/definition drift, missing agents, invocation failures or missing eval results |
| G5 - Teams/M365 operation | Each agreed channel grounds answers, initiates the scenario, enforces real human approval and returns correlated status/receipt | Channel/app/auth/tool read-back and actual conversation/action outcomes | Technical reviewer | Install/publish-only proof, missing harness/tool, wrong actor, bypassed approval or absent outcome |
| G6 - OI/assurance/audit | Scoped metrics with provenance, confidence distinct from assurance, complete mandatory-event reconciliation for primary/recovery runs | Behavioral checks, live metric/assurance reads and audit outcome evidence | Technical reviewer | Fabricated/untraceable metrics, leaked data, confidence treated as authority or missing audit events |
| G7 - User acceptance | Owner demonstrates and accepts the original scenario, exception/recovery and browser/channel usability for the candidate | Genuine human acceptance | Business owner | Earlier gate not accepted, changed candidate, missing user review or unresolved promised behavior |

Start with gates **blocked until the required evidence exists**. Record failed,
stale and unknown states explicitly; never replace them with a success-shaped default.
Missing implementation is an implementation blocker, not merely "pending browser
acceptance." Readiness and presentation authorization are separate.

## 10. Agent-owned traceability and evidence handoff

The owner is not required to write JSON, register tests or manufacture receipts.
The coding agent completes these records from implementation and actual results,
keeping them aligned with the original brief and construction mapping:

| Requirement / source | Phase / criterion | Closest reference behavior | Implementation path / exact assertion | Fidelity | Offline evidence/status | Live evidence/status | Human review/status | Blocker / next action |
|---|---|---|---|---|---|---|---|---|
| <original promise> | | | | | Not recorded | Not recorded | Not recorded | |

Retain one row for every promised capability, including the properties, ownership,
org chart, dependencies, composition/BOM, coverage/maturity, governance and eval rows.
Inspect actual Mortgage and WorkWise source/tests for the implementation bar; Leave
and Turnaround may be read-only references for the closest relevant behavior. Record
deliberate differences without copying domain policy or changing the exemplars.

The technical handoff includes:

- Original PRD/source references, normalized brief and full construction mapping.
  New builds retain \`brief.acceptance.version: 1\`, exact workforce/Steward identities,
  primary scenario, owner/reviewer sign-in IDs and agreed channels.
- \`acceptanceVersion: 1\` and the construction \`build\` path in checks registration;
  every compiled \`acceptance-phase-*\` obligation mapped to protected \`phase-*\`
  capabilities, required in every profile with actual assertions.
- Reviewed candidate commit/environment, backend revision, frontend artifact,
  non-secret configuration fingerprint, exact workforce member IDs and each agent's
  catalogue/deployment identity and full definition/version fingerprint.
- For each observation: exact criterion, proof class, original scenario, pass/fail,
  observation/expiry times, source receipt/run, repository references and exact
  registered assertions where required. Expiry and retention are human decisions.
- Separately recorded authenticated technical-reviewer and owner attestations,
  current gate report, entry URLs/personas, setup/publication prerequisites,
  authorizations still needed and pending live/browser acceptance.

Technical evidence review is not independent authentication of provider receipts or
proof a human inspected them. CLI exports are editable repository evidence, not an
identity provider. Changed scope/build/configuration and expired evidence invalidate
acceptance; preserve historical failures rather than relabeling them as current proof.

## Build instruction

> Use \`evidence-led-demo\` and this specification to implement all five outcomes, not
> just a scaffold, contract or checklist. Preserve the original primary scenario.
> Derive the technical details and versioned acceptance contract; build end-to-end
> slices with actual agents/tools, durable orchestration and human decisions, scoped
> API/client, persona UI, shared platform surfaces, channel harnesses and OI/audit.
> Inspect actual reference implementations and close every requirement/source/test
> row. Apply G0-G7 without substituting publication or test declarations for outcomes.
> Run targeted regressions, all \`validate.yml\` gates and both workspace typechecks.
> Report implementation, offline verification, deployment, live observations and
> genuine user acceptance separately. Do not modify working demos or execute live
> side effects without separate authorization.
`;
