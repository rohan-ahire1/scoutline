# Scoutline — agent instructions

## Reusable components first

Before implementing any UI, search the codebase for an existing reusable
component that fits. Only build new markup when nothing suitable exists —
and when nothing does, create the shared component first, then use it in
the feature. Never duplicate an existing pattern inline.

Reusable pieces live in `src/App.jsx` unless noted:

- `Badge` (status pills, `tone` + optional `dot`), `Avatar`, `Score`,
  `IconButton`, `Modal`, `StagePicker`, `RunMenu`, `CommandMenu`
- Toolbar/table kit: `.view-tabs` (filters, add `.tabs-dense` for wide
  sets), `.table-search`, `.sort-control`, `.client-table` shell
  (sticky head + scrollable body + footer pager)
- Icons: Lucide for chrome (arrows, chevrons, close, search-in-input,
  spinners, step glyphs); the `.e` emoji scale (`.e10`–`.e20`, `aria-hidden`)
  for subject-matter icons in buttons, tiles, banners, and empty states
- Styling: theme tokens only (`theme.css` — no raw px colors/sizes);
  pastel tiles via `--tint-*` so dark mode follows automatically

Checklist for every UI change:

1. `grep` for the pattern (component name, class, or label) in
   `src/App.jsx` and `src/styles.css`.
2. Reuse it as-is, or extend it with a documented variant/class.
3. If genuinely new, add it next to its siblings (same file, same naming
   and prop conventions) and use it at every call site it serves —
   no one-off copies.
4. Verify with `npm run build`, `npm test`, and the running dev server
   (`http://127.0.0.1:5174`); screenshot new/changed states into
   `screenshots/`.
