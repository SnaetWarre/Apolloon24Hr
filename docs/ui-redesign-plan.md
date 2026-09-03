# Apolloon UI redesign plan

## Assessment

PR #2 improved distance legibility and supplied unusually good visual evidence. It also pushed the interface toward decorative dashboard styling: gradients, glows, layered shadows, many pills, podium colors, uppercase section titles, and several blue treatments compete for attention. The current stylesheet is 2,937 lines and contains 94 distinct literal color values and 140 uses of gradients, shadows, text transforms, or border radii. Those counts are signals to consolidate, not quality scores by themselves.

Apolloon has two different products inside it and should not style them identically:

- Operator software should be quiet, dense, predictable, and optimized for fast decisions.
- Public displays should be bold and readable from a distance, with fewer simultaneous visual treatments.

The target is the restraint of professional tools such as T3 Code or Linear, adapted to a physical event: one neutral application shell, one blue accent, strong typography, consistent spacing, and decoration only when it communicates state.

## Design principles

1. Hierarchy through type, spacing, and alignment before color or shadow.
2. One surface model: page, panel, inset control, and overlay. Avoid cards inside cards unless the nesting represents real structure.
3. One accent blue. Reserve green, amber, and red for status and risk.
4. Pills only for compact metadata, status, and filters. Ordinary values and actions use text, rows, or buttons.
5. One subtle border and, at most, one low-elevation shadow per surface level.
6. Tabular numerals for times, lap counts, ranks, and operational metrics.
7. Operator screens prioritize scan paths and stable control placement. Public screens prioritize viewing distance and motion safety.

## Delivery sequence

### 1. Inventory and freeze

Capture all main routes at desktop and the supported narrow width using deterministic seeded states. Inventory colors, spacing, radii, shadows, typography, button variants, badges, and panels. Document which styles are operator-only or display-only. Avoid further one-off visual additions during this pass.

### 2. Establish a small token layer

Replace repeated literals with semantic tokens for canvas, surface, inset surface, text, muted text, border, accent, focus, success, warning, and danger. Define a compact spacing scale, three radii, and two elevations. Keep Apolloon blue as the brand accent and verify WCAG contrast for interactive text and status combinations.

### 3. Build shared primitives

Create only the primitives already repeated across routes: application shell, page header, panel, button, field, segmented control, status badge, data row, empty state, and alert. Give each a small set of explicit variants. Migrate existing screens before adding more primitives.

### 4. Simplify operator routes first

Start with Start, Telsysteem 1, Telsysteem 2, Analyse, and Admin. Reduce oversized hero treatment, repeated bordered containers, decorative color bars, and badge-shaped values. Use a consistent top bar and page header, align primary controls, make destructive actions visually distinct, and keep race state visible without dominating the workspace.

### 5. Refine public displays separately

Keep large names and timing data, but remove competing decoration. On the binnenscherm, use one primary live region and two quieter supporting regions; use podium color only for rank markers; show progress as aligned data rather than a wall of pills. On the buitenscherm, preserve safe name wrapping and reduced-motion behavior while limiting animated emphasis to a single event state.

### 6. Add visual regression coverage

Capture deterministic screenshots for every main route at agreed viewports. Review diffs in PRs rather than accepting snapshot updates blindly. Add focused accessibility checks for keyboard focus, contrast, reduced motion, overflow, and large runner names.

### 7. Remove legacy CSS

After each route migrates, delete superseded selectors and literals. Split the monolithic stylesheet by tokens, primitives, operator surfaces, and public displays only if those boundaries reduce ownership ambiguity. Track CSS and initial bundle size, but do not trade clarity for tiny byte reductions.

## PR boundaries

Keep redesign PRs reviewable: tokens and primitives first, then one route family per PR, then display refinement and cleanup. Every visual PR follows the global PR-evidence skill and includes matched before/after captures. Any performance claim includes reproducible base-versus-head measurements.

## Completion criteria

- Main routes share the same shell, type scale, spacing rhythm, controls, and focus treatment.
- Operator tasks remain usable at event speed with no hidden or moving primary actions.
- Public displays remain readable at their intended distance and respect reduced motion.
- New route-specific CSS is exceptional and explained.
- Screenshot comparisons, tests, and accessibility checks pass for each migrated route.
