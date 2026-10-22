# Athena Desktop

A Windows app (Electron) that opens the hosted Athena site and gives it access to folders you choose on this PC.

## Full app and standalone chat

The installer adds two shortcuts to Start and, when desktop shortcuts are enabled, your desktop:

- **Athena** opens the full workspace.
- **Athena Chat** opens `/chat`, the same standalone chat interface used by the PWA, without the workspace sidebar/navigation.

Both can be open together. Use the **Athena** menu to open either experience
(`Ctrl+Shift+C` for chat, `Ctrl+Shift+H` for the full app). Reopening a shortcut
focuses its existing window without reloading it or replacing its draft.
The windows share the desktop sign-in, stored chat state, and approved local folders.
The existing browser/PWA is unchanged; its browser sign-in and local draft storage
remain separate from Electron's.

Version 0.1.2 adds the standalone chat shortcut and window.
Version 0.1.3 sends Athena chat links (for example **Open podcast brief** on Today)
to the Athena Chat window that is already open and switches it to that chat in
place, instead of opening another window. Unsent drafts are kept per chat. If no
chat window is open, one opens on that chat.

- **Index**: files in your chosen folders (PDF, Word, PowerPoint, Excel, CSV, Markdown, text) are uploaded to your Athena library and kept in sync while the app is open. Files that can't be indexed are listed under "N files not indexed" in Documents → Folders on this PC, with the reason.
- **Read**: in chat, Athena can read files in those folders (`read_local_file`).
- **Write**: Athena can propose a change to a file (`propose_local_file_write`). It appears in chat as a diff; nothing is written until you click Apply. If the file changed on disk since the diff was shown, Apply stops and shows the new diff.

Only the folders you add are reachable. Paths are checked after resolving symlinks and junctions, so a link can't reach outside a folder.

## M365 Daily Insights

In Library → **Folders on this PC**, choose **Add Daily Insights** and select the
folder M365 Copilot writes into. This explicitly enables structured capture for
that folder; ordinary folder indexing still never creates tasks. Richard's
specifically authorised `C:\Users\RichardHogan\OneDrive - IBM\Daily Insights`
folder can also be registered using the existing **Add folder** button, including
on desktop 0.1.3. No other folder named “Daily Insights” is implicitly enabled.

Keep reports named `Daily-Briefing-YYYY-MM-DD.md`, with the matching report
date and the previous day's knowledge. The backend uses the existing Azure AI
bulk model to understand tasks, ownership, deadlines and meetings semantically;
headings, field labels and Markdown layout are not a parsing contract. Tables,
cards, nested meeting clashes and prose are supported without template aliases.
The model references source line numbers; the importer checks extracted fields
against those actual lines and copies yesterday's complete knowledge from its
original source range, rather than asking the model to reproduce it.
These checks must pass before anything is saved. The model inventories actions
and timed entries before extracting them; the returned arrays must match that
inventory. Failed validation allows one AI correction, never partial capture.
Richard may be directly or jointly assigned, including role annotations;
another owner's contextual mention of Richard is not an assignment. All-day FYI
entries are flagged for review rather than assigned invented start/end times.
Unavailable AI, malformed output, missing facts or incomplete extraction fail
explicitly without partial writes; there is no regex-parser fallback.

- All new reports are processed oldest first, so an offline gap is caught up
  and the latest report is not missed. Same-day corrections replace that day's
  imported diary entries and yesterday's knowledge document.
- Only Richard-owned explicit tasks are added to Plan's inbox. Exact deadlines
  become dates; “this week”, “overdue”, “before the meeting” and other vague
  deadlines remain verbatim in the task with a review warning, never guessed.
- Tasks deduplicate across reports. Completed, archived, deleted, manually
  created and user-edited tasks are preserved; removing an action from a report
  does not delete a task.
- Meeting times use Europe/London (BST/GMT); free-time rows aren't meetings.
  Yesterday's knowledge is saved as a dated Library Markdown document, retaining
  source provenance. The original local files are **never deleted**.
- The capture endpoint (`POST /api/capture/daily-insights`) has its own durable
  transaction/receipt, separate from upload indexing. Failed captures retry on
  the next sync even if the original file is already indexed. Sync runs on
  startup, filesystem changes, **Sync now**, and every minute while Desktop is open.
  Unchanged/stale reports reuse the receipt without another model call; identical
  simultaneous requests share extraction within the backend process. AI runs
  before the write transaction; the transaction rechecks receipts for races.
- Library shows processed report dates, task/diary counts and deadline/project
  review warnings. Failure details are under **sync issues**.

The backend needs migration `088_daily_insights.sql`, applied by the existing
startup migration runner when an approved deployment occurs. Do not manually
run it against production for validation. The named source picker requires a
rebuilt/reinstalled desktop executable (`npm run dist`); the exact authorised
path fallback works with the existing executable after the web/backend changes
are deployed. A browser/PWA or cloud backend cannot read this PC's files.
The Alliance OneDrive configuration is not involved or changed.

## Develop

```
npm install
npm start          # against production (https://athena.themicrosoftcloudblog.com)
npm run start:chat # the standalone /chat experience
npm run start:local  # against the local web dev server on :5173
npm test
npm run test:navigation  # actual Electron sign-in POST and callback regression
```

## Build the installer

```
npm run dist       # release\Athena Setup <version>.exe
```

The installer is unsigned. Windows SmartScreen shows "Windows protected your PC": choose **More info → Run anyway**.

Version 0.1.1 fixes Microsoft security-registration sign-in: submissions to
`mysignins.microsoft.com` stay inside the sign-in window so their POST data and
session are preserved. Microsoft pages cannot use Athena's local-file bridge.
To upgrade, close Athena and run the newer installer; existing settings are retained.

## Release (auto-update)

Bump `version` in `package.json`, then `$env:GH_TOKEN = gh auth token; npm run release`. Installed copies pick up the GitHub release on next start.
