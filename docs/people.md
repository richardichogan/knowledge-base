# People

Open **Tools / People** to search, add, edit or delete contacts. A contact holds
their name, email aliases, organisation, role/relationship, topics and notes.
Email-report imports also retain the source, period, contact group and email
count. Counts are historical snapshots, not a live mailbox connection.

Choose **Import contact report** and select a Markdown report with tables
containing `Name`, `Email` and `Organisation` columns. `Main threads` (or
`Main thread`) and `Emails sent to them` are optional. Review the preview before
saving. Duplicate names within a report are combined; addresses are normalised
and retained as aliases. Existing contacts match by email, or name and
organisation. Reimporting replaces the snapshot count, not adds it. Existing
hand-written notes and roles are kept. Conflicting matches fail the entire
import rather than silently merging different contacts.

Contact reports are imported into the authenticated backend database.
Migration `085_people.sql` creates the table. Migration `086_people_seed.sql`
loads the 40 people from *Key Email Contacts – Last 2 Weeks* (5–19 October 2026)
once, on the next backend startup. It skips anyone already present (matched by
email or name), so later edits are never overwritten. The contact data lives
only in the backend database and its migration, not in the website bundle.

## Mentions

- In a Think note, type `@` followed by a person's name, email or organisation.
  Select a **Person** result to insert a stable entity mention, with a preview
  and a link to their People record. Renames resolve automatically; deleted
  contacts show as unavailable. Notes mentioning people are indexed for backlinks.
- In Athena chat, type `@` and start the name. Use the arrow keys and Enter/Tab,
  or click a result. The inserted Markdown link stores the person's stable ID.
  On a chat turn the backend resolves up to ten explicitly mentioned contacts
  from the current message and recent user turns, providing current contact
  details and the report period to Athena. Existing project `@mentions` still
  work and do not consume person links.

The page is also reachable at `/people?personId=<id>`.

## Companies and programme representation

Open **Tools / Companies** for dedicated company pages. Record a description,
website and programme/project links. People and Companies pages link to each
other; they are not special kinds of notes.

On a person page, choose **Edit relationships** to link their company and add
programme-specific roles. Each role can explicitly name the company they
represent. For example, Candela can be linked to BCG and recorded as BCG's
representative on Reckitt. A person's general role and legacy organisation
text remain separate and unchanged.

In notes or Athena chat, type `@` and a name to select an existing person/company
or choose **Create person** / **Create company**. Creation inserts a stable link
without leaving the editor. Existing exact matches are offered instead of a
duplicate creation action. Edit the new page to record its relationships;
Athena does not infer them from the note or project where it was created.

Company mentions support previews, note backlinks and exported links. Chat
mentions resolve saved company details and explicitly recorded programme roles
on the server. The company route is `/companies?companyId=<id>`.

Migration `093_company_people_relationships.sql` is additive. It does not
convert organisation text into company links or seed any company/person roles.

## Diagram and image controls

Diagrams now offer live edge/centre alignment guides, including during resizing.
New standard Process, Document, Container and Swimlane shapes start with no
background fill instead of a dark neutral background. Coloured defaults and
AI-flow presets are unchanged. Existing shapes retain their saved colours;
use the fill controls to apply a background when needed.
The default grid spacing is 10 units; use the spacing selector for 5, 10, 20
or 40 units. Hold Alt to bypass snapping and guides. The saved spacing is
retained in SVG and draw.io exports. Standard diagrams also offer the existing
Specialist Agent preset directly from their palette.

New diagrams keep a stable URL so refresh does not return to Notes.
The drill-down icon sits at the top-left of a shape, leaving the top-right
available for its footnote marker.
Drill-downs keep the same Athena conversation and draft, carrying parent/project
context while the child diagram is active. Closing restores the parent's
context. Popups use the browser top layer rather than being clipped by the
diagram sheet or drill-down container.

Paste into diagram property text fields uses readable text from rich clipboard
content, rather than HTML or serialized editor blocks. Canvas object paste
continues to use its structured diagram format.

Double-click a note image, or use its context menu's **Open image full screen**.
For a diagram image, select it and use **Open image full screen** in Properties.
The viewer has zoom, fit, Copy image and Escape/Close controls. Stored note images
are copied through the authenticated API, avoiding blob CORS or expired-SAS
failures; copying does not write image or note records.
