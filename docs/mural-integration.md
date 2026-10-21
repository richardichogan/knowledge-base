# Mural diagram export

Sources / Integrations (My work -> Sources / Integrations) contains the Mural
connection. Enter the registered client ID, client secret and an individual
board URL. Saved credentials and OAuth tokens use the existing authenticated
AES-256-GCM connection store, keyed by `CREDENTIAL_ENCRYPTION_KEY` or the
existing Graph client secret. These values are never returned to the browser.
Do not rotate that encryption key without migrating saved credentials.

Register this exact redirect URL:

`https://athena.themicrosoftcloudblog.com/integrations/mural/callback`

Enable `murals:read`, `murals:write`, `workspaces:read` and `rooms:read`.
Existing connections must reconnect after enabling the new read scopes to
authorise board and room listing.
CORS allowlisting is not needed:
provider requests are server-side. Keep the app Private during testing.
Click Connect to Mural and consent using the Mural account that can edit the
destination board. OAuth uses S256 PKCE, a ten-minute, single-use state bound
to the authenticated Athena user, and encrypted rotating refresh tokens.
Configuration and token updates are serialised across backend replicas.

Open a Think diagram -> Export -> Mural. Choose the destination from the
board dropdown, grouped by workspace, and check the
annotation options, then click Send editable diagram to Mural.
Choose **Add to existing Mural** to append to a selected board, or **Create a
new Mural** to select a room and enter a name (initially the diagram title).
Click **Create and select Mural**, then send the diagram when ready.
Mural requires room-owner permission to create a board. Athena does not create
rooms or change visitor/sharing permissions. Board creation is never retried:
if the response is lost, inspect the room before explicitly allowing another
attempt. Once creation succeeds, the new board stays selected even if the
subsequent diagram export fails; no extra board is created on export retry.
Shapes, text, connector labels, footnotes and colour-key entries become native
editable Mural objects. The backend creates shapes first and connects arrows
using the returned Mural widget IDs (`startRefId` / `endRefId`).
Containers and swimlanes become native areas, expanded; nested area coordinates
are translated to parent-relative positions. Their built-in Mural titles are hidden;
editable text objects retain Athena's header positions inside their parent areas.
Exported boxes use transparent backgrounds rather than copying saved dark fills,
and pale label text becomes dark for readability on the board. Borders keep their
saved colours; Athena's original diagram and other export formats are unchanged.
Shapes explicitly retain their font size and alignment (including numbered
badges) through the shape API's `htmlText`, rather than sending unsupported
`font`, `fontSize` or `textAlign` shape-style properties. Text boxes allow
extra height for wrapping and padding; exported footnotes move down within
their column when needed so expanded text does not overlap the following note.
Descriptions and AI-step summaries
are retained as widget instructions. Individual icons remain separate images,
not editable vector paths; the diagram itself is never flattened.

No automatic sync or export occurs. Each click adds a new copy, with the content
origin positioned at (100, 100), without deleting or updating existing content.
The result links to the board. Mural may adjust shape typography, alignment,
border styling and routing; automatic line jumps are not transferred. Dashed
shape borders become solid (dotted borders remain dotted). Connector arrowheads,
routes, endpoint attachments and labels use Mural's native arrow model.
The source remains editable independently in Athena; changes do not sync back.
Existing PNG, SVG and editable draw.io downloads are unchanged. The earlier
image-upload API remains available for compatibility but is not the diagram UI's
Mural export path.

After export, **Share Mural link by email** opens a manual review-and-send
composer. The Export menu also supports emailing a draw.io attachment without
exporting to Mural. Neither action sends automatically; see
[SMTP2GO sharing](email-sharing.md) for sender setup and access requirements.
The Mural email composer offers View/Edit recipient invitations before sending,
or a link-only option. It does not make the board public.

Native export validates all objects before writing. Limit: 200 objects in total,
including connectors, icons and selected annotations, with 20 MiB of icon PNGs.
Images still loading cause an explicit error instead of an incomplete export.
Requests are sequential to bind each returned object ID unambiguously; exports
may take longer on large diagrams. External writes are never retried. On any
partial failure, inspect the board before retrying: some objects may exist.

The board URL field accepts normal app.mural.co individual board URLs,
not workspace lists or visitor routes. Share-token suffixes and queries are
removed; OAuth permissions determine access. The default is the supplied
Athena test board. Users can change the default or override it per export.
The board dropdown lists all boards the connected account owns or belongs to
across its workspaces, following every pagination token. Archived boards are
shown but cannot be selected for export. Refresh boards reloads the list.
Enter board URL remains available for boards not returned by the account's
workspace membership or while reconnecting. Listing errors are explicit;
Athena never presents a partial list as a complete result. The same picker
is available when editing the default destination in Sources / Integrations.

Disconnect removes Athena's saved OAuth tokens and pending sign-ins but keeps
app settings and existing exported objects. Revoke the app in Mural as well
to withdraw provider-side consent. Changing client credentials invalidates
the existing Athena connection. A saved connection indicates prior consent,
not a live permission check; export reports expired/revoked access explicitly.
After an ambiguous timeout, inspect the board before retrying to avoid duplicates.

The callback is a frontend route, served by the existing SPA fallback. It
scrubs the query before auth initialisation and posts the code/state to an
authenticated backend endpoint. No new Azure resource, secret environment
variable, database migration, or dependency is required. A real-account OAuth
and export check requires the user's client secret and consent after deployment;
automated tests use isolated storage and mocked provider calls.

References:
- https://developers.mural.co/public/docs/oauth
- https://developers.mural.co/public/docs/how-to-upload-an-image-to-a-mural
- https://developers.mural.co/public/reference/createimage
- https://developers.mural.co/public/reference/createshapewidget
- https://developers.mural.co/public/reference/createarrow
- https://developers.mural.co/public/reference/createarea
- https://developers.mural.co/public/reference/createtextbox
