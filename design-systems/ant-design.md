---
id: ant-design
name: Ant Design
summary: Enterprise-grade React components with strict grids, dense layouts, powerful tables, forms and trees.
best-for: admin consoles, data-heavy dashboards, multi-agent and pipeline back offices, complex forms
docs: https://ant.design
preview-bg: "#f5f5f5"
preview-surface: "#ffffff"
preview-text: "#1f1f1f"
preview-muted: "#595959"
preview-border: "#d9d9d9"
preview-primary: "#1668dc"
preview-on-primary: "#ffffff"
preview-accent-bg: "#e6f4ff"
preview-accent-text: "#003eb3"
preview-radius: 6px
preview-button-radius: 6px
preview-font: "-apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
preview-density: compact
---

# Ant Design: guidance for agents

Build the UI with **Ant Design v5** (`antd`) and `@ant-design/icons`. It is a complete system, so use its components and layout rather than custom CSS.

## Setup
- `npm i antd @ant-design/icons` (React). Next.js: also `@ant-design/nextjs-registry` for SSR styles.
- Theme with `ConfigProvider` and design tokens, not CSS overrides:
  ```tsx
  <ConfigProvider theme={{ token: { colorPrimary: '#1677ff', borderRadius: 6 }, algorithm: [theme.compactAlgorithm] }}>
  ```
  Dark mode: `theme.darkAlgorithm`. Component-level tweaks: `theme.components.Table` and so on.

## Layout
- App shell: `Layout` with `Sider` (collapsible `Menu`), `Header`, `Content`, plus `Breadcrumb` for depth.
- Pages use `Row`/`Col` (24-column grid) and `Card`; sections use `Space` and `Flex` for gaps (8/16/24).
- Data: `Table` with server-side pagination, sorting and filters, fixed columns and `expandable` rows; `Descriptions` for detail views; `Tree`/`TreeSelect` for hierarchies; `Statistic` for KPIs.
- Forms: `Form` with `rules` for validation, `Form.List` for repeatable fields, `Steps` for multi-step flows.

## Status and long-running work
- `Badge status="processing|success|error"` and `Tag` for state, `Progress` for jobs, `Spin` and `Skeleton` while loading, `message`/`notification` for results, and `Result` for empty or error pages.
- AI reasoning or agent steps: a ghost `Collapse` containing a `Timeline`:
  ```tsx
  import { Collapse, Timeline, Spin } from 'antd';
  import { BulbOutlined, LoadingOutlined } from '@ant-design/icons';
  <Collapse ghost items={[{ key: '1', label: <><BulbOutlined /> {thinking ? 'Thinking…' : 'Reasoning'}</>,
    children: <Timeline pending={thinking && <Spin indicator={<LoadingOutlined spin />} size="small" />}
      items={steps.map((s) => ({ color: s.done ? 'green' : 'blue', children: s.text }))} /> }]} />
  ```

## Don't
- Mix in another component library, or restyle components with global CSS. Use tokens.
- Build custom tables or forms when `Table` and `Form` cover it.
- Make text smaller than the default 14px. Secondary text uses `colorTextSecondary`, not lighter greys, to keep contrast.
