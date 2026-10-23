# Athena mark integration

The October 2026 "Friendly chatbot animation design" handoff supplies the
four-quarter custom element and static assets. Its `athena-mark.js` is copied
unchanged into `knowledge-hub-web/public/athena/`, with no animation dependency.
The React 18 wrapper passes attributes and a ref for live microphone levels.

## Behaviour

- A 28px mark rests above the composer, with 30% movement clearance.
- Typing enters listening/text; no further keystroke for 1.5 seconds returns
  it to rest. Focus alone does not start the animation.
- Recording enters listening/voice only after microphone access succeeds.
  PCM RMS levels from the existing recorder feed the mark, including silence.
- Sending enters thinking immediately. Successful fast replies keep a minimum
  400ms thinking period. Activity changes do not restart the thinking loop.
- The wrapper travels into the next reply's left column over 400ms with Carbon
  expressive easing. The supplied element handles the internal shape morph.
- Accepted answers grow a surface from 72px using transforms over 400ms.
  Content rises 16px in 100ms stagger steps. After the entrance and a 600ms
  hold, the mark returns home over 500ms. Each answer retains the supplied
  27px mark at 55% opacity.
- Long-running requests add one "Still working..." helper after eight seconds,
  preserving the actual tool/activity status.
- Errors and cancellation return home without answer choreography. Restored
  history does not replay answer entrances.
- Hidden/offscreen marks pause. Reduced motion gives static poses, immediate
  placement changes and a 150ms answer fade, without changing OS preferences.
- The working status and reply-completion live region provide announcements;
  the decorative custom element uses `silent` to avoid duplicates.

## Intentional adaptations

**Accepted replies, not the first raw token.** The server can discard provisional
model rounds during tool use or evidence repair. Those chunks remain hidden.
Answering begins when the turn returns an accepted reply. The current protocol
does not expose safe partial answers on interrupted streams, so a partial card
is not fabricated. Existing stopped/error feedback is preserved.

**Existing input model.** Athena currently allows one foreground request at a
time. This change does not introduce parallel sends. Repeated thinking updates
retain their clock, and subsequent turns target their own reply slot.

**Desktop packaging.** Browser/PWA icons, the chat sidebar logo, chat welcome
mark and the header's Athena launcher use the new assets. The Electron window
loads the same hosted chat. Installed Electron executable/installer icons have
not been rebuilt or released.

**Unchanged product behaviour.** Models, personas, tools, saved conversations,
source controls and Outputs remain intact. There are no new network services,
runtime dependencies or system settings.

## Changed files

All paths below are repository-relative:

- `knowledge-hub-web/src/chat/athenaMotion.ts`: state mapping, placement clocks,
  expressive easing, real voice-level calculation and timing constants.
- `knowledge-hub-web/src/components/athena/AthenaMark.tsx`: React 18 adapter.
- `knowledge-hub-web/src/components/athena/AthenaPresence.tsx`: mark placement,
  visible-state lifecycle and reply announcement.
- `knowledge-hub-web/src/components/athena/ChatBubble.tsx`: measured transform
  growth for accepted answer surfaces.
- `knowledge-hub-web/src/components/athena/LiveReply.tsx`: long-wait helper.
- `knowledge-hub-web/src/pages/AIChatPage.tsx`: typing timeout, PCM levels,
  minimum thinking time, answer completion and 400ms prompt scrolling.
- `knowledge-hub-web/src/components/AppShell.tsx`: Athena launcher asset only.
- `knowledge-hub-web/src/styles/global.scss`: scoped chat/mark styling.
- `knowledge-hub-web/index.html`: local element script and current icons.
- `knowledge-hub-web/public/manifest.json`: updated PWA icon versions.
- `knowledge-hub-web/public/staticwebapp.config.json`: exclude local mark files
  from the SPA fallback.
- `knowledge-hub-web/public/favicon.svg`, `icon-192.png`, `icon-512.png`:
  supplied icon artwork (192px raster derived from the supplied 512px asset).
- `knowledge-hub-web/public/athena/athena-mark.js`: unchanged supplied element.
- `knowledge-hub-web/public/athena/*.svg`: supplied app icon, listening mark,
  answer/answer-past, mono-black/mono-white, split, thinking and resting marks.
- `knowledge-hub-web/public/athena/png/*.png`: all supplied mark/app-icon sizes
  and split/thinking variants retained as source assets.
- `knowledge-hub-web/tests/athenaMotion.test.tsx`: chat motion/state regressions.
- `knowledge-hub-web/tests/athenaMarkElement.test.ts`: supplied element executed
  in a deterministic DOM/frame harness, including voice, interruptions,
  accessibility, reduced motion and hidden/offscreen pausing.
- `knowledge-hub-web/tests/athena-motion.html`,
  `knowledge-hub-web/tests/athena-motion.browser.tsx`: updated optional browser
  fixture; it is not launched automatically.
- `scripts/run-isolated-tests.mjs`: registers the new element regression tests.
- `DESIGN.md`, `.impeccable/design.json`, `docs/athena-mark.md`: updated design
  reference and integration notes.
