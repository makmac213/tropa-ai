---
id: fluent-2
name: Fluent 2
summary: Modern, calm and spacious. Soft layering, clear app navigation and polished micro-interactions, with a productivity-app feel.
best-for: business apps, KPI and BI hubs, workflow tools, collaborative workspaces, productivity add-ins
docs: https://fluent2.microsoft.design
preview-bg: "#fafafa"
preview-surface: "#ffffff"
preview-text: "#242424"
preview-muted: "#616161"
preview-border: "#d1d1d1"
preview-primary: "#0f6cbd"
preview-on-primary: "#ffffff"
preview-accent-bg: "#ebf3fc"
preview-accent-text: "#0e4775"
preview-radius: 8px
preview-button-radius: 4px
preview-font: "'Segoe UI', 'Segoe UI Web', -apple-system, system-ui, sans-serif"
preview-density: comfortable
---

# Fluent 2: guidance for agents

Build with **Fluent UI React v9** (`@fluentui/react-components`, icons from `@fluentui/react-icons`). Don't use the legacy v8 / Fabric packages (`@fluentui/react`).

## Theme and tokens
- Wrap the app in `<FluentProvider theme={webLightTheme}>` (`webDarkTheme`, `teamsLightTheme`…). Brand: create a `BrandVariants` ramp and use `createLightTheme(brand)` / `createDarkTheme(brand)`.
- Style with `makeStyles` and **tokens** (`tokens.colorNeutralBackground1`, `colorBrandBackground`, `colorNeutralForeground2`, `spacingHorizontalM`, `borderRadiusMedium`, `shadow4`), never hex.

## Layout and navigation
- App-centric shell: a collapsible nav rail or drawer (`NavDrawer` with `NavItem`s), a top bar for search and account, content in cards on a neutral background.
- Spacious, layered: `Card` on `colorNeutralBackground2`, subtle shadows (`shadow4`/`shadow8`), 4px radius for controls and 8px for cards.
- Panels: `Drawer` (overlay or inline) for details next to the main content; `Dialog` for focused tasks.

## Data and status
- `DataGrid` / `Table` with sorting, selection and resizable columns; `Toolbar` above it.
- KPIs: cards with large `Title` text and `Caption` labels; charts sit in cards with consistent padding.
- Feedback: `Spinner`, `ProgressBar`, `MessageBar` (intent info, success, warning, error), `Toast`, `Badge`/`PresenceBadge`, `Skeleton`.

## Interaction
- Every control keyboard-reachable with visible focus (Fluent's focus indicators). Tooltips on icon buttons.
- Motion is subtle and quick (Fluent motion tokens); avoid decorative animation.

## Don't
- Mix v8 and v9 components, or override styles with global CSS.
- Use colours that aren't tokens, or text smaller than the type ramp (`Caption1` minimum for labels).
