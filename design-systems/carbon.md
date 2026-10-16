---
id: carbon
name: Carbon
summary: Engineered, flat and dense. A strict 2x grid, IBM Plex type, outstanding data tables and charts, with accessibility built in.
best-for: enterprise and cloud consoles, technical telemetry, admin tools, large data tables with layered filters
docs: https://carbondesignsystem.com
preview-bg: "#ffffff"
preview-surface: "#f4f4f4"
preview-text: "#161616"
preview-muted: "#525252"
preview-border: "#c6c6c6"
preview-primary: "#0f62fe"
preview-on-primary: "#ffffff"
preview-accent-bg: "#d0e2ff"
preview-accent-text: "#002d9c"
preview-radius: 0px
preview-button-radius: 0px
preview-font: "'IBM Plex Sans', 'Helvetica Neue', Arial, sans-serif"
preview-density: compact
---

# Carbon: guidance for agents

Build with the **Carbon Design System v11**: `@carbon/react` and `@carbon/styles` (Sass), icons from `@carbon/icons-react`, charts with `@carbon/charts-react`. Use **IBM Plex** fonts.

## Themes and tokens
- Four themes: **White**, **Gray 10** (light), **Gray 90**, **Gray 100** (dark). Pick one per area. A dark shell (`Gray 100`) with light content (`White`) is common.
- Always use tokens (`$background`, `$layer-01/02`, `$text-primary`, `$text-secondary`, `$border-subtle`, `$interactive`, `$support-error/success/warning`), never hex. Map brand colours to tokens without dropping below the WCAG AA contrast that Carbon's themes guarantee.
- Spacing tokens `$spacing-01…13` (2px to 160px), on the 2x grid.

## Shell and layout
- `Header` + `HeaderNavigation` + `SideNav` (rail or fixed); `Grid`/`Column` (16 columns at large sizes) for content.
- Flat and rectangular: square corners, no decorative shadows. Hierarchy comes from layers (`$layer-01` → `$layer-02`), type and spacing.

## Data
- `DataTable` with toolbar search, batch actions, expandable rows, sorting, sticky headers and pagination. Sizes `xs`–`xl`; the dense `sm` size is common for telemetry.
- Filters: `Dropdown`, `MultiSelect`, `ComboBox`, `DatePicker`, `Search`; tags for active filters.
- Status: `InlineLoading`, `Tag` (red, green, blue…), `InlineNotification`/`ToastNotification`, `ProgressBar`, skeleton states.
- Charts: `@carbon/charts-react` (line, bar, area, donut, gauge) in a `Tile` with a title and toolbar.

## Don't
- Round corners, add drop shadows or use non-token colours.
- Put custom spacing outside the spacing scale, or use fonts other than IBM Plex.
