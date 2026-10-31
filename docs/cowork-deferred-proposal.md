# Deferred Cowork proposal

**Status: not approved for implementation or use.** The shipped workflow is
Athena-only. This document records the proposal for reference, not a roadmap
commitment or permission to enable it.

## Proposed responsibility split

Athena would prepare evidence-backed, task-linked deliverable briefs in Think.
Microsoft 365 Copilot Cowork would produce Word, Excel, PowerPoint or PDF files
in Alliance OneDrive. Think would remain the content system of record, and Plan
would retain commitments. IBM email drafts would remain in Think for manual
sending; neither Athena nor Cowork would send them through Alliance.

## Proposed manual handoff

A Copy Cowork prompt action in the existing brief properties panel would copy
the brief, cited-source references, explicitly bounded excerpts, source links
and an exact `OneDrive/Athena/<Project>/<file>` destination. Missing evidence
would be surfaced rather than invented. Existing files would require approval
before overwrite. The existing read-only OneDrive sync would link the exact
produced file to its brief and task, without marking the task complete.

The handoff action, prompt-generation endpoint and guidance were removed.
Task-linked briefs, email drafts and OneDrive file tracking remain Athena-native.

## Proposed connector and plugin

An off-by-default backend MCP endpoint would use Streamable HTTP over HTTPS,
JSON-RPC 2.0 and the existing Alliance Entra identity restrictions. Its
authentication would never inherit the local-development authentication bypass.
The proposed tools were:

- `list_deliverable_briefs`: bounded discovery of active briefs.
- `get_deliverable_brief`: current brief body, revisions and structured state.
- `read_brief_source`: bounded retrieval of sources explicitly cited by that brief.
- `record_deliverable_file`: verification of an exact produced path using the
  existing domain service and reconciliation rules.

There would be no arbitrary source access, email actions or task-status writes.
Calls would be rate-limited, audit-logged and bounded below Cowork's 30-second
response limit. Saved revisions, source permissions and editor conflicts would
remain authoritative.

A versioned Microsoft 365 app package would contain a connector and an
`athena-deliverable` Agent Skill: retrieve the brief, read its evidence, produce
the specified file, save to the approved destination and report it for review.
OAuthPluginVault would hold credentials outside the package. Entra redirect
registration and a real vault reference would be required before activation.

## Unverified prerequisites

Alliance Cowork availability, exact-path saving, custom-plugin upload policy,
Information Barriers, OAuth consent and tenant permissions were not verified.
Azure CLI access does not establish Cowork access. The browser reached a
Microsoft 365 sign-in page; no Cowork session was authenticated.

No MCP connector or plugin package was created, registered or deployed.
Reconsideration requires an explicit new user decision and an end-to-end
authenticated roundtrip, not just a package or a successful typecheck.

## Official references checked on 31 October 2026

- [Cowork overview](https://learn.microsoft.com/en-us/copilot/cowork/)
- [Build Cowork plugins](https://learn.microsoft.com/en-us/copilot/cowork/cowork-plugin-development)
- [Use and upload plugins](https://learn.microsoft.com/en-us/copilot/cowork/cowork-plugins)
- [Work IQ Dev Tools plugin lifecycle](https://microsoft.github.io/wiqd/getting-started/build-a-plugin/)

These interfaces are version-sensitive. The documentation described manifest
1.29 URL-only connectors, OAuthPluginVault support and preview WIQD tooling.
Any future implementation must recheck the current platform contracts.
