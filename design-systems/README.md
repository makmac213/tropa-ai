# Design systems

Design systems you can pick when you create a project in TropaAI. Each one is a single Markdown file: front matter that drives the **preview** in the New project dialog, then **guidance for the agents** that build the UI.

When a project picks one, tropa:
- copies it to the project as `docs/DESIGN_SYSTEM.md`, and
- installs it as the `design-system` skill in `.agents/skills/`, so developers, the lead and QA load it for any UI work.

To pick one later, or to change it: `tropa design use <id> [DIR]`. To see what's available: `tropa design list`.

> **Trademarks:** Carbon, Fluent, Material Design, Ant Design, shadcn/ui and any other names here belong to their respective owners. They're used only to identify the open-source libraries and guidelines the agents should use. TropaAI isn't affiliated with or endorsed by any of them. These files are original guidance written for TropaAI: they copy no logos, fonts, icons or documentation, and the preview colours are approximations of each system's default theme.

## Add your own

Copy one of these files, rename it `<id>.md` (lowercase, hyphenated), and edit it:

```markdown
---
id: my-brand
name: My Brand
summary: One line on what it is.
best-for: what kinds of products it suits
docs: https://example.com/design
preview-bg: "#ffffff"           # page background
preview-surface: "#f7f7f8"      # cards, panels
preview-text: "#18181b"
preview-muted: "#52525b"        # secondary text: keep ≥ 4.5:1 contrast on bg and surface
preview-border: "#e4e4e7"
preview-primary: "#2563eb"      # primary button
preview-on-primary: "#ffffff"   # text on the primary button: keep ≥ 4.5:1
preview-accent-bg: "#dbeafe"    # badge / chip background
preview-accent-text: "#1e3a8a"
preview-radius: 8px             # cards and inputs
preview-button-radius: 8px
preview-font: "Inter, system-ui, sans-serif"
preview-density: comfortable    # compact | comfortable | spacious
---

# My Brand: guidance for agents
...how to build UI in this system: packages, tokens, components, layout, do / don't...
```

The preview colours are approximations of each system's default theme, enough to recognise its look. Agents follow the guidance in the body, not the preview. Keep the body practical: install commands, theme setup, a component map, layout rules and a short do / don't list.
