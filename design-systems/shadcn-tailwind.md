---
id: shadcn-tailwind
name: shadcn/ui + Tailwind
summary: Copy-in components you own, built on Radix and Tailwind CSS. Fast to customise, great for bespoke AI and SaaS interfaces.
best-for: AI chat and generative UI, SaaS apps, rapid prototypes, products with their own brand
docs: https://ui.shadcn.com
preview-bg: "#ffffff"
preview-surface: "#fafafa"
preview-text: "#09090b"
preview-muted: "#52525b"
preview-border: "#e4e4e7"
preview-primary: "#18181b"
preview-on-primary: "#fafafa"
preview-accent-bg: "#f4f4f5"
preview-accent-text: "#18181b"
preview-radius: 8px
preview-button-radius: 6px
preview-font: "Inter, ui-sans-serif, system-ui, sans-serif"
preview-density: comfortable
---

# shadcn/ui + Tailwind: guidance for agents

Build every UI in this project with **shadcn/ui** components and **Tailwind CSS**. shadcn/ui isn't a dependency you import from `node_modules`. Its components are copied into the repo (`components/ui/`), so you own them and can change them.

## Setup
- New app: `npx shadcn@latest init` (React, with Next.js or Vite), then add components as you need them: `npx shadcn@latest add button card input dialog table command`.
- Icons: `lucide-react`. Class merging: the generated `cn()` helper in `lib/utils`.
- Theme: CSS variables in `globals.css` (`--background`, `--foreground`, `--primary`, `--muted`, `--border`, `--radius`…). Change the brand **there**, not by sprinkling colours through components. Dark mode uses the `.dark` class with the same variable names.

## Rules
- Use the semantic Tailwind tokens (`bg-background`, `text-muted-foreground`, `border-border`, `bg-primary text-primary-foreground`), never raw hex values or arbitrary colours.
- Compose from shadcn primitives (Dialog, Sheet, DropdownMenu, Command, Tabs, Table, Form + react-hook-form + zod) before writing new ones. Put new reusable pieces in `components/` and keep them as small wrappers.
- Spacing on the Tailwind scale (`gap-2/4/6`, `p-4/6`); radius from `--radius` (`rounded-md`/`rounded-lg`).
- Accessibility comes from Radix: keep focus rings (`focus-visible:ring`), labels on inputs and `aria-*` on icon buttons.

## AI interface patterns
- **Streaming text:** render into a stable container (fixed width, `break-words`) so tokens don't shift the layout. Show a blinking caret while streaming.
- **Feedback:** stop, regenerate, copy and thumbs up/down as ghost icon buttons under each answer.
- **Citations:** small bordered chips (`text-xs border rounded px-2`) that link to sources.
- **Long reasoning:** use a `Collapsible` "Thinking…" panel with a skeleton shimmer, collapsed by default once done.
- **Command menu:** the `Command` component (⌘K) for actions and model switching.

```tsx
export function AIMessage({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className="flex gap-3 rounded-xl border bg-muted/40 p-4">
      <div className="prose prose-sm dark:prose-invert max-w-none break-words">
        {text}{streaming && <span className="ml-1 inline-block h-4 w-2 animate-pulse bg-primary align-middle" />}
      </div>
    </div>
  )
}
```

## Don't
- Install a second component library alongside it, or hard-code hex colours.
- Restyle a component by copy-pasting it; change the one in `components/ui/` or add a variant with `cva`.
