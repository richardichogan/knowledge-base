# GitHub Copilot Instructions

These rules apply to every change made in this repository. Follow them without exception.

---

## Styling — MANDATORY

**Every new UI element must be fully styled before the change is considered complete.**

- Every new component, button, input, modal, panel, list item, badge, or icon added to the frontend MUST have corresponding CSS in `global.scss` (or the relevant component SCSS file).
- Never add a raw unstyled HTML element or Carbon component without defining its visual appearance.
- Use existing BEM naming conventions already present in the codebase (e.g. `kh-`, `dc-`, `gctx__`, `kb-modal-`, etc.).
- If a component has interactive states (hover, active, disabled, open/closed), all states must be styled.
- Do not ship a PR or consider a task complete if any element relies solely on browser defaults or Carbon defaults without intentional overrides matching the app's dark Carbon theme.

---

## Terminal Commands — STRICT RULES

- **Never use `head` or `tail` to truncate command output.** Run the full command or use `grep` to filter specifically.
- **Never use `curl` to test endpoints.** If an endpoint needs testing, use the existing API client or logs.
- **Never pipe to `| cat`** just to disable a pager — use `--no-pager` flags where available (e.g. `git --no-pager`).

---

## Server Management

- Before starting servers, always check if they are already running to avoid EADDRINUSE errors.
- Backend: `knowledge-hub-backend` runs on port **3000** via `node --import tsx/esm src/server.ts`
- Frontend: `knowledge-hub-web` runs on port **5173** via `npm run dev` (strictPort: true — will not drift)
- Both must be running for the app to function. If the frontend shows empty data, check the backend first.

---

## Code Changes

- Never break the existing JSX structure of `AppShell.tsx` — it returns a `<>` fragment. Any new providers must wrap at the `App.tsx` level, not inside AppShell.
- Always run `tsc --noEmit` after changes to both `knowledge-hub-web` and `knowledge-hub-backend` before declaring work done.
- Never deploy to production without an explicit instruction from the user to do so.
