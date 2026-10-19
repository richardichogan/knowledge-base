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
