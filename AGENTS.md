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
