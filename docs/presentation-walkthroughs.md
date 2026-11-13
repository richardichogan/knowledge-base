# Scripted demo walkthroughs: operating and testing guide

This guide covers the existing Think Script editor, Athena Desktop presenter,
Turnaround business walkthrough and separate Workforce Intelligence walkthrough.
The fixes described here ship in **Athena Desktop 0.1.25**, with the matching
hosted web/backend release. Building source does not update an already-running
Desktop process.

## What is saved, and what is only live

| Item | Location and behaviour |
| --- | --- |
| Narration | Spoken blocks in a saved Think note whose content type is Script. Section headings are editor-only. |
| Presenter directions | The existing section's **Presenter directions (not spoken)** field. Autosaved with the note; excluded from narration. Maximum 4,000 characters per section. |
| Demo plan | Ordered navigation/inspection actions and their exact spoken cue phrases, saved with each section. Not a recording of arbitrary mouse clicks. |
| Browser visuals | A separate optional visual layer. **Open browser visuals** is not the application-demo command. Plain presenting does not require this layer to be valid. |
| Presentation snapshot | The saved narration and supported cues loaded into Desktop. Later edits do not silently replace it while reading. |
| Display choices and reading settings | Saved by Desktop. It prefers the saved display ID and matching display characteristics; it does not guess another screen. |
| Live reading position and completed demo actions | Held by the current presentation session. Closing or restarting Desktop does not persist an exact resumable cue position. |

The Workforce Intelligence note and Turnaround business note are separate:

| Walkthrough | Saved note ID | Demo entry and finish |
| --- | --- | --- |
| Turnaround business | `65927601-7d56-4beb-912d-037b8abf8c58` | Starts at NPT2 Overview; follows the saved business plan. |
| Workforce Intelligence | `c065e5d0-259c-446a-8af7-41422d09c5ef` | Starts at `/agents?workforce=wf_turnaround`, inspects Scope Challenge Specialist, and returns to Composition & Flow / Stage overview. |

Business and workforce actions cannot be mixed in one script. Updating a local
Markdown file does **not** automatically update either saved note. Apply the
requested revision to the intended existing note through the normal editor or
Athena editing workflow, then verify the saved content.

## Author or adjust the walkthrough through the UI

1. In **Think**, open the intended saved note. Use the existing content-type
   control to select **Script** when preparing a new script; do not create a
   separate workspace or move its properties panel.
2. Keep spoken narration in the section body. Put operating instructions,
   setup requirements and accuracy caveats in **Presenter directions (not
   spoken)**. Section titles are not read by the teleprompter.
3. For a section with **Screen navigation**, choose an approved **Screen**,
   enter an **Exact spoken phrase**, then select **Save navigation cue**.
   Sections without a saved cue remain manual.
4. An existing **Read-only walkthrough** lists its ordered actions and editable
   phrase fields. Edit a phrase and select **Save walkthrough phrases**.
   That form changes timing phrases, not the action type, target or order.
5. To add or change detailed scrolling, pointing, expansion or navigation
   actions, use **Ask Athena to adjust** in that same section. It opens Athena
   with the section identity. Explain the desired actions and explicitly say
   whether narration must remain unchanged.
6. Athena reads saved directions and plans with `read_script_directions` and
   `read_script_demo`, and delivers changes through the protected script-edit
   tools. Let pending editor work save/reconcile; review the resulting section
   and confirm the note has saved. A tool accepting an edit is not itself a
   persistence receipt or proof that a live cue ran.
7. Reopen or reload the saved presentation snapshot only after the changes
   are saved. **Reload saved script** pauses and refreshes the preview;
   **Open script on display** explicitly replaces the output.

Example request from a section's Athena action:

> Read this section's current narration, Presenter directions and walkthrough
> actions. Keep the narration unchanged. Close the configuration assistant at
> “Evaluations let us define repeatable checks”, then select Evals at “Instead
> of accepting a good-looking demonstration”. Point at the recorded case at its
> existing cue. Do not send a configuration request, apply a proposal or run an
> evaluation. Preserve unrelated sections.

The available targets are deliberately allowlisted. There is no general-purpose
click recorder, arbitrary selector editor or direct action-type picker in the
section UI. Unsupported actions require a separately agreed implementation.
**Set up pilot demo cues** is the older three-action Scope list / Jobs / first
job pilot, not a way to generate a complete business or workforce plan.

### Cue rules

- Each exact phrase must occur once in one spoken block of its section, use at
  most 300 characters, and follow narration order.
- Several walkthrough actions may share a phrase; their saved order still
  matters. Limits are 24 actions per section and 96 per presentation.
- Actions follow the teleprompter's reading position, not microphone speech
  recognition or a fixed video timer. Scrolling, speed and text size affect
  when the reading position reaches a cue.
- Added presentation sentence spacing is mapped back to cue positions without
  rewriting the saved narration. Whitespace-only source changes are tolerated;
  changed wording, missing/repeated phrases or structural changes may require
  reviewing and resaving the cues.
- Missing/changed interactive targets pause playback rather than clicking a
  replacement. Where a target explicitly supports missing evidence, the demo
  displays that limitation instead of inventing data.

## Set up and run through the UI

1. Open **Athena Desktop**, sign in, then choose **Athena > Presentation and
   Stream Deck**. Open the presenter through this menu rather than making
   `/present` the Desktop main-window startup URL.
2. In Windows Display settings, use **Extend these displays**. Keep the
   primary display for the controls.
3. Select the intended saved note. Under **Output display**, choose the
   Prompter or its ordinary-monitor substitute. Use **Identify** when unsure.
   If a display was disconnected or changed, use **Refresh displays** and
   explicitly confirm the correct choice.
4. For a synchronized demo, select a different non-primary **Demo display**.
   The controls, text output and application demo must use distinct displays.
5. Select **Open Workforce Intelligence demo** or **Open Turnaround demo**.
   This loads the script when needed, opens the local application separately,
   waits for its expected starting screen/data, and stays paused.
6. Sign in to the local demo if requested. For the business walkthrough,
   verify **NPT2-TA-2027**; for Workforce, verify the Turnaround workforce.
   Resolve any visible loading error before starting.
7. In an **installed/packaged Desktop**, start a scripted demo using **Play on
   the paired Stream Deck**. The on-screen Play path is intentionally blocked
   for these demos. In the **development build**, the presenter explicitly
   offers on-screen **Play**.
8. Use **Pause** to retain the current reading/cue position. Continue with
   Play when recording is ready.

The Script toolbar in Think also exposes Present, playback and an icon currently
labelled **Open Turnaround demo**. That demo icon uses the current script's plan,
including Workforce plans; the standalone presenter shows the more specific
demo label. Configure and save both displays in the presenter first. The Think
action saves/reconciles the open script and uses those saved display choices.

**Plain narration only:** select the note and output display, then **Open script
on display**. Do not open the application demo or browser visuals. Invalid
optional visual/demo plans must not prevent presenting the spoken text alone.

## Testing when the physical Prompter is unavailable

The Prompter is just an extended Windows display. No Elgato text-output hardware
or Camera Hub is required to exercise the presenter.

| Available equipment | Supported check |
| --- | --- |
| Primary screen plus two ordinary extended monitors | Full synchronized UI rehearsal: one monitor substitutes for the Prompter, the other shows the demo. Turn mirror/flip off for direct reading. |
| Primary screen plus one ordinary extended monitor | Narration/output controls can be checked on the external monitor. The current synchronized-demo UI cannot share it with the demo. |
| Only the primary screen | Edit/read the script and cue plans in Think. No current single-screen or windowed synchronized rehearsal mode; do not claim that previewing the note tests Desktop cue execution. |
| No Stream Deck | A development Desktop can start a rehearsal with on-screen Play. An installed Desktop still requires paired Stream Deck Play for a scripted demo, even with ordinary monitors. Plain narration is not subject to that demo-only gate. |
| No display hardware, automated release checks | The Desktop tests mock displays/windows/IPC and exercise reset, cancellation and ownership without monitors. These do not replace a real application-target/pacing rehearsal. |

For a full hardware-substitute rehearsal, follow the normal UI setup above,
choosing a regular monitor as **Output display**. Do not select the primary
display or reuse that monitor as **Demo display**. A browser tab displaying the
client app alone is not the synchronized Desktop demo runner.

There is no approved single-screen preview feature in this release. Adding one
would require an explicit design decision about output placement, controls,
playback approval and keeping test mode separate from recording.

### Focused manual acceptance checklist

Perform these checks outside a recording. Do not run agents or modify shared
business data to manufacture evidence.

1. Open the correct script and demo, verify the expected first screen, and
   confirm the text output is paused at the beginning.
2. Start playback with the control allowed for that build. Confirm a cue
   changes tabs, scrolls and points at the named content, rather than only
   clicking the top-level heading.
3. Pause partway through and resume. The selected record and unfinished cue
   sequence must remain consistent.
4. For Workforce, check Tools, open the configuration assistant, inspect only
   its introduction and empty field, then confirm the next section closes it
   and selects **Evals**. Point at the actual recorded case; do not press Run.
5. Partway through the demo, select **Stop & reset**. Confirm text progress is
   zero, the demo returns to its starting screen, and playback stays paused.
   Play must not start while the demo reset is still loading.
6. Play again and confirm early cues run again. Reset while a cue is in flight
   as well: no delayed click from the old run may reach the new demo.
7. Close the demo and use Stop & reset on narration only. It must not create
   a new demo window.

Full automated release checks, when explicitly releasing, are:

```powershell
# From each respective directory:
# knowledge-hub-backend
npx tsc --noEmit
npm run test:isolated
npm run build

# knowledge-hub-web
npx tsc --noEmit
npm run test:isolated
npm run build

# athena-desktop
npm run typecheck
npm test
npm run test:elgato
```

The isolated web/backend runners remove local integration credentials and use
test fixtures. Never substitute a live shared database for these checks.
Development-time suite execution remains prohibited by repository rules;
perform only the allowed typechecks/direct inspection while developing.

## Stop, reset and recovery

| Control or event | Effect |
| --- | --- |
| Pause | Holds live narration/cues. Does not rewind. |
| Stop & reset, Desktop 0.1.25 | Rewinds the text output, cancels in-flight demo work, and reopens an already-open demo at its initial screen with its cue cursor and retained record pair cleared. Remains paused; Play is blocked until loading completes. Does not open a demo if none was open. |
| Open demo | Recreates the demo/cue runner. It is not a segment-resume command and does not by itself rewind an already-active prompter snapshot. Use Stop & reset for a synchronized restart. |
| Stop presenting | Closes presentation output and its associated demo. Saved note and main application remain. |
| Missing target | Pauses with the actual error. Do not repeatedly press Play until the target problem is understood. |
| Desktop close/restart | Loses exact live cue position. Saved script/plan and reading/display settings remain. Reopening does not promise to resume the interrupted segment. |

If a target fails during recording, leave the presentation paused and preserve
the windows while diagnosing it. Identify the exact failed target and current
script before changing anything. A safe, explicitly approved in-place recovery
can retain the live cursor; restarting the process cannot. There is no general
UI “resume from section” or arbitrary cue-seek command in this release. If the
session has been closed, agree a pickup/segment workflow before modifying any
saved narration or plan.

### Configuration-assistant incident and permanent fix

The 13 November Workforce recording stopped at
`workforce-configuration-intro`, before Evals. Desktop had not exited: the
walkthrough correctly paused when its locator could not find the panel.
The assistant panel uses HTML `id="agent-configuration-assistant"`; the old
locator incorrectly looked for `data-demo-id` with that value.

With approval, the missing marker was added only to the already-open panel.
The introduction and close-button targets were checked without submitting a
request, restarting Desktop or changing the saved script. Playback subsequently
reached the end without another demo error, and the demo returned to Composition
& Flow / Stage overview. This was a temporary live workaround, not a persistent
product fix or a claim that the earlier full run had been uninterrupted.

Desktop 0.1.25 instead uses the panel's real HTML ID consistently for open,
introduction and close cues. It retains the empty-input guard. The separate
Stop & reset repair resets both outputs and guards against stale asynchronous
actions advancing the new run.

## Local environment and boundaries

The established paired local setup is:

| Service | Address |
| --- | --- |
| Client-demo frontend | `http://localhost:5173` |
| Client-demo backend | `http://localhost:3000` |
| Athena frontend | `http://localhost:5174` |
| Athena backend | `http://localhost:3001` |

The current Desktop demo runner deliberately opens the client app on localhost
5173, even when Athena itself loads its hosted website. Deploying Athena does
not deploy or start that separate client-demo application. Do not replace this
origin with Athena's 5174 origin or an assumed production URL.

Start Athena Desktop's main experience at the Athena origin, then open
Presentation through its menu. Starting its main window directly at `/present`
can produce a second page that looks like the controller but is not authorised
to enumerate displays/control presentation. Use the real menu-created
controller; do not infer missing hardware from that rejected window.

Use an isolated user-data profile for development, keep local background workers
and automatic delivery disabled, and leave installed Athena/its Stream Deck
pairing alone. The local Athena backend uses the shared production database:
normal saved-note edits are real persistent edits, not a disposable preview.
Do not reset or rewrite data as part of a recording reset.

The Workforce cues may open tabs, search/filter, disclose read-only details and
show existing evidence. They must not activate Edit Agent, Generate Spec,
Recruit/Update, Run evaluation, or send Test Chat/configuration requests.
Opening the configuration assistant shows only its introduction and empty
request field; it must never request or apply a proposal.

For an approved dev shutdown, stop only the identified isolated Desktop and
the four local services above. Preserve installed Athena and its bridge on
port 43129. Do not use process-name-wide termination or close unrelated windows.

## Release boundary

Web/backend deployment updates the hosted UI and protected saved-script tools.
Desktop fixes require the separate versioned installer/release; rebuilding or
deploying the website cannot replace code in an existing Desktop process.
Publish the compatible Desktop release and install/restart it outside recording.
Do not silently restart installed Athena to apply an update.

The 0.1.25 release also moves both backend Docker stages to `node:22-slim` and
the backend engine requirement to Node 22 or later, with explicit user approval.
It retains Container Apps, port 3000, existing resources, authentication and
worker configuration; this is not an infrastructure or data migration.
