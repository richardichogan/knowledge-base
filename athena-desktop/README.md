# Athena Desktop

A Windows app (Electron) that opens the hosted Athena site and gives it access to folders you choose on this PC.

- **Index**: files in your chosen folders (PDF, Word, PowerPoint, Excel, CSV, Markdown, text) are uploaded to your Athena library and kept in sync while the app is open. Files that can't be indexed are listed under "N files not indexed" in Documents → Folders on this PC, with the reason.
- **Read**: in chat, Athena can read files in those folders (`read_local_file`).
- **Write**: Athena can propose a change to a file (`propose_local_file_write`). It appears in chat as a diff; nothing is written until you click Apply. If the file changed on disk since the diff was shown, Apply stops and shows the new diff.

Only the folders you add are reachable. Paths are checked after resolving symlinks and junctions, so a link can't reach outside a folder.

## Develop

```
npm install
npm start          # against production (https://athena.themicrosoftcloudblog.com)
npm run start:local  # against the local web dev server on :5173
npm test
```

## Build a signed installer

The code-signing certificate is self-signed and lives in Key Vault `kv-athena-desktop` (`rg-knowledge-hub-prod`). Install it on the build PC once:

```
powershell -File scripts\install-signing-cert.ps1
```

This puts the private key in CurrentUser\My and trusts the certificate on this PC (Windows asks you to confirm the root certificate: choose Yes). Then:

```
npm run dist       # release\Athena Setup <version>.exe
```

On other PCs the installer shows "Unknown publisher" unless the certificate is trusted there too.

## Release (auto-update)

Bump `version` in `package.json`, then `$env:GH_TOKEN = gh auth token; npm run release`. Installed copies pick up the GitHub release on next start.
