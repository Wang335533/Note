# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

## Durable product decisions

- The user selected concept 1, “一页今日”, as the visual and interaction direction.
- The main card stays intentionally sparse: date, progress, 今日三件, 今天, 已完成, one quick-entry field, and save status.
- Advanced controls belong in the tray, keyboard shortcuts, or an in-card settings sheet rather than the default card.
- The workday changes at 04:00. Unfinished tasks are reviewed instead of silently rolling over.
- The app is local-first and must save every mutation immediately. Desktop and temporary always-on-top modes are both required.
- Task time ranges are optional, use 24-hour time in 15-minute increments, may overlap or cross midnight, and never change manual task ordering.
- Time selection stays collapsed behind a clock affordance and opens as a compact two-column popover; it requires explicit confirmation, rejects equal start/end values, and resets after each successful task creation.
- Existing task times can be edited or cleared. Untimed tasks show no time metadata; completed tasks strike only the task text while the time label merely fades.
- Motion should feel localized and restrained. Focusing or clicking inside Note must not animate or scale the entire card.
- Renderer state may accept an equal revision for newer runtime information, but must never move back to a lower persisted revision.
- Browser preview behavior must stay aligned with the desktop Store, including validation, rollover, ordering, and visible fixture data; preview-only hidden tasks are not allowed.
- Desktop and browser preview must call the single Store in `shared/store.cjs`; `src/api.js` only owns browser fixture, localStorage, events, and download adaptation.
- Empty or invalid operations are rejected without changing revision or writing state.
- If a requested Windows window layer fails, Note falls back to normal-window mode, persists that fallback, and shows a compact non-modal warning in settings.
- Local diagnostics contain technical failures only, never task text. Keep `note-error.log` at or below 512 KB with at most one `note-error.log.old` rotation.
- Releases contain only the directly runnable directory and the NSIS installer. Do not ship a self-extracting portable build because its extraction delay is easy to mistake for application startup time.
- Keep full-card startup motion out of the desktop runtime. Initialize tray and global-shortcut services after the first window reveal, while preserving localized task and popover motion.
- Keep hardware acceleration enabled by default; visual compositing and responsive interaction take priority over misleading private-memory reductions from disabling the GPU process.
- The frameless Note window resizes natively from all four edges and corners without permanent resize controls. Width and height are independent, remembered with position, and constrained to 420×660 through 760×1050 so the card stays useful and visually restrained.
