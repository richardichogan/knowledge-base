# Mural diagram export

Sources / Integrations (My work -> Sources / Integrations) contains the Mural
connection. Enter the registered client ID, client secret and an individual
board URL. Saved credentials and OAuth tokens use the existing authenticated
AES-256-GCM connection store, keyed by `CREDENTIAL_ENCRYPTION_KEY` or the
existing Graph client secret. These values are never returned to the browser.
Do not rotate that encryption key without migrating saved credentials.

Register this exact redirect URL:

`https://athena.themicrosoftcloudblog.com/integrations/mural/callback`

Enable `murals:read` and `murals:write`. CORS allowlisting is not needed:
provider requests are server-side. Keep the app Private during testing.
Click Connect to Mural and consent using the Mural account that can edit the
destination board. OAuth uses S256 PKCE, a ten-minute, single-use state bound
to the authenticated Athena user, and encrypted rotating refresh tokens.
Configuration and token updates are serialised across backend replicas.

Open a Think diagram -> Export -> Mural image. Check the destination board,
background, grid and annotation options, then click Send image to Mural.
The browser renders through the existing PNG exporter and the backend uploads
to Mural's asset storage before creating an image widget. No automatic sync
or export occurs. Each click adds a new image at (100, 100), without deleting
or updating any existing board content. Move previous images in Mural if needed.
The result provides a link to open the board.

This release exports **one image**, not native editable shapes. It preserves
the selected diagram rendering, including connectors and loaded icons.
Native attached connector creation has not been established in Mural's
documented public API, so this release does not claim editable native export.
Existing PNG, SVG and editable draw.io downloads are unchanged.
PNG limits: 20 MiB upload, 16,384 pixels per side, 64 megapixels total.
Images still loading cause an explicit error instead of an incomplete export.

The board URL field accepts normal app.mural.co individual board URLs,
not workspace lists or visitor routes. Share-token suffixes and queries are
removed; OAuth permissions determine access. The default is the supplied
Athena test board. Users can change the default or override it per export.
This version intentionally uses a board URL rather than requesting workspace
and room access to build another picker.

Disconnect removes Athena's saved OAuth tokens and pending sign-ins but keeps
app settings and existing exported images. Revoke the app in Mural as well
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
