# Stream Deck and Elgato Prompter

Athena Desktop 0.1.8 provides a paired, local Stream Deck connection and a separate
presentation output. The Prompter is treated as a Windows display, not an image
sent to Camera Hub. Any saved Think note can be used as a text script.

## Installation

The hosted frontend must include the new Presentation view, and the desktop
must be upgraded to 0.1.6 or later for direct presentation and saved settings. Neither installation alone is sufficient.
Changes are not automatically deployed or released by building the artifacts.

The main-workspace Speak routing, fresh command-readiness handshake and
**Stop presenting** action require Desktop 0.1.8, plugin 0.1.2 and the matching
hosted frontend together. They are not features of the older 0.1.7 desktop.

Build the desktop installer with `npm run dist` in `athena-desktop`. Its output
is `athena-desktop\release\Athena Setup 0.1.8.exe`. This follows the existing
installer/signing configuration; it does not publish an update.

The local artifact built for this change is
`athena-desktop\release\elgato-package-0.1.8\Athena Setup 0.1.8.exe`. If Electron
extraction is locked on Windows, build without touching a running app:

```powershell
npm run dist -- --config.electronDist=node_modules\electron\dist --config.directories.output=release\elgato-package-0.1.8
```

In `athena-streamdeck`, use Node 24 or newer, then:

```powershell
npm ci
npm run typecheck
npm run pack
```

The package includes a project-local Node 24 development binary, so npm scripts
also work on a host whose global Node is older. Install the resulting
`dist\com.themicrosoftcloudblog.athena.streamDeckPlugin` by opening it in
Stream Deck 7.1 or later. No Marketplace account is required for local use.
The plugin is Windows-only; it does not replace or modify existing profiles.

## Choose your output

1. In Athena Desktop, select **Athena > Presentation and Stream Deck**, or
   select any saved note. This menu remains available for changing settings.
2. Put the Prompter into Windows extended-display mode. Stop Camera Hub output
   if it is covering that display.
3. Select the Prompter in **Output display**. Use **Identify** to confirm the
   physical screen; do not assume the first external display is the Prompter.
4. Select **Open script on display**. The script opens paused. Control it from
   this presenter window or the assigned Stream Deck keys.

Setup is only required once. **Present** on a selected Think note opens it
directly on the saved display, without the controller popup. It starts paused;
Play, Pause and Stop reuse the loaded script without reloading it. Repeating
Present on an unchanged, already-open note keeps its playback and position.
If the saved display is missing, Athena reports it rather than choosing another.

The monitor, speed, text size, mirror, flip, opacity and last selected note ID
are remembered across desktop restarts. Script content is not saved to desktop
configuration: reopening the controller selects the last note and fetches its
saved content after sign-in. Press **Play** to open it on the remembered display
and start reading; no separate reload or monitor selection is needed.
Use **Open script on display** to explicitly replace a live script after edits.
The controller has a visible vertical scrollbar to reach all settings and pairing.
**Output opacity** adjusts the entire Prompter window from 20% to 100%, initially
100%; it does not change the controller.

The controller uses Athena's normal dark Carbon styling. Output is only
high-contrast text with a reading guide, never editing tools, sign-in pages or
notifications. Output margins scale with the screen. Mirror and vertical flip
are off by default: enable them only if your display driver has not already
corrected the orientation.
The primary display is reserved for presenter controls; choose a separate
extended display for output.

The script is a saved snapshot. **Reload saved script** pauses playback and
refreshes the preview; **Open script on display** explicitly replaces the
output. It never silently updates while you are reading. Tables become text
rows, inline links retain their text, and media is represented by captions
where available, with a visible notice. Unsupported or empty scripts show an
error rather than opening a blank success state.

Note scripts use one line break between saved blocks, without inserting an
extra blank line. Explicit empty blocks and hard line breaks are retained, so
spacing follows the saved note. Bold, italic, underline, strikethrough and code
formatting are preserved in both the preview and output; list markers and nested
indentation remain visible. Headings retain emphasis without enlarging the
prompter's chosen text size. Formatting introduces no paragraph/list margins.
The output constructs text spans from validated style names, never note HTML.
These output-formatting changes require Athena Desktop 0.1.9 or later;
older desktop versions continue to receive a plain-text script.

## Script-linked browser visuals

Script notes in Think have an optional visual layer on their existing section
cards. Toolbar actions use compact Carbon icons with tooltips and accessible
labels; the Block style label and selector remain visible. Actions fit on one
row when space permits and wrap rather than overflow in narrow editor panes.
The toolbar and section cards share aligned outer edges and the same editor
gutter. Carbon tooltips describe every icon on hover or keyboard focus,
including disabled actions.
Section bodies do not draw BlockNote's nesting guides merely because their
text belongs to a card; genuinely nested lists retain their indentation and guides.
Backspace removes a bullet normally, then joins paragraphs within the same
section rather than lifting them out of the card. It stops at the first body
block; genuine nested lists retain the editor's normal unindent behaviour.
**Generate visuals** asks Ariadne, using the existing **GPT-6 Astra
Responses** route, to compose scenes without rewriting the spoken script.
Concepts, relationships, processes and key messages take priority over narration
repeated on screen; bullet lists are exceptional. New scenes use typed, layered
Carbon g100 compositions: large symbols, image subjects, short labels and
animated directional connections. The old templates remain readable for existing
saved scenes, but do not constrain newly composed visuals.
Unboxed actors, imagery and connecting lines are the default; panels are reserved
for meaningful groupings or boundaries. New or revised panels share a validated
360×280 footprint and 24px padding; comparable unboxed actors use matching
340×240 footprints, icon scale and spacing across scenes. Each unboxed actor's
icon and text are centred together horizontally and vertically within its footprint.
The visual brief targets 12–24 visible words per scene, with an enforced ceiling
of 36. At 1600×900, headlines are 64px, primary labels 40px and secondary labels
32px; the whole composition scales together. The talk track stays in the script.
Supporting editorial illustrations use the existing one-pager deployment
**`gpt-image-2.5-sunburst`**, at
`https://aif-foundryiq.services.ai.azure.com/openai/v1/images/generations`.
Azure Identity uses the signed-in CLI locally or a supported deployment identity
with access to that resource (`https://ai.azure.com/.default`). No new provider,
model resource or image SDK is required. Deployment identity access must be
configured before enabling generation on another host; failures are explicit.
Production uses the `kh-prod-api-vnet` system-assigned identity, with
**Cognitive Services OpenAI User** scoped only to the existing `aif-foundryiq`
account in `rg-foundryiq` (`sub-ibmc-projImagine-dev`). Local authentication
continues to use the signed-in Azure CLI account; no model keys are added.
Images contain no presentation typography. They are stored through Athena's
existing private `kb-images` storage and registered in the image library, with
an independent pixel-based visual description available to Athena alongside the
separate generation brief. If image analysis fails, generation reports failure
rather than claiming Athena has seen the image. Existing
URLs are reused unless a new illustration is requested. Generation is bounded to
two distinct new image prompts per section, no image retries, one corrective
Astra response, and a seven-minute total budget. Both model routes record usage.
The existing vision reader records its own usage separately.
No model-generated HTML, executable markup, arbitrary CSS or SVG paths are run.
An initial generation starts with an illustrated title scene. Each scene keeps
its own headline, while a consistent footer shows the script title and its
scene number across the whole script (for example **03 / 12**).

The visual language also includes cue-driven highlight, underline and strike-through
emphasis; directional, scale and wipe entrances; drawn connectors; and a single
travelling token for a process handoff. Directed arc connections can describe a
lifecycle returning to its start. All builds use the existing spoken-block cues,
not recording timestamps. Reverse reading hides later builds again. Motion is
bounded rather than perpetually looping, and reduced-motion preferences remove
transitions and travelling tokens. Existing saved scenes remain readable unchanged;
regenerate or request a revision to use the new visual vocabulary.

**Presenter layout** is a pressed-state icon in the sticky script toolbar,
available once visuals exist. It defaults off (full-frame). Turning it on updates
all existing section scenes through normal note editing/autosave and undo, without
changing spoken text or cue positions. The shared preview and audience renderer
scale the composition to the left, show the chapter and key takeaway at upper
right, and leave the lower-right area clear for an externally composited camera
feed. Athena does not capture or embed video. The mode is saved with each scene,
visible to Athena's existing read/design tools and retained during visual redesign.
Changing it does not replace an already-running saved presentation snapshot.

Each section shows its visual preview. **Play preview** demonstrates its scenes
and reveals independently of the teleprompter; it does not start live playback.
Viewing, reviewing and playing these previews works in the normal web app
without Desktop or an Elgato device. The illustration renderer is shared with
the audience output, including its titles, footer and numbering.
**Ask Athena to update** opens the existing Think Athena panel, with the section
and scene identified. Athena can read full saved scenes and cues with
`read_script_visuals` and ask Ariadne for bounded revisions with
`design_script_visuals`. Edits use the normal protected live editor, history,
undo, revision conflicts and save receipts. A changed spoken section marks its
visuals stale rather than silently moving cues or overwriting a draft.

Use **Present** first, then **Open browser visuals** in the script toolbar or
Presentation controls. Share that browser window in Riverside. The
script toolbar includes **Present** and **Stop presenting** icons with
tooltips, alongside the existing Actions menu entries. Stop closes the output
without closing the note; these controls are absent in the normal web app.
The actual Prompter reading line drives scene and reveal cues through exact spoken-block
anchors, including wrapped lines, font changes and reverse wheel scrolling.
Pause holds the current scene; Stop resets it. Preview timings do not control
live playback. Script and visuals are a saved snapshot; editing does not replace
live output.

Live Elgato synchronisation requires Athena Desktop **0.1.12 or later**, advertising the `scriptVisuals`
capability and, for layered scenes, `scriptVisualCompositions`, plus the matching
backend/frontend. An older installation reports
the update requirement instead of pretending to synchronise. No Stream Deck
plugin change is needed. The feature is not installed merely by updating the
hosted site.
The motion vocabulary and presenter layout additionally require Desktop **0.1.13 or later** and its
`scriptVisualMotion` capability. Older installations report an update requirement
instead of silently dropping those scene properties.

The audience page uses an independent read-only HTTP/SSE server bound to
`127.0.0.1` on an ephemeral port, with a fresh unguessable path for each output
session. It validates Host and Origin, sends no CORS permission, disables
caching/referrers and has no commands, note API or desktop credentials.
It works only on the same computer. It does not weaken the existing paired
Stream Deck bridge. Closing/disconnecting the output or quitting Desktop closes
the local server; the browser holds its last scene and reports disconnection.
Open the browser output again after reopening a presentation. Existing HTTPS
scene images are loaded by the browser; only source URLs or trusted persisted
Sunburst output may enter a generated plan. Connections and subjects reveal
against the same spoken anchors and reverse when the reading position reverses.

## Pair Stream Deck

In the presenter window, select **Enable & copy pairing key**. Add any action
from Stream Deck's **Athena** category to a key, paste the key into its property
inspector and select **Pair with Athena**. The key is saved once for all actions.
The inspector displays the connection state and action errors.

The desktop's key is encrypted with Windows credential storage. The plugin
stores it in Stream Deck's user-local global plugin settings, not in a profile
or the repository. Treat it as a credential. **Disable** stops the local
connection and revokes it; **Replace pairing key** requires re-pairing.
The local bridge uses authenticated HTTP on `127.0.0.1:43129`. It is not exposed
to the network, rejects browser-origin requests and has no arbitrary command,
file or shell endpoint. It does not protect against malware already running as
the same Windows user.

## Actions and suggested key layout

Drag the actions onto any existing or new Stream Deck profile. A suggested
15-key layout is shown below; no model-specific profile is automatically
installed or switched.

| Row | Keys, left to right |
| --- | --- |
| 1 | Open Athena, New note, New diagram, Speak to Athena, Present note |
| 2 | Play, Pause, Stop and reset, Slower, Faster |
| 3 | Smaller text, Larger text, Play / Pause, spare, spare |
| Optional | Stop presenting (closes the output rather than resetting playback) |

**Speak to Athena** focuses the main application and reveals the current page's
existing Athena panel without changing pages or opening the separate chat window.
In Think, select a note or canvas first. Hidden or detached chat panels cannot
intercept the key. The second
press stops recording, transcribes and sends the message to Athena, including
any existing draft. If chat is busy or has an attachment, the transcript stays
in the draft with an error explaining that it was not sent. First use may require microphone
permission in the main Athena window. Existing on-screen voice behavior is
unchanged for recordings started with its microphone button.

**Present note** uses the current Think note, or opens the note picker when no
note is selected. Notes and diagrams use their existing creation flows.
Playback keys never focus the output window. Keys display playback/recording
state and relevant speed or text size. Plugin 0.1.1 limits the playing highlight
to Play, Play / Pause and Stop; other shortcuts keep their normal icons.

Present requests that Windows wakes sleeping displays before opening output.
This is a system display-wake request, not Elgato hardware power control: the
Prompter must still be connected, enabled as an extended display and physically
powered on. Windows execution-state signalling requests display wake without
waiting for a broadcast acknowledgement from every application. If that request
fails, Athena logs a warning and still opens output on the confirmed connected
display; wake failure does not mean the screen is switched off. Desktop 0.1.7
corrects the blocking wake-error behaviour in 0.1.6.

Presentation scrolling is manual only. Speed defaults to 80 output CSS pixels
per second, bounded to 10-300 in increments of 2. Faster/Slower change actual
playback speed, not the current line. Text size is 24-96 in increments of 4.
Pause retains position; Stop resets to the beginning; reaching the end stops.
**Stop presenting**, available beside **Present** in a Think note's Actions menu
and as its own Stream Deck action, closes the output window while keeping the
note and main application open. It preserves the display settings and does not
replace Stop/reset. Use Present to reopen the output.
The legacy standalone browser Autocue (`/autocue`) has been removed; the Elgato presenter is the only teleprompter.

## Failure and reconnect behavior

- Athena Desktop must be running and signed in. Disconnected button presses
  are rejected, never queued or replayed after reconnection.
- Desktop requests a fresh acknowledgement from the mounted main-app command
  receiver on every action, rather than relying on a ready flag from before
  navigation. Sign-in and command timeouts remain explicit failures.
- If the Prompter disconnects, output closes and playback stops. Refresh
  displays, confirm the reconnected screen and reopen the same unchanged script
  to retain the last reported position. Press Play explicitly.
- Closing the source window, leaving its view, signing out or an output-renderer
  crash closes its output. Closing a separate settings window does not close a
  presentation started directly from Think. The display is kept awake only
  during active playback.
- If port 43129 is unavailable, setup reports the error. Do not terminate
  unrelated processes; resolve the port conflict before enabling pairing.
- Failed creation commands are not retried automatically. Check Think before
  retrying if an acknowledgement timed out.

## Focused verification

Use `npm run test:elgato` in `athena-desktop` for command validation, local
authentication/deduplication and output playback. Frontend script tests are
`knowledge-hub-web\tests\presentation.test.ts`. Run application and plugin
typechecks and `npm run validate` for the plugin.
`npm test` in `athena-streamdeck` exercises the actual packaged SDK process
against a simulated Stream Deck host and the authenticated local bridge,
including reconnect without replay. It needs the desktop TypeScript build.

Windows and Electron have reported the user's Elgato Prompter active; Electron
identifies a 1024 x 600 output. Physical
output placement, orientation and button presses still require a user-approved
hardware trial; automated tests and plugin packaging are not proof of those.
