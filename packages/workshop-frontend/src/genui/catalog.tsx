/**
 * The component catalog: the only things a generated tree can become.
 *
 * Two rules shape everything here.
 *
 * **It must look like the app, not like a form dropped into the app.** The chat transcript has a
 * type scale of its own -- 14px rows, 13px body, 12px labels, 11px meta -- distinct from the app
 * chrome's 16px. So the controls are built on `WorkshopControls`, the workshop's own kumo wrappers
 * at that scale, and everything else uses the same class vocabulary as the hand-built chat cards
 * (`rounded-2xl border-kumo-line bg-kumo-base`, `themed-surface-inset` insets). Every colour is a
 * kumo token, so light and dark, and any future brand change, come for free.
 *
 * **A component may not fail.** Props arrive from a model. Each renderer coerces what it is given
 * (see `props.ts`) and draws *something*; none of them throw, and none of them receive a callback
 * the model wrote, because there are none -- interactivity is `$bind` paths and one action string.
 */

import type { ReactNode } from "react";
import { Loader } from "@cloudflare/kumo";
import { CheckCircle, Info, Warning, WarningCircle } from "@phosphor-icons/react";
import type { GenerativeUiNode } from "@gadgets/workshop-shared/api";
import { WorkshopButton, WorkshopInput } from "../components/WorkshopControls";
import { bindingOf } from "./bind";
import { bool, displayValue, isNumericValue, list, num, str, variant } from "./props";

/** What a catalog component may do to the world: write a bound path, or submit the card. */
export type CatalogContext = {
  /** True for a consumed submission or a historical card: controls render read-only. */
  frozen: boolean;
  setBound: (path: string, value: unknown) => void;
  submit: (action: string) => void;
  /** The action whose submission is in flight, if any, so its button can show progress. */
  pendingAction: string | null;
};

export type CatalogRenderArgs = {
  /** The raw node: the only place `$bind` markers are still visible (see `bindingOf`). */
  node: GenerativeUiNode;
  /** `node.props` with every binding replaced by its current value. */
  props: Record<string, unknown>;
  children: ReactNode;
  /** Whether the node has any children at all, before they were rendered. */
  hasChildren: boolean;
  ctx: CatalogContext;
};

export type CatalogComponent = (args: CatalogRenderArgs) => ReactNode;

// ── Shared scales ───────────────────────────────────────────────────────────────────────────────

const GAPS = { none: "gap-0", xs: "gap-1", sm: "gap-2", md: "gap-3", lg: "gap-5" } as const;

const TEXT_TONES = {
  default: "text-kumo-default",
  subtle: "text-kumo-subtle",
  muted: "text-kumo-inactive",
  brand: "text-kumo-brand",
  success: "text-kumo-success",
  warning: "text-kumo-warning",
  danger: "text-kumo-danger",
} as const;

const BADGE_TONES = {
  neutral: "bg-kumo-tint text-kumo-subtle",
  brand: "bg-kumo-brand/10 text-kumo-brand",
  success: "bg-kumo-success-tint text-kumo-success",
  warning: "bg-kumo-warning-tint text-kumo-warning",
  danger: "bg-kumo-danger-tint text-kumo-danger",
  info: "bg-kumo-info-tint text-kumo-info",
} as const;

const CALLOUT_TONES = {
  info: { shell: "border-kumo-info/25 bg-kumo-info-tint/35", icon: "text-kumo-info", Icon: Info },
  success: {
    shell: "border-kumo-success/25 bg-kumo-success-tint/35",
    icon: "text-kumo-success",
    Icon: CheckCircle,
  },
  warning: {
    shell: "border-kumo-warning/30 bg-kumo-warning-tint/35",
    icon: "text-kumo-warning",
    Icon: Warning,
  },
  danger: {
    shell: "border-kumo-danger/25 bg-kumo-danger-tint/35",
    icon: "text-kumo-danger",
    Icon: WarningCircle,
  },
} as const;

/** The label a control shows above itself. Its own element, so the transcript's 12px scale holds. */
function ControlLabel({ children }: { children: ReactNode }) {
  return (
    <span className="mb-1 block text-[12px] leading-4 font-medium tracking-[-0.1px] text-kumo-subtle">
      {children}
    </span>
  );
}

function ControlDescription({ children }: { children: ReactNode }) {
  return (
    <span className="mt-1 block text-[11px] leading-4 text-kumo-inactive">{children}</span>
  );
}

/** Text a component can take either as a prop or as its children, preferring the prop. */
function labelContent(props: Record<string, unknown>, children: ReactNode, hasChildren: boolean) {
  const label = props.label ?? props.text ?? props.title;
  if (typeof label === "string" || typeof label === "number") return String(label);
  return hasChildren ? children : null;
}

// ── Layout ──────────────────────────────────────────────────────────────────────────────────────

const Stack: CatalogComponent = ({ props, children }) => (
  <div className={`flex min-w-0 flex-col ${GAPS[variant(props.gap, GAPS, "sm")]}`}>{children}</div>
);

const ROW_ALIGN = {
  start: "items-start",
  center: "items-center",
  end: "items-end",
  baseline: "items-baseline",
} as const;

const ROW_JUSTIFY = {
  start: "justify-start",
  center: "justify-center",
  end: "justify-end",
  between: "justify-between",
} as const;

const Row: CatalogComponent = ({ props, children }) => (
  <div
    className={[
      "flex min-w-0",
      // Wrapping by default: a chat card is narrow and a row of controls that overflows it is
      // worse than a row that reflows.
      bool(props.wrap, true) ? "flex-wrap" : "",
      GAPS[variant(props.gap, GAPS, "sm")],
      ROW_ALIGN[variant(props.align, ROW_ALIGN, "center")],
      ROW_JUSTIFY[variant(props.justify, ROW_JUSTIFY, "start")],
    ].filter(Boolean).join(" ")}
  >
    {children}
  </div>
);

/**
 * A grouping surface *inside* the card.
 *
 * Deliberately quieter than the card that contains it -- an inset tint rather than another
 * hairline box -- so a nested Card reads as a section and never as a second card in the
 * transcript.
 */
const Card: CatalogComponent = ({ props, children, hasChildren }) => {
  const title = str(props.title);
  const subtitle = str(props.subtitle ?? props.description);
  return (
    <div className="themed-surface-inset min-w-0 rounded-xl border border-kumo-line/70 bg-kumo-elevated/45 p-3">
      {(title || subtitle) && (
        <div className={hasChildren ? "mb-2" : ""}>
          {title && (
            <div className="text-[13px] leading-[18px] font-medium tracking-[-0.1px] text-kumo-default">
              {title}
            </div>
          )}
          {subtitle && (
            <div className="mt-0.5 text-[12px] leading-4 text-kumo-inactive">{subtitle}</div>
          )}
        </div>
      )}
      <div className="flex min-w-0 flex-col gap-2">{children}</div>
    </div>
  );
};

const Divider: CatalogComponent = () => (
  <div role="separator" className="my-0.5 h-px w-full bg-kumo-line" />
);

// ── Typography ──────────────────────────────────────────────────────────────────────────────────

const TEXT_SIZES = {
  sm: "text-[12px] leading-4",
  md: "text-[13px] leading-[18px]",
  lg: "text-[14px] leading-5",
} as const;

const Text: CatalogComponent = ({ props, children, hasChildren }) => (
  <p
    className={[
      TEXT_SIZES[variant(props.size, TEXT_SIZES, "md")],
      TEXT_TONES[variant(props.tone ?? props.color, TEXT_TONES, "subtle")],
      bool(props.strong ?? props.bold) ? "font-medium" : "",
      bool(props.mono) ? "font-mono" : "tracking-[-0.1px]",
      "min-w-0 whitespace-pre-wrap",
    ].filter(Boolean).join(" ")}
  >
    {labelContent(props, children, hasChildren)}
  </p>
);

/**
 * Three levels, and the third is an eyebrow rather than a smaller title.
 *
 * A chat card is a few hundred pixels tall; a third rank of bold text would just be noise, while
 * an uppercase eyebrow separates sections at a glance. This mirrors `SectionEyebrow` in the app.
 */
const HEADING_LEVELS = {
  1: "text-[15px] leading-5 font-semibold tracking-[-0.3px] text-kumo-default",
  2: "text-[13px] leading-[18px] font-semibold tracking-[-0.2px] text-kumo-default",
  3: "text-[11px] leading-4 font-semibold uppercase tracking-[0.07em] text-kumo-inactive",
} as const;

const Heading: CatalogComponent = ({ props, children, hasChildren }) => {
  const level = Math.min(3, Math.max(1, Math.round(num(props.level, 2)))) as 1 | 2 | 3;
  const Tag = (["h3", "h4", "h5"] as const)[level - 1];
  return <Tag className={`min-w-0 ${HEADING_LEVELS[level]}`}>{labelContent(props, children, hasChildren)}</Tag>;
};

const Badge: CatalogComponent = ({ props, children, hasChildren }) => (
  <span
    className={`inline-flex flex-shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] leading-4 font-medium ${
      BADGE_TONES[variant(props.tone ?? props.variant ?? props.color, BADGE_TONES, "neutral")]
    }`}
  >
    {labelContent(props, children, hasChildren)}
  </span>
);

// ── Action ──────────────────────────────────────────────────────────────────────────────────────

const BUTTON_TONES = { primary: "primary", secondary: "secondary", danger: "danger" } as const;

/**
 * The one interactive escape from the card.
 *
 * `action` is an opaque string the agent chose; pressing the button hands it and the card's state
 * back. There is no other event in the catalog, on purpose: a single, named, one-shot submission
 * is something the user can reason about, and something the agent's turn can consume exactly once.
 */
const Button: CatalogComponent = ({ props, children, hasChildren, ctx }) => {
  const action = str(props.action);
  const pending = ctx.pendingAction !== null && ctx.pendingAction === action;
  const tone = variant(props.variant ?? props.tone, BUTTON_TONES, "secondary");
  return (
    <WorkshopButton
      tone={tone}
      // `WorkshopControls` sizes primary and secondary differently -- they are used in different
      // places in the app chrome. Inside one generated row they sit side by side, so they are
      // normalized to the taller of the two here rather than stepping down mid-row.
      className="!h-9"
      // A button with no action can't submit anything; it renders inert rather than lying.
      disabled={ctx.frozen || action === "" || bool(props.disabled)}
      onClick={() => ctx.submit(action)}
    >
      {pending && <Loader size="sm" />}
      {labelContent(props, children, hasChildren) ?? "Submit"}
    </WorkshopButton>
  );
};

// ── Controls ────────────────────────────────────────────────────────────────────────────────────

const CONTROL_SHELL =
  "w-full rounded-lg border border-kumo-line bg-kumo-base px-3 text-[13px] leading-[18px] " +
  "tracking-[-0.25px] text-kumo-default placeholder:text-kumo-inactive " +
  "transition-[border-color,box-shadow] duration-150 ease-out " +
  "focus:border-kumo-ring focus:outline-none focus:ring-[3px] focus:ring-kumo-ring/15 " +
  "disabled:cursor-not-allowed disabled:opacity-60";

const INPUT_TYPES = { text: "text", number: "number", email: "email", url: "url", search: "search",
  tel: "tel", password: "password" } as const;

const Input: CatalogComponent = ({ node, props, ctx }) => {
  const path = bindingOf(node.props, "value");
  const type = variant(props.type, INPUT_TYPES, "text");
  const label = str(props.label);
  const description = str(props.description ?? props.hint);
  return (
    <label className="block min-w-0">
      {label && <ControlLabel>{label}</ControlLabel>}
      <WorkshopInput
        // The app's other inputs sit in fixed-width settings rows; a generated one fills its
        // column, so it lines up with the Select and Slider beside it.
        className="w-full"
        type={type}
        value={str(props.value)}
        placeholder={str(props.placeholder) || undefined}
        aria-label={label || str(props.placeholder) || undefined}
        // Read-only rather than disabled when frozen: a submitted form should still be legible,
        // and a disabled input greys its own text out.
        readOnly={ctx.frozen || path === undefined}
        onChange={(event) => {
          if (path === undefined) return;
          const raw = event.target.value;
          ctx.setBound(path, type === "number" && raw !== "" ? num(raw, 0) : raw);
        }}
      />
      {description && <ControlDescription>{description}</ControlDescription>}
    </label>
  );
};

/**
 * Options accept either shape a model reaches for: `["a", "b"]` or `[{value, label}]`.
 */
function selectOptions(raw: unknown): { value: string; label: string }[] {
  return list(raw).map((option) => {
    if (option !== null && typeof option === "object") {
      const record = option as Record<string, unknown>;
      const value = str(record.value ?? record.id ?? record.key ?? record.label);
      return { value, label: str(record.label ?? record.name ?? record.title) || value };
    }
    const value = str(option);
    return { value, label: value };
  }).filter((option) => option.value !== "" || option.label !== "");
}

/**
 * A native select rather than the kumo one.
 *
 * The transcript scrolls and virtualizes around this card; a portalled listbox anchored to a row
 * that can move is a class of bug this doesn't need, and the OS menu is both faster and calmer at
 * this size. The trigger is styled to match `WorkshopInput` exactly, so it reads as the same
 * family.
 */
const Select: CatalogComponent = ({ node, props, ctx }) => {
  const path = bindingOf(node.props, "value");
  const label = str(props.label);
  const options = selectOptions(props.options ?? props.items ?? props.choices);
  const value = str(props.value);
  const placeholder = str(props.placeholder);
  return (
    <label className="block min-w-0">
      {label && <ControlLabel>{label}</ControlLabel>}
      <div className="relative">
        <select
          className={`${CONTROL_SHELL} h-9 appearance-none pr-8`}
          value={options.some((option) => option.value === value) ? value : ""}
          aria-label={label || placeholder || undefined}
          disabled={ctx.frozen || path === undefined}
          onChange={(event) => path !== undefined && ctx.setBound(path, event.target.value)}
        >
          <option value="" disabled>{placeholder || "Select…"}</option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-kumo-inactive"
        >
          <svg width="9" height="6" viewBox="0 0 9 6" fill="none">
            <path d="M1 1l3.5 3.5L8 1" stroke="currentColor" strokeWidth="1.5"
              strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </div>
    </label>
  );
};

const Checkbox: CatalogComponent = ({ node, props, children, hasChildren, ctx }) => {
  const path = bindingOf(node.props, "checked") ?? bindingOf(node.props, "value");
  const checked = bool(props.checked ?? props.value);
  const description = str(props.description ?? props.hint);
  return (
    <label className="flex min-w-0 cursor-pointer items-start gap-2.5 py-0.5">
      <input
        type="checkbox"
        checked={checked}
        disabled={ctx.frozen || path === undefined}
        onChange={(event) => path !== undefined && ctx.setBound(path, event.target.checked)}
        className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 cursor-pointer rounded accent-kumo-brand focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-kumo-ring/25 disabled:cursor-not-allowed disabled:opacity-60"
      />
      <span className="min-w-0">
        <span className="block text-[13px] leading-[18px] tracking-[-0.1px] text-kumo-default">
          {labelContent(props, children, hasChildren)}
        </span>
        {description && <ControlDescription>{description}</ControlDescription>}
      </span>
    </label>
  );
};

const Slider: CatalogComponent = ({ node, props, ctx }) => {
  const path = bindingOf(node.props, "value");
  const min = num(props.min, 0);
  const max = Math.max(min + 1, num(props.max, 100));
  const value = Math.min(max, Math.max(min, num(props.value, min)));
  const label = str(props.label);
  return (
    <label className="block min-w-0">
      <span className="mb-1 flex items-baseline justify-between gap-3">
        {label && <ControlLabel>{label}</ControlLabel>}
        <span className="text-[12px] leading-4 font-medium tabular-nums text-kumo-default">
          {str(props.valueLabel) || value}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={num(props.step, 1)}
        value={value}
        aria-label={label || undefined}
        disabled={ctx.frozen || path === undefined}
        onChange={(event) => path !== undefined && ctx.setBound(path, Number(event.target.value))}
        // Native controls come with the browser's own focus outline; these use the app's ring
        // instead, so a generated form focuses like every other form in the workshop.
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-kumo-fill accent-kumo-brand focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-kumo-ring/25 disabled:cursor-not-allowed disabled:opacity-60"
      />
    </label>
  );
};

// ── Data display ────────────────────────────────────────────────────────────────────────────────

type TableColumn = { key: string; label: string; align: "left" | "right" };

function tableColumns(raw: unknown, rows: Record<string, unknown>[]): TableColumn[] {
  const declared = list(raw).map((column): TableColumn | null => {
    if (column !== null && typeof column === "object") {
      const record = column as Record<string, unknown>;
      const key = str(record.key ?? record.field ?? record.name ?? record.label);
      if (!key) return null;
      return {
        key,
        label: str(record.label ?? record.title ?? record.header) || key,
        align: variant(record.align, { left: 0, right: 0 }, "left"),
      };
    }
    const key = str(column);
    return key ? { key, label: key, align: "left" } : null;
  }).filter((column): column is TableColumn => column !== null);
  if (declared.length > 0) return declared;

  // No columns declared: take them from the first row, in insertion order. A model that hands over
  // an array of records has already said what the columns are.
  return Object.keys(rows[0] ?? {}).map((key) => ({ key, label: key, align: "left" }));
}

const Table: CatalogComponent = ({ props }) => {
  const rows = list(props.rows ?? props.data ?? props.items)
    .map((row) => (row !== null && typeof row === "object" && !Array.isArray(row)
      ? row as Record<string, unknown>
      : { value: row }));
  const columns = tableColumns(props.columns ?? props.headers, rows);
  if (columns.length === 0) return null;

  const alignOf = (column: TableColumn, value: unknown) =>
    column.align === "right" || isNumericValue(value)
      ? "text-right tabular-nums"
      : "text-left";

  return (
    <div className="min-w-0 overflow-x-auto rounded-xl border border-kumo-line">
      <table className="w-full border-collapse text-[13px] leading-[18px]">
        <thead>
          <tr className="bg-kumo-tint/45">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={`border-b border-kumo-line px-3 py-1.5 text-[11px] leading-4 font-semibold uppercase tracking-[0.06em] text-kumo-inactive ${
                  column.align === "right" ? "text-right" : "text-left"
                }`}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-b border-kumo-line/50 last:border-b-0">
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={`px-3 py-1.5 align-top text-kumo-default ${alignOf(column, row[column.key])}`}
                >
                  {displayValue(row[column.key])}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td
                colSpan={columns.length}
                className="px-3 py-2.5 text-center text-[12px] text-kumo-inactive"
              >
                No rows
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
};

const ProgressBar: CatalogComponent = ({ props }) => {
  const max = Math.max(num(props.max, 100), Number.EPSILON);
  const value = Math.min(max, Math.max(0, num(props.value, 0)));
  const percent = (value / max) * 100;
  const label = str(props.label);
  const showValue = bool(props.showValue, true);
  return (
    <div className="min-w-0">
      {(label || showValue) && (
        <div className="mb-1 flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate text-[12px] leading-4 text-kumo-subtle">{label}</span>
          {showValue && (
            <span className="flex-shrink-0 text-[12px] leading-4 font-medium tabular-nums text-kumo-default">
              {str(props.valueLabel) || `${Math.round(percent)}%`}
            </span>
          )}
        </div>
      )}
      <div
        role="progressbar"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-label={label || undefined}
        className="h-1.5 w-full overflow-hidden rounded-full bg-kumo-fill"
      >
        <div
          className="h-full rounded-full bg-kumo-brand transition-[width] duration-300 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
};

const Callout: CatalogComponent = ({ props, children, hasChildren }) => {
  const tone = CALLOUT_TONES[variant(props.tone ?? props.variant, CALLOUT_TONES, "info")];
  const title = str(props.title);
  const body = labelContent({ ...props, title: undefined }, children, hasChildren);
  return (
    <div className={`flex min-w-0 gap-2.5 rounded-xl border px-3 py-2.5 ${tone.shell}`}>
      <tone.Icon size={15} weight="fill" className={`mt-px flex-shrink-0 ${tone.icon}`} />
      <div className="min-w-0 flex-1">
        {title && (
          <div className="text-[13px] leading-[18px] font-medium tracking-[-0.1px] text-kumo-default">
            {title}
          </div>
        )}
        {body !== null && (
          <div className={`text-[13px] leading-[18px] tracking-[-0.1px] text-kumo-subtle ${title ? "mt-0.5" : ""}`}>
            {body}
          </div>
        )}
      </div>
    </div>
  );
};

const KeyValue: CatalogComponent = ({ props }) => {
  const entries = list(props.items ?? props.entries ?? props.pairs).map((item) => {
    if (item !== null && typeof item === "object") {
      const record = item as Record<string, unknown>;
      return {
        label: str(record.label ?? record.key ?? record.name),
        value: record.value ?? record.text,
      };
    }
    return { label: str(item), value: undefined };
  }).filter((entry) => entry.label !== "");
  if (entries.length === 0) return null;

  return (
    <dl className="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] gap-x-5 gap-y-1.5">
      {entries.map((entry, index) => (
        <div key={index} className="contents">
          <dt className="text-[13px] leading-[18px] tracking-[-0.1px] text-kumo-inactive">
            {entry.label}
          </dt>
          <dd
            className={`min-w-0 break-words text-[13px] leading-[18px] tracking-[-0.1px] text-kumo-default ${
              isNumericValue(entry.value) ? "tabular-nums" : ""
            }`}
          >
            {displayValue(entry.value)}
          </dd>
        </div>
      ))}
    </dl>
  );
};

/**
 * The catalog, by name.
 *
 * Keyed by the exact names in `GENERATIVE_UI_CATALOG` -- the lookup is case-sensitive, because JSX
 * element names are, and a `<card>` that silently became a `<Card>` would hide a real prompt bug.
 */
export const CATALOG: Record<string, CatalogComponent> = {
  Stack, Row, Card, Text, Heading, Badge, Divider, Button,
  Input, Select, Checkbox, Slider, Table, ProgressBar, Callout, KeyValue,
};

/**
 * What a name outside the catalog renders as.
 *
 * Forward compatibility, not error reporting: a tree stored by a deployment with a larger catalog
 * must still be readable here, and the honest way to show a component this build can't draw is an
 * inert, clearly-labelled gap -- not a thrown render, and not silence, which would misrepresent
 * the interface the agent actually composed. Children still render inside it, so a wrapper this
 * build doesn't know doesn't take its contents down with it.
 */
export function UnsupportedComponent({ type, children }: { type: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-dashed border-kumo-line bg-kumo-tint/40 px-2.5 py-1.5">
      <span className="font-mono text-[11px] leading-4 text-kumo-inactive">
        {type} · unsupported component
      </span>
      {children !== null && <div className="mt-1.5 flex min-w-0 flex-col gap-2">{children}</div>}
    </div>
  );
}
