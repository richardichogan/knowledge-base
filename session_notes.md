# Session Summary & Notes

## What We Have Done in This Session

### 1. Projects Page Visual & UI Fixes
* **Removed Carbon Tile Component**: Stripped out the restrictive `Tile` component in favor of plain `div`s with explicit Carbon CSS vars/pixels to fix invisible card layouts.
* **Source Badges**: Added clear GitLab and GitHub icon badges on project cards to indicate their source.

### 2. Projects Database Migration & CRUD
* **Moved to PostgreSQL**: Migrated the existing JSON file store to a fully fleshed out `projects` table in PostgreSQL.
* **Added Metadata Fields**: Expanded project records to include a `category` field (work, personal, side-hustle) and a `priority` field (low, medium, high).
* **Full API Implementation**: Built the backend CRUD routes (`/api/projects`) to support creating and editing local projects accurately without overwriting remote GitHub/GitLab data.

### 3. Notes Enhancements (Project Assignment & Global Tags)
* **Project Linking**: Appended a `project_id` column to the `notes` table so notes can be assigned directly to specific projects.
* **Global Tags System**: Created a `global_tags` table that tracks tag usage. Whenever notes or projects are saved, tags are upserted into this table and ordered by `usage_count`.
* **Tag Autocomplete API**: Added a new GET `/api/tags` route to power autocomplete dropdowns across the frontend.
* **MetadataBar Rewrite**: Refactored `MetadataBar.tsx` on the Notes page to use a ComboBox for project selection, along with a new ComboBox for adding tags.
* **Tag Pills UI**: Added tag pills displaying inside the `MetadataBar` and Projects modal, including an "×" button to remove them. Wrote custom CSS (e.g., `.notes-tag-pills`, `.proj-tag-pills-edit`) to style these neatly.
* **Server Verification**: Successfully restarted the multi-server environment (`concurrently` for Vite and Node/Express) and validated the backend tag endpoints.

### Next / Pending Work (Content Store)
* A large request was queued to integrate `richardichogan/content-store` as a special markdown content repository. 
* This will involve GitHub API checks, parsing `.md` frontmatter, replacing project relationships, and rendering them as read-only synced notes with a Teal Carbon tag.