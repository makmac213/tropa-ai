---
id: minimal-dark
name: Minimal Dark
summary: Dark-first, monochrome, precise. Fine 1px borders, crisp type, keyboard-first: the look of modern developer tools.
best-for: developer tools, AI and code platforms, CLIs turned web apps, high-end tech landing pages
docs: https://tailwindcss.com/docs
preview-bg: "#0a0a0a"
preview-surface: "#111111"
preview-text: "#ededed"
preview-muted: "#a1a1a1"
preview-border: "#2e2e2e"
preview-primary: "#ededed"
preview-on-primary: "#0a0a0a"
preview-accent-bg: "#1f2040"
preview-accent-text: "#b4b9ff"
preview-radius: 8px
preview-button-radius: 6px
preview-font: "Inter, ui-sans-serif, system-ui, sans-serif"
preview-density: comfortable
---

# Minimal Dark: guidance for agents

A visual style, not a component library. Implement it with **Tailwind CSS** (plus shadcn/ui or Radix primitives if you need components), an open-source sans and mono font pair (e.g. Geist or Inter, plus a monospace font), and `lucide-react` icons.

## Visual rules
- **Dark by default:** near-black background (`#0a0a0a`), a slightly lighter surface (`#111`), 1px borders in `#262626`–`#2e2e2e`. Light mode is the inverse, with the same restraint.
- **Monochrome first:** text `#ededed`, secondary `#a1a1a1`. Use **one** accent colour (e.g. indigo `#5e6ad2`) sparingly: focus, active state, primary call to action.
- **Type does the work:** tight tracking on headings (`tracking-tight`), 13–14px UI text, and monospace for ids, code, keys and numbers in tables.
- **Depth without shadows:** borders, subtle `bg-white/[0.03]` hovers, and at most a faint radial gradient or border glow on hero sections.
- Radius 6–8px, airy but exact spacing (4px grid), and motion only on state changes (100–150ms ease-out).

## Interaction
- **Keyboard first:** a ⌘K command palette (cmdk / shadcn `Command`) for navigation and actions, visible shortcut hints (`<kbd>`), arrow-key lists.
- Dense, scannable lists over cards: one line per item, status icon, title, monospace meta, and actions on hover.
- Code and logs: syntax highlighting (Shiki), copy buttons, wrap toggles. Streaming output in a fixed-height scroll area that sticks to the bottom.

## Don't
- Use multiple bright colours, heavy shadows, large radii or gradients everywhere.
- Use grey text below 4.5:1 contrast. On `#0a0a0a`, keep secondary text at `#a1a1a1` or lighter.
