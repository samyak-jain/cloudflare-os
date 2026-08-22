# Catalog v1

The component vocabulary `renderUI` writes against, as the renderer actually reads it. The names
are fixed by the wire contract (`GENERATIVE_UI_CATALOG` in `workshop-shared/src/api.ts`); the props
below are this renderer's half of it, and are what the tool description in the backend should
teach the model.

Conventions used throughout:

- **`bind(path)`** — this is the only runtime-binding call, and only for props
  marked *bindable*. The interpreter converts it to the wire marker `{ "$bind": "dot.path" }`;
  writing that object directly in JSX or supplying it through `data` is rejected. The path must
  evaluate to a non-empty string from literals, static `data`, or `.map` locals. It addresses
  `stateDefaults` as a plain object tree; array indices are numeric segments (`tags.0`). This makes
  per-row controls possible with ``bind(`rows.${index}.value`)``. A control whose value prop is
  not bound renders read-only, because there is nowhere for its edits to go.
- **JSX is an interpreted expression language, not JavaScript.** The backend parses the entire
  source and evaluates a fixed, bounded AST grammar. Nothing is compiled or executed.
- **`data` is the only top-level identifier.** It refers to the optional static JSON supplied with
  the tool call. A direct `.map` callback adds its `item` and optional `index` parameters to a
  lexical child scope. There are no globals, `this`, `window`, or ambient names.
- **Allowed expressions** are JSON literals (including arrays/objects and negative numbers),
  catalog JSX, pure `item.name` / `item[0]` / `array.length` reads, direct
  `array.map((item, index) => expression)`, ternary and `&&` / `||` conditionals,
  `=== !== < > <= >=`, numeric `+ - * / %`, unary `-`, template strings, and string `+`. The only
  other call is `bind(path)` in a bindable prop. Arithmetic operands must be numbers; `+` adds two
  numbers and concatenates when either operand is a string. Use a template for mixed row labels:
  `` `#${index + 1}` `` is `"#1"`, while `"#" + index + 1` follows left associativity and is
  `"#01"` for index zero.
- **Everything else is rejected structurally in every branch.** That includes imports, ordinary
  or member calls, arrows outside direct `.map`, block-bodied callbacks, declarations, loops,
  assignments, updates, `new`, spreads, tagged templates, sequence expressions, optional access,
  and the keys `__proto__`, `constructor`, and `prototype`.
- **Variant props are matched case-insensitively**, and an unrecognized value falls back to the
  default rather than failing the card.
- **Numbers may arrive as numeric strings** (`max="100"`), which is what a JSX attribute often is.
- **Children** are other catalog elements and text. Components marked *text* below take their
  content from children, or from a `label` prop when they have no children.
- The backend rejects everything not listed. Nothing is required except where stated.

For repeated data, send the array once and map it into a static prop value:

```jsx
<Table
  columns={["row", "name", {key: "score", label: "Score", align: "right"}]}
  rows={data.rows.map((row, index) => ({
    row: index + 1,
    name: row.name,
    score: row.score,
  }))}
/>
```

with `data: {rows: [{name: "Ada", score: 12}]}`. `.map` runs only while the durable tree is being
generated. It can range over literal/static `data` arrays or arrays produced by another allowed
expression, never over runtime bound `state`. A row per bound-state item is out of scope for v1.

Mapped controls may derive distinct paths from the same static callback scope:

```jsx
<Stack>
  {data.rows.map((row, index) =>
    <Input label={row.name} value={bind(`rows.${index}.value`)} />)}
</Stack>
```

The matching `state` is `{rows: [{value: "..."}, ...]}`. This does not make bound state iterable:
the map still ranges only over static `data`; the generated path is a leaf marker in the durable
tree.

## Expression limits

Programs are rejected rather than truncated when any limit would be exceeded:

| Limit | Maximum |
| --- | ---: |
| JSX source / static `data` / bound `state` | 64 KiB each |
| Parsed AST nodes | 20,000 |
| Expression evaluations | 100,000 |
| `.map` callback iterations, total and nested product | 10,000 |
| Contiguous member/index reads | 32 |
| One produced string | 16,384 characters |
| Aggregate evaluated strings / serialized validated tree | 256 KiB each |
| Emitted catalog nodes | 5,000 |

## Layout

| Component | Props | Notes |
| --- | --- | --- |
| `Stack` | `gap`: `none` \| `xs` \| `sm` (default) \| `md` \| `lg` | Vertical flow. |
| `Row` | `gap` (as `Stack`), `align`: `start` \| `center` (default) \| `end` \| `baseline`, `justify`: `start` (default) \| `center` \| `end` \| `between`, `wrap`: boolean (default true) | Horizontal flow; wraps by default because a chat card is narrow. |
| `Card` | `title`, `subtitle` (alias `description`) | A section *inside* the card. Quieter than the card that contains it; don't nest more than one deep. |
| `Divider` | — | A hairline rule. |

## Typography

| Component | Props | Notes |
| --- | --- | --- |
| `Text` | *text*; `tone`: `default` \| `subtle` (default) \| `muted` \| `brand` \| `success` \| `warning` \| `danger`, `size`: `sm` \| `md` (default) \| `lg`, `strong`: boolean, `mono`: boolean | Body copy. Preserves newlines. |
| `Heading` | *text*; `level`: 1 \| 2 (default) \| 3 | 1 is the card's title, 2 a subsection, 3 an uppercase eyebrow — not a third size of bold text. |
| `Badge` | *text*; `tone`: `neutral` (default) \| `brand` \| `success` \| `warning` \| `danger` \| `info` | A status pill. |

## Action

| Component | Props | Notes |
| --- | --- | --- |
| `Button` | *text*; **`action`: string (required)**, `variant`: `primary` \| `secondary` (default) \| `danger`, `disabled`: boolean | Pressing it submits the whole card's state under `action` and freezes the card **permanently**. So: one submitting button, at most one `primary`, and no button for anything that isn't a decision. A `Button` with no `action` renders inert. |

## Controls

Every control below is bindable and does nothing without a binding.

| Component | Props | Notes |
| --- | --- | --- |
| `Input` | `value` *(bindable)*, `label`, `placeholder`, `description` (alias `hint`), `type`: `text` (default) \| `number` \| `email` \| `url` \| `search` \| `tel` \| `password` | `type="number"` writes a number back, not a string. |
| `Select` | `value` *(bindable)*, `options`, `label`, `placeholder` | `options` is `["a", "b"]` or `[{value, label}]`. A `value` matching no option shows the placeholder. |
| `Checkbox` | `checked` *(bindable)*; *text* or `label`, `description` | |
| `Slider` | `value` *(bindable)*, `min` (default 0), `max` (default 100), `step` (default 1), `label`, `valueLabel` | The current value is always shown; `valueLabel` overrides how (`"60%"`, `"3 replicas"`). |

## Data display

| Component | Props | Notes |
| --- | --- | --- |
| `Table` | `columns`, `rows` (alias `data` / `items`) | `columns` is `["a", "b"]` or `[{key, label, align}]`; omit it and the keys of the first row are used, in order. Numeric cells are right-aligned and digit-grouped automatically — don't pre-format them. |
| `ProgressBar` | `value`, `max` (default 100), `label`, `valueLabel`, `showValue`: boolean (default true) | Shows a percentage unless `valueLabel` says otherwise. |
| `Callout` | *text*; `tone`: `info` (default) \| `success` \| `warning` \| `danger`, `title` | One per card, at most. |
| `KeyValue` | `items` (alias `entries` / `pairs`) | `[{label, value}]`. Numbers are grouped and tabular, as in `Table`. |

## Composition notes

These are renderer-side observations worth putting in the prompt, because the catalog can't
enforce them:

- **One accent per card.** `Button variant="primary"`, `ProgressBar`, and `Slider` all paint in the
  brand colour. A card with all three has no focal point.
- **Prefer `KeyValue` to a two-column `Table`** for a handful of facts; the table chrome earns its
  place at three columns and up.
- **`Heading level={1}` at most once**, at the top.
- **Don't restate the message.** The card sits directly under the agent's prose; a `Text` repeating
  it is the most common way these look padded.
