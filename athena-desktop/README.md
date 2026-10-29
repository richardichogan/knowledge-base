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

Keep reports named `Daily-Briefing-YYYY-MM-DD.md`. Athena reads each briefing
for meaning using the existing Azure AI bulk model: work Richard needs to do,
today's diary and relevant learning. This is not a fixed-format data import.
Structure, headings, labels and available information may change daily; tasks
can be expressed in prose without a project, owner label, deadline or citation.
Missing optional information remains absent, never invented. Direct requests
addressed to Richard in his personal briefing can identify his work; another
person's task merely mentioning him does not assign it to him.

Source passages support recognised facts. Unsupported optional metadata produces
a review warning, not rejection of otherwise supported work. Summary counts and
model completeness flags do not gate processing. Repeated meetings, private
appointments and overlaps are legitimate diary context, preserved as separate
listed occurrences, not treated as errors. Unknown times are not invented.
The complete original briefing is retained in the receipt. An identifiable
learning passage is copied verbatim; without a separate passage, the whole
briefing is retained as context. Unavailable AI, malformed output, contradictory
report dates or unsupported essential facts still fail explicitly, with one AI
correction attempt; there is no regex-parser fallback.

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
  the next eligible attempt even if the original file is already indexed.
  Library indexing still runs on startup, filesystem changes, **Sync now**, and
  every minute while Desktop is open.
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

### Scheduled imports and file outputs

Use **Tools → Jobs** or discuss the job with Athena in any chat to configure
its days, times, timezone and source device/folder. Desktop registers its
already-authorised folders while open; adding a path in chat does not grant
filesystem access. Jobs uses the existing desktop file bridge, so these controls
do not require a new Electron build.

Daily Insights starts as an incomplete paused job. Legacy automatic capture
continues until the configured job is first enabled for this device. After that
transition the managed schedule governs capture, including while paused; it
does not fall back to the old minute-by-minute importer. The selected dated
report is imported once, waiting for late OneDrive delivery until the next
occurrence. On reopening the app, only the latest eligible scheduled occurrence
catches up; older missed occurrences are audited, not replayed as a backlog.
This does not configure M365 Copilot's own report-generation schedule.

Scheduled Markdown outputs use a unique `athena-<run-id>.md` filename in an
authorised output folder. Existing different content is never overwritten.
Run results and import warnings are available in Jobs; desktop transport and
permission failures also appear in Library's sync issues.

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
