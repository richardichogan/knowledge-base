---
applyTo: "knowledge-hub-backend/src/ai/**,knowledge-hub-backend/src/routes/ai.ts,knowledge-hub-backend/src/types/aiContext.ts,knowledge-hub-web/src/pages/AIChatPage.tsx,knowledge-hub-web/src/types/ai.ts"
---

# Athena AI persona architecture

- Athena (the in-app AI assistant) supports multiple selectable personas, defined in `knowledge-hub-backend/src/ai/contextBuilder.ts` (`PERSONA_PROMPTS` — persona id → system prompt blurb) and mirrored in the frontend persona switcher in `knowledge-hub-web/src/pages/AIChatPage.tsx` (`personaSwitch`).
- Current personas: `general` (default operational assistant), `brainstorming` (ideas sounding board / critique), `copilot_coach` (guide on using GitHub Copilot itself — agents, skills, extensions, workflows).
- Model routing lives in `knowledge-hub-backend/src/routes/ai.ts` — the `brainstorming` persona defaults to the `gpt-5.5` model (a separate Azure AI Foundry resource — `imagine-dev-temp-resource`, see the deployment runbook in the root `copilot-instructions.md`); other personas use the default model.
- Tool-calling loop and available tools (KB search, task/note actions, `fetch_web_page` external-URL grounding, Microsoft Learn MCP tools) live in `knowledge-hub-backend/src/ai/chatTools.ts` / `conversationService.ts`.
- When adding a persona:
  1. Add its blurb + `PERSONA_PROMPTS` entry in `contextBuilder.ts`.
  2. Add its `AthenaPersona` union member in both `knowledge-hub-backend/src/types/aiContext.ts` and `knowledge-hub-web/src/types/ai.ts`.
  3. Add a button to `personaSwitch` in `AIChatPage.tsx` — remember the floating-widget/compact view is narrow (400px), so new buttons need the `.kh-persona-switch__label` span pattern to collapse to icon-only there (see `.ai-new-chat-row--compact` in `global.scss`) rather than causing wrap/scroll.
  4. Decide whether it needs a non-default model (only do this with a deliberate reason — extra Foundry resources cost money and add routing complexity).
