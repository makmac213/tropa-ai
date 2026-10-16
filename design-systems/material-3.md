---
id: material-3
name: Material Design 3
summary: Material You. Dynamic colour, rounded shapes, clear elevation and expressive motion across web, Android and Flutter.
best-for: consumer and mobile-first products, conversational and voice assistants, cross-platform apps
docs: https://m3.material.io
preview-bg: "#fef7ff"
preview-surface: "#f3edf7"
preview-text: "#1d1b20"
preview-muted: "#49454f"
preview-border: "#cac4d0"
preview-primary: "#6750a4"
preview-on-primary: "#ffffff"
preview-accent-bg: "#e8def8"
preview-accent-text: "#1d192b"
preview-radius: 12px
preview-button-radius: 20px
preview-font: "Roboto, system-ui, sans-serif"
preview-density: spacious
---

# Material Design 3: guidance for agents

Follow **Material Design 3** (Material You). Use the platform's official implementation:
- **Web:** Material Web components (`@material/web`: `<md-filled-button>`, `<md-outlined-text-field>`…), styled with M3 tokens (`--md-sys-color-primary`, `--md-sys-shape-corner-*`).
- **Android:** Jetpack Compose `androidx.compose.material3`.
- **Flutter:** `useMaterial3: true` with `ColorScheme.fromSeed`.

## Colour
- Generate the scheme from **one seed colour** (Material Theme Builder) and use the roles, never raw hex: `primary`/`onPrimary`, `primaryContainer`/`onPrimaryContainer`, `secondaryContainer`, `surface`, `surfaceContainer(Low/High)`, `onSurface`, `onSurfaceVariant`, `outline`, `error`.
- Provide light and dark schemes from the same seed. Dynamic colour (from the wallpaper or brand) is optional on Android.

## Shape, type, elevation, motion
- Shapes: buttons are fully rounded (20px), cards 12px, dialogs 28px, small elements 8px.
- The type scale uses roles: `display`, `headline`, `title`, `body`, `label` (Large/Medium/Small).
- Elevation through **tonal surface colours** (`surfaceContainer*`) more than shadows.
- Motion: emphasized easing, 200–500ms, with container transforms between list and detail.

## Components and layout
- Navigation: navigation bar (compact), navigation rail (medium), navigation drawer (expanded). Top app bar; FAB for the main action, e.g. starting voice input.
- Cards (elevated, filled or outlined), chips (assist, filter, input, suggestion), bottom sheets, dialogs and snackbars.
- Layout by window-size class: compact < 600dp, medium 600–839dp, expanded ≥ 840dp, with 16–24dp margins.

## AI and conversational patterns
- Suggestion chips for follow-ups; a bottom sheet for sources and settings; a FAB or large mic button for voice.
- An assistant's state can tint the UI through the colour roles (e.g. a listening state uses `primaryContainer`). Keep contrast pairs (`on*`) correct.

## Don't
- Mix Material 2 components or styles with M3.
- Hard-code colours outside the generated scheme, or use shadows for every surface.
