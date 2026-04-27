# Personal Knowledge Hub — Change Log

---

## Purpose

This document captures decisions and scope changes made after the
initial spec (PERSONAL_KNOWLEDGE_HUB_v4.md) was baselined. Each
entry records what changed, why, and the impact on the build sequence
and roadmap. Pass this document to GHCP alongside the spec and roadmap
when starting each new build phase.

---

## Change 001 — Primary platform revised to PC via browser
**Date:** 2026-04-12
**Status:** Confirmed

### What changed
The primary user device is PC, accessed via a web browser. This applies
particularly to the initial usage period. Mac (personal projects) and
Android (mobile) are secondary devices.

### Why
The original spec assumed Mac as primary based on the development
environment. Clarified by Richard during the architecture review session.
PC is the primary daily driver, particularly during working hours when
the knowledge hub will be used most frequently to reference content,
manage tasks, and run AI queries.

### Impact on build sequence
The original build sequence was:

1. Backend
2. React Native (iOS and Android)
3. Raycast extension

The revised build sequence is:

1. Backend — in progress, nearly complete via GHCP
2. Web frontend — React + TypeScript, browser-based, PC and Mac
3. Raycast extension — Mac quick capture complement to web frontend
4. React Native — Android first, then iOS

### Impact on roadmap
Web frontend promoted from Tier 3 convenience to Tier 1 deliverable.
React Native demoted to Tier 2. Raycast extension remains Tier 2 but
is now the Mac companion to the web frontend rather than the primary
Mac interface.

### Technical notes
Web frontend should be React with TypeScript. This shares component
logic and patterns with React Native, making the eventual mobile build
faster. GHCP should build the web frontend as a separate project that
consumes the same backend API already being built.

The web frontend must work in a standard browser with no installation
required — this is the PC at work constraint. No Electron, no desktop
app wrapper for the initial build.

---

## Change 002 — Notes as a native content type
**Date:** 2026-04-12
**Status:** Confirmed, pending spec update

### What changed
Ad hoc notes added as a first-class native content type in the
knowledge hub. Notes are the only content type created directly inside
the app — everything else is pulled from an external source.

### Why
The knowledge hub currently aggregates external content only. Notes
fill the gap for thoughts, observations, and ideas captured in the
moment that do not belong in a task, a blog post draft, or a code
issue. They become RAG context, feed the knowledge graph, and can
be promoted to blog post drafts via the AI layer.

### Content type definition

```json
{
  "id": "note-<timestamp>-<random>",
  "type": "note",
  "title": null,
  "content": "Plain text or markdown content",
  "createdAt": "2026-04-12T10:00:00Z",
  "updatedAt": "2026-04-12T10:00:00Z",
  "tags": [],
  "linkedItems": [],
  "status": "active"
}
```

Notes are stored in PostgreSQL alongside other indexed content, not
in blob storage. They are indexed for full-text search immediately
on creation.

### Capture entry points
- Web frontend — simple text input, accessible from any screen
- Raycast extension — keyboard shortcut or voice via Whisper API
- React Native — native text input and voice capture
- Mobile share sheet — text shared from another app lands as a note

### Impact on roadmap
Notes added to Tier 1 web frontend build. Capture via Raycast and
React Native follows in their respective tiers.

---

## Change 003 — Image capture as a native content type
**Date:** 2026-04-12
**Status:** Confirmed, pending spec update

### What changed
Screenshots and images added as a first-class native content type.
Images are captured from the device camera roll, share sheet, or
direct upload and stored in Azure Blob Storage. OCR via Azure AI
Vision extracts text for search indexing.

### Why
Screenshots of slides, diagrams, whiteboards, UI, and other visual
content are a natural part of the knowledge capture workflow. Without
this, visual content either gets lost or requires a separate tool.
With it, the knowledge hub becomes a genuine capture tool rather than
a pure aggregator.

### Content type definition

```json
{
  "id": "img-<timestamp>-<random>",
  "type": "image",
  "title": null,
  "blobUrl": "https://mscloudblogs2026.blob.core.windows.net/kb-images/<id>",
  "ocrText": "Extracted text from image if available",
  "caption": "Optional user-supplied caption",
  "createdAt": "2026-04-12T10:00:00Z",
  "tags": [],
  "linkedItems": [],
  "source": "upload"
}
```

Images are stored in a dedicated `kb-images` container in Azure Blob
Storage, separate from CMS images. OCR text is stored in PostgreSQL
alongside the blob URL and is included in full-text search indexing.

### Capture entry points
- Web frontend — drag and drop or file picker, paste from clipboard
- Raycast extension — screenshot capture via shortcut
- React Native — camera roll access and share sheet
- Mobile share sheet — image shared from Photos or another app

### Notes
Blog post featured images are not affected. Those remain in the CMS
blob container and are managed via the CMS as before. This change
covers knowledge hub content images only.

Azure AI Vision for OCR is available against MSDN credits. Cost at
personal usage scale is negligible.

### Impact on roadmap
Image capture added to Tier 2 for web frontend (drag/drop/paste).
Raycast and React Native capture added to their respective tiers.
Backend image upload endpoint and OCR pipeline added to Tier 2
backend work.

---

## Change 004 — IBM calendar integration confirmed as manual
**Date:** 2026-04-12
**Status:** Confirmed, documented separately

### What changed
IBM work calendar access via delegated Microsoft Graph API was tested
and failed. IBM conditional access policies block access from
non-IBM devices. The integration is confirmed as manual import only.

### Detail
See IBM_CALENDAR_INTEGRATION.md for the full integration pattern,
Outlook Copilot prompt, JSON schema, and backend endpoint specification.

### Impact
IBM work calendar moved to explicitly out of scope for automated sync.
Manual import via JSON paste remains the only viable path and is
documented as a defined workflow.

---

## Change 005 — Knowledge graph added to roadmap
**Date:** 2026-04-12
**Status:** Confirmed, documented in ROADMAP.md

### What changed
Knowledge graph added as a Tier 3 feature. Surfaces relationships
between content items — blog posts to commits, sessions to deliverables,
podcast episodes to show notes, thematically related content.

### Detail
See ROADMAP.md Tier 3 section for the full specification including
SQL schema, relationship types, build sequence, and reasoning for a
web companion graph visualisation rather than a mobile graph view.

### Impact
`relationships` table added to the PostgreSQL schema plan. No impact
on Tier 1 or Tier 2 build.

---

## Pending decisions

| Decision | Impact | Owner |
|---|---|---|
| Podcast platform migration | Must resolve before Tier 2 podcast integration | Richard |
| Sync frequency per source | Required before building sync scheduler | Richard + GHCP |
| Data retention policy | Required before finalising PostgreSQL schema | Richard |
| Write action confirmation UI pattern | Required before building AI write capabilities | Richard + GHCP |
| RAG retrieval scoring model | Required before building dynamic context layer | GHCP |

---

## Document history

| Version | Date | Changes |
|---|---|---|
| 1.0 | 2026-04-12 | Initial change log — changes 001 to 005 |
