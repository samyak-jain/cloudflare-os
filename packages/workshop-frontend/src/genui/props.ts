/**
 * Prop coercion for catalog components.
 *
 * A tree is model output. Its props were validated for *shape* by the sandbox, but a `size` may
 * still be `"medium"` where the catalog says `"md"`, and a `max` may arrive as the string `"100"`.
 * Every reader here answers with a usable value instead of failing, because the alternative --
 * a card that renders an error where a heading should be -- is worse than a card that renders a
 * heading at the default size.
 */

/** A string prop, or `fallback` when absent. Numbers and booleans are stringified. */
export function str(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

/** A finite number prop, accepting the numeric strings a JSX attribute often carries. */
export function num(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/** A boolean prop. A bare JSX attribute (`disabled`) arrives as `true`; `"false"` means false. */
export function bool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "true" || value === "") return true;
    if (value === "false") return false;
  }
  return fallback;
}

/**
 * A prop constrained to a set of variants, matched case-insensitively.
 *
 * `variants` is keyed by the accepted name so the caller's class table doubles as the whitelist.
 */
export function variant<T extends string>(
  value: unknown,
  variants: Record<T, unknown>,
  // `NoInfer` so the variant set alone decides `T`; without it the fallback narrows the return to
  // its own literal type and every comparison against another variant looks impossible.
  fallback: NoInfer<T>,
): T {
  if (typeof value !== "string") return fallback;
  const lowered = value.toLowerCase();
  for (const key of Object.keys(variants) as T[]) {
    if (key.toLowerCase() === lowered) return key;
  }
  return fallback;
}

/** An array prop, or an empty array. A lone object/string is treated as a one-element list. */
export function list(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

/**
 * Below this, an integer is left alone: years, ports, and small counts read worse with a separator
 * than without one. Above it, an unseparated number is genuinely hard to read at a glance.
 */
const GROUP_DIGITS_ABOVE = 9999;

/**
 * How a value from a data prop (a table cell, a key-value entry) is displayed.
 *
 * Objects are the interesting case: a model that puts one in a cell meant *something*, and JSON is
 * a more honest answer than `[object Object]`.
 *
 * Large integers are digit-grouped. This is a display decision the renderer is better placed to
 * make than the model: `18420913` in a table is a number nobody reads, and asking the prompt to
 * pre-format its data would trade tokens for something the locale already knows how to do.
 */
export function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "—";
    return Number.isInteger(value) && Math.abs(value) > GROUP_DIGITS_ABOVE
      ? value.toLocaleString()
      : String(value);
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  try {
    return JSON.stringify(value) ?? "—";
  } catch {
    return "—";
  }
}

/** Whether a cell should be right-aligned and tabular: numbers line up on their decimal point. */
export function isNumericValue(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value));
}
