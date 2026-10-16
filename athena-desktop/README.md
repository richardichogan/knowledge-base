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
