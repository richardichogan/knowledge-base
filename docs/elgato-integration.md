# Stream Deck and Elgato Prompter

Athena Desktop 0.1.5 adds a paired, local Stream Deck connection and a separate
presentation output. The Prompter is treated as a Windows display, not an image
sent to Camera Hub. Any saved Think note can be used as a text script.

## Installation

The hosted frontend must include the new Presentation view, and the desktop
must be upgraded to 0.1.5 or later. Neither installation alone is sufficient.
Changes are not automatically deployed or released by building the artifacts.

Build the desktop installer with `npm run dist` in `athena-desktop`. Its output
is `athena-desktop\release\Athena Setup 0.1.5.exe`. This follows the existing
installer/signing configuration; it does not publish an update.

The local artifact built for this change is
`athena-desktop\release\elgato-package\Athena Setup 0.1.5.exe`. If Electron
extraction is locked on Windows, build without touching a running app:

```powershell
npm run dist -- --config.electronDist=node_modules\electron\dist --config.directories.output=release\elgato-package
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
   **Present** in Think. Select any saved note.
2. Put the Prompter into Windows extended-display mode. Stop Camera Hub output
   if it is covering that display.
3. Select the Prompter in **Output display**. Use **Identify** to confirm the
   physical screen; do not assume the first external display is the Prompter.
4. Select **Open script on display**. The script opens paused. Control it from
   this presenter window or the assigned Stream Deck keys.

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

**Speak to Athena** opens the dedicated chat and toggles recording. The second
press stops recording and transcribes into the existing draft for review.
It never sends the transcript automatically. First use may require microphone
permission in the focused chat window. Existing on-screen voice behavior is
unchanged for recordings started with its microphone button.

**Present note** uses the current Think note, or opens the note picker when no
note is selected. Notes and diagrams use their existing creation flows.
Playback keys never focus the output window. Keys display playback/recording
state and relevant speed or text size.

Presentation scrolling is manual only. Speed defaults to 80 output CSS pixels
per second, bounded to 10-300 in increments of 10. Faster/Slower change actual
playback speed, not the current line. Text size is 24-96 in increments of 4.
Pause retains position; Stop resets to the beginning; reaching the end stops.
The legacy standalone browser autocue remains available.

## Failure and reconnect behavior

- Athena Desktop must be running and signed in. Disconnected button presses
  are rejected, never queued or replayed after reconnection.
- If the Prompter disconnects, output closes and playback stops. Refresh
  displays, confirm the reconnected screen and reopen the same unchanged script
  to retain the last reported position. Press Play explicitly.
- Closing the controller, signing out of that view or an output-renderer crash
  closes the output. The display is kept awake only during active playback.
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
