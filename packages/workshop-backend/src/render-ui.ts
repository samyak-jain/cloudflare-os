// renderUI deliberately vendors a tiny JSX transform and runtime instead of depending on
// jsx2ui. The transform only rewrites JSX syntax; the resulting JavaScript executes in a fresh
// Dynamic Worker. The runtime is shipped into that worker as source, builds plain nodes, applies
// strict catalog schemas, and checks the serialized result size before it crosses the isolate
// boundary. This keeps the dependency and trust surface small while preserving ordinary
// JavaScript expressions inside JSX.

import {
  GENERATIVE_UI_CATALOG_VERSION,
  type GenerativeUiBinding,
  type GenerativeUiComponent,
  type GenerativeUiNode,
  type GenerativeUiResult,
} from "@gadgets/workshop-shared/api";
import type {WorkerEntrypoint} from "cloudflare:workers";

/** Version of the backend/frontend renderUI component catalog and validation contract. */
export const RENDER_UI_CATALOG_VERSION = GENERATIVE_UI_CATALOG_VERSION;

/** Maximum UTF-8 size of JSX accepted from a model. */
export const MAX_RENDER_UI_SOURCE_BYTES = 64 * 1024;

/** Maximum UTF-8 size of a validated renderUI tree. */
export const MAX_RENDER_UI_TREE_BYTES = 256 * 1024;

const MAX_RENDER_UI_STATE_BYTES = 64 * 1024;
const RENDER_UI_CPU_MS = 1_000;

type JsonValue = null | boolean | number | string | JsonValue[] | {[key: string]: JsonValue};

type StringSchema = {
  type: "string";
  enum?: string[];
  minLength?: number;
  maxLength?: number;
  caseInsensitive?: boolean;
};
type NumberSchema = {type: "number"; min?: number; max?: number; coerce?: boolean};
type BooleanSchema = {type: "boolean"};
type ScalarSchema = {type: "scalar"};
type UnionSchema = {type: "union"; variants: ValueSchema[]};
type ArraySchema = {type: "array"; items: ValueSchema; maxLength?: number};
type ObjectSchema = {
  type: "object";
  fields: Record<string, {schema: ValueSchema; optional?: boolean}>;
};
type RecordSchema = {type: "record"; values: ValueSchema};
type ValueSchema = StringSchema | NumberSchema | BooleanSchema | ScalarSchema |
    UnionSchema | ArraySchema | ObjectSchema | RecordSchema;
type PropSchema = {schema: ValueSchema; optional?: boolean; bindable?: boolean};
type ComponentSchema = {children: boolean; props: Record<string, PropSchema>};

const string = (options: Omit<StringSchema, "type"> = {}): StringSchema =>
  ({type: "string", maxLength: 4_096, ...options});
const number = (options: Omit<NumberSchema, "type"> = {}): NumberSchema =>
  ({type: "number", ...options});
const boolean: BooleanSchema = {type: "boolean"};
const optional = (schema: ValueSchema, bindable = false): PropSchema =>
  ({schema, optional: true, ...(bindable ? {bindable: true} : {})});
const required = (schema: ValueSchema): PropSchema => ({schema});

const choice = (values: string[]): StringSchema =>
  string({enum: values, caseInsensitive: true});
const numeric = (options: Omit<NumberSchema, "type" | "coerce"> = {}): NumberSchema =>
  number({...options, coerce: true});
const text = string({maxLength: 4_096});
const label = string({maxLength: 256});
const spacing = choice(["none", "xs", "sm", "md", "lg"]);
const stringOrNumber: UnionSchema = {type: "union", variants: [string(), numeric()]};
const selectOptions: ArraySchema = {
  type: "array", maxLength: 200,
  items: {
    type: "union",
    variants: [string(), {
      type: "object",
      fields: {
        value: {schema: string()},
        label: {schema: label, optional: true},
      },
    }],
  },
};
const tableRows: ArraySchema = {
  type: "array", maxLength: 1_000,
  items: {type: "record", values: {type: "scalar"}},
};
const keyValueItems: ArraySchema = {
  type: "array", maxLength: 500,
  items: {
    type: "object",
    fields: {
      label: {schema: label},
      value: {schema: {type: "scalar"}, optional: true},
    },
  },
};

/**
 * Strict backend validation catalog. It is data (rather than executable validators) so the same
 * schema can be embedded byte-for-byte in each fresh Dynamic Worker isolate.
 */
export const RENDER_UI_CATALOG: Record<string, ComponentSchema> = {
  Stack: {children: true, props: {gap: optional(spacing)}},
  Row: {
    children: true,
    props: {
      gap: optional(spacing),
      align: optional(choice(["start", "center", "end", "baseline"])),
      justify: optional(choice(["start", "center", "end", "between"])),
      wrap: optional(boolean),
    },
  },
  Card: {
    children: true,
    props: {
      title: optional(label), subtitle: optional(label), description: optional(label),
    },
  },
  Text: {
    children: true,
    props: {
      label: optional(text),
      tone: optional(choice(["default", "subtle", "muted", "brand", "success", "warning", "danger"])),
      size: optional(choice(["sm", "md", "lg"])),
      strong: optional(boolean), mono: optional(boolean),
    },
  },
  Heading: {
    children: true,
    props: {label: optional(text), level: optional(numeric({min: 1, max: 3}))},
  },
  Badge: {
    children: true,
    props: {
      label: optional(text),
      tone: optional(choice(["neutral", "brand", "success", "warning", "danger", "info"])),
    },
  },
  Divider: {children: false, props: {}},
  Button: {
    children: true,
    props: {
      action: required(string({minLength: 1, maxLength: 128})),
      label: optional(text),
      variant: optional(choice(["primary", "secondary", "danger"])), disabled: optional(boolean),
    },
  },
  Input: {
    children: false,
    props: {
      value: optional(stringOrNumber, true), label: optional(label),
      placeholder: optional(string({maxLength: 512})),
      description: optional(string({maxLength: 512})), hint: optional(string({maxLength: 512})),
      type: optional(choice(["text", "number", "email", "url", "search", "tel", "password"])),
    },
  },
  Select: {
    children: false,
    props: {
      value: optional(string(), true), options: optional(selectOptions),
      label: optional(label), placeholder: optional(string({maxLength: 512})),
    },
  },
  Checkbox: {
    children: true,
    props: {
      checked: optional(boolean, true), label: optional(label),
      description: optional(string({maxLength: 512})),
    },
  },
  Slider: {
    children: false,
    props: {
      value: optional(numeric(), true), min: optional(numeric()), max: optional(numeric()),
      step: optional(numeric({min: 0})), label: optional(label), valueLabel: optional(label),
    },
  },
  Table: {
    children: false,
    props: {
      columns: optional({
        type: "array", maxLength: 100,
        items: {
          type: "union",
          variants: [string({minLength: 1, maxLength: 128}), {
            type: "object",
            fields: {
              key: {schema: string({minLength: 1, maxLength: 128})},
              label: {schema: label, optional: true},
              align: {schema: choice(["left", "right"]), optional: true},
            },
          }],
        },
      }),
      rows: optional(tableRows), data: optional(tableRows), items: optional(tableRows),
    },
  },
  ProgressBar: {
    children: false,
    props: {
      value: optional(numeric({min: 0})), max: optional(numeric({min: 0})),
      label: optional(label), valueLabel: optional(label), showValue: optional(boolean),
    },
  },
  Callout: {
    children: true,
    props: {
      label: optional(text), title: optional(label),
      tone: optional(choice(["info", "success", "warning", "danger"])),
    },
  },
  KeyValue: {
    children: false,
    props: {
      items: optional(keyValueItems), entries: optional(keyValueItems), pairs: optional(keyValueItems),
    },
  },
} satisfies Record<GenerativeUiComponent, ComponentSchema>;

function sourceByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function syntaxError(source: string, offset: number, message: string): Error {
  let line = source.slice(0, offset).split("\n").length;
  let column = offset - source.lastIndexOf("\n", offset - 1);
  return new Error(`Invalid renderUI JSX at ${line}:${column}: ${message}`);
}

function decodeEntities(value: string): string {
  return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&amp;", "&");
}

function scanQuoted(source: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
    } else if (source[i] === quote) {
      return i + 1;
    } else {
      i++;
    }
  }
  throw syntaxError(source, start, "unterminated string literal");
}

function scanComment(source: string, start: number): number {
  if (source[start + 1] === "/") {
    let end = source.indexOf("\n", start + 2);
    return end < 0 ? source.length : end;
  }
  if (source[start + 1] === "*") {
    let end = source.indexOf("*/", start + 2);
    if (end < 0) throw syntaxError(source, start, "unterminated comment");
    return end + 2;
  }
  return start;
}

function maskLiteralsAndComments(source: string): string {
  let chars = [...source];
  let i = 0;
  while (i < source.length) {
    let c = source[i];
    let end = i;
    if (c === '"' || c === "'" || c === "`") {
      end = scanQuoted(source, i, c);
    } else if (c === "/" && (source[i + 1] === "/" || source[i + 1] === "*")) {
      end = scanComment(source, i);
    }
    if (end > i) {
      for (let offset = i; offset < end; offset++) {
        if (chars[offset] !== "\n") chars[offset] = " ";
      }
      i = end;
    } else {
      i++;
    }
  }
  return chars.join("");
}

function transformJavaScript(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    let c = source[i];
    if (c === '"' || c === "'" || c === "`") {
      let end = scanQuoted(source, i, c);
      out += source.slice(i, end);
      i = end;
      continue;
    }
    if (c === "/" && (source[i + 1] === "/" || source[i + 1] === "*")) {
      let end = scanComment(source, i);
      out += source.slice(i, end);
      i = end;
      continue;
    }
    if (c === "<" && (source[i + 1] === ">" || /[A-Za-z]/.test(source[i + 1] ?? ""))) {
      let parsed = parseElement(source, i);
      out += parsed.code;
      i = parsed.end;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function readBraced(source: string, start: number): {expression: string; end: number} {
  let depth = 1;
  let i = start + 1;
  while (i < source.length) {
    let c = source[i];
    if (c === '"' || c === "'" || c === "`") {
      i = scanQuoted(source, i, c);
      continue;
    }
    if (c === "/" && (source[i + 1] === "/" || source[i + 1] === "*")) {
      i = scanComment(source, i);
      continue;
    }
    if (c === "{") depth++;
    if (c === "}" && --depth === 0) {
      return {expression: source.slice(start + 1, i), end: i + 1};
    }
    i++;
  }
  throw syntaxError(source, start, "unterminated JSX expression");
}

function parseName(source: string, start: number, kind: string): {name: string; end: number} {
  let match = /^[A-Za-z][A-Za-z0-9_-]*/.exec(source.slice(start));
  if (!match) throw syntaxError(source, start, `expected ${kind} name`);
  return {name: match[0], end: start + match[0].length};
}

function skipSpace(source: string, start: number): number {
  let i = start;
  while (/\s/.test(source[i] ?? "")) i++;
  return i;
}

function parseElement(source: string, start: number): {code: string; end: number} {
  let i = start + 1;
  let fragment = source[i] === ">";
  let tag = "Fragment";
  if (fragment) {
    i++;
  } else {
    let parsed = parseName(source, i, "component");
    tag = parsed.name;
    i = parsed.end;
  }

  let props: string[] = [];
  let propNames = new Set<string>();
  let selfClosing = false;
  if (!fragment) {
    while (true) {
      i = skipSpace(source, i);
      if (source.startsWith("/>", i)) {
        selfClosing = true;
        i += 2;
        break;
      }
      if (source[i] === ">") {
        i++;
        break;
      }
      if (source.startsWith("{...", i)) {
        throw syntaxError(source, i, "spread props are not allowed; list each catalog prop");
      }
      let parsed = parseName(source, i, "prop");
      let name = parsed.name;
      if (propNames.has(name)) throw syntaxError(source, i, `duplicate prop ${name}`);
      propNames.add(name);
      i = skipSpace(source, parsed.end);
      let value = "true";
      if (source[i] === "=") {
        i = skipSpace(source, i + 1);
        if (source[i] === '"' || source[i] === "'") {
          let quote = source[i];
          let end = scanQuoted(source, i, quote);
          value = JSON.stringify(decodeEntities(source.slice(i + 1, end - 1)));
          i = end;
        } else if (source[i] === "{") {
          let braced = readBraced(source, i);
          if (!braced.expression.trim()) {
            throw syntaxError(source, i, `prop ${name} has an empty expression`);
          }
          value = `(${transformJavaScript(braced.expression)})`;
          i = braced.end;
        } else {
          throw syntaxError(source, i, `prop ${name} must use a quoted or braced value`);
        }
      }
      props.push(`${JSON.stringify(name)}:${value}`);
    }
  }

  let children: string[] = [];
  if (!selfClosing) {
    while (true) {
      if (i >= source.length) {
        throw syntaxError(source, start, `missing closing tag for ${fragment ? "fragment" : tag}`);
      }
      if (source.startsWith("</", i)) {
        i += 2;
        if (fragment) {
          if (source[i] !== ">") throw syntaxError(source, i, "expected </> for fragment");
          i++;
        } else {
          let closing = parseName(source, i, "closing component");
          if (closing.name !== tag) {
            throw syntaxError(source, i, `expected </${tag}>, received </${closing.name}>`);
          }
          i = skipSpace(source, closing.end);
          if (source[i] !== ">") throw syntaxError(source, i, `expected > after </${tag}`);
          i++;
        }
        break;
      }
      if (source[i] === "<") {
        let child = parseElement(source, i);
        children.push(child.code);
        i = child.end;
        continue;
      }
      if (source[i] === "{") {
        let braced = readBraced(source, i);
        let expression = braced.expression.trim();
        if (expression && !expression.startsWith("/*")) {
          children.push(`(${transformJavaScript(braced.expression)})`);
        }
        i = braced.end;
        continue;
      }
      let end = i;
      while (end < source.length && source[end] !== "<" && source[end] !== "{") end++;
      let text = decodeEntities(source.slice(i, end)).replace(/\s+/g, " ");
      if (text.trim()) children.push(JSON.stringify(text));
      i = end;
    }
  }

  let type = fragment ? "Fragment" : JSON.stringify(tag);
  let args = [type, `{${props.join(",")}}`, ...children];
  return {code: `jsx(${args.join(",")})`, end: i};
}

/**
 * Transform a JavaScript expression containing JSX into calls to the vendored plain-node JSX
 * runtime. Imports, require(), spread props, and malformed JSX are rejected before execution.
 */
export function transformRenderUIJsx(source: string): string {
  let bytes = sourceByteLength(source);
  if (bytes > MAX_RENDER_UI_SOURCE_BYTES) {
    throw new Error(`renderUI JSX exceeds the ${MAX_RENDER_UI_SOURCE_BYTES}-byte source limit.`);
  }
  if (!source.trim()) throw new Error("renderUI JSX cannot be empty.");
  let codeOnly = maskLiteralsAndComments(source);
  if (/\bimport(?:\s|\(|\.)/.test(codeOnly)) {
    throw new Error("renderUI JSX cannot import modules. Allowed globals: jsx catalog and bind().");
  }
  if (/\brequire\s*\(/.test(codeOnly)) {
    throw new Error("renderUI JSX cannot call require(). Allowed globals: jsx catalog and bind().");
  }
  if (/\bwhile\s*\(\s*true\s*\)|\bfor\s*\(\s*;\s*;\s*\)/.test(codeOnly)) {
    throw new Error(
        `renderUI JSX contains an unconditional loop that would exceed the ` +
        `${RENDER_UI_CPU_MS}ms isolate CPU limit.`);
  }
  let withoutTrailingSemicolon = source.trim().replace(/;\s*$/, "");
  return transformJavaScript(withoutTrailingSemicolon);
}

const RUNTIME_SOURCE = `
const CATALOG = ${JSON.stringify(RENDER_UI_CATALOG)};
const CATALOG_VERSION = ${RENDER_UI_CATALOG_VERSION};
const MAX_TREE_BYTES = ${MAX_RENDER_UI_TREE_BYTES};
const MAX_STATE_BYTES = ${MAX_RENDER_UI_STATE_BYTES};
const MAX_DEPTH = 64;
const MAX_NODES = 5000;
const BLOCKED_KEYS = new Set(["__proto__", "prototype", "constructor"]);
export const Fragment = Symbol("Fragment");

export function bind(statePath) {
  return {$bind: statePath};
}

export function jsx(type, props, ...children) {
  if (type === Fragment) return children;
  return {type, props: props ?? {}, children};
}

function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  let prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertJson(value, path, depth = 0) {
  if (depth > MAX_DEPTH) throw new Error(path + " exceeds the maximum nesting depth.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(path + " must contain only finite numbers.");
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) assertJson(value[i], path + "[" + i + "]", depth + 1);
    return;
  }
  if (!plainObject(value)) throw new Error(path + " must contain only JSON values.");
  for (let [key, child] of Object.entries(value)) {
    if (BLOCKED_KEYS.has(key)) throw new Error(path + " contains forbidden key " + key + ".");
    assertJson(child, path + "." + key, depth + 1);
  }
}

function statePaths(state) {
  if (!plainObject(state)) throw new Error("renderUI state must be a JSON object.");
  assertJson(state, "state");
  let encoded = JSON.stringify(state);
  if (new TextEncoder().encode(encoded).byteLength > MAX_STATE_BYTES) {
    throw new Error("renderUI state exceeds the " + MAX_STATE_BYTES + "-byte limit.");
  }
  let paths = new Map();
  function visit(value, path) {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        visit(value[index], path ? path + "." + index : String(index));
      }
    } else if (plainObject(value)) {
      for (let [key, child] of Object.entries(value)) {
        if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) || BLOCKED_KEYS.has(key)) {
          throw new Error("Invalid renderUI state key " + JSON.stringify(key) + ".");
        }
        visit(child, path ? path + "." + key : key);
      }
    } else {
      paths.set(path, value);
    }
  }
  visit(state, "");
  return paths;
}

function schemaName(schema) {
  if (schema.type === "string" && schema.enum) return schema.enum.map(JSON.stringify).join(" | ");
  if (schema.type === "union") return schema.variants.map(schemaName).join(" or ");
  if (schema.type === "array") return "array";
  if (schema.type === "object" || schema.type === "record") return "object";
  if (schema.type === "scalar") return "string, number, boolean, or null";
  return schema.type;
}

function validateValue(value, schema, path) {
  switch (schema.type) {
    case "string": {
      if (typeof value !== "string") throw new Error(path + " must be a string.");
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        throw new Error(path + " must not be empty.");
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        throw new Error(path + " exceeds its " + schema.maxLength + "-character limit.");
      }
      if (schema.enum) {
        let matched = schema.caseInsensitive
          ? schema.enum.find(candidate => candidate.toLowerCase() === value.toLowerCase())
          : schema.enum.find(candidate => candidate === value);
        if (matched === undefined) {
          throw new Error(path + " must be one of: " + schemaName(schema) + ".");
        }
        value = matched;
      }
      return value;
    }
    case "number": {
      if (schema.coerce && typeof value === "string" && value.trim() !== "") {
        value = Number(value);
      }
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(path + " must be a finite number or numeric string.");
      }
      if (schema.min !== undefined && value < schema.min) {
        throw new Error(path + " must be at least " + schema.min + ".");
      }
      if (schema.max !== undefined && value > schema.max) {
        throw new Error(path + " must be at most " + schema.max + ".");
      }
      return value;
    }
    case "boolean":
      if (typeof value !== "boolean") throw new Error(path + " must be a boolean.");
      return value;
    case "scalar":
      if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
        throw new Error(path + " must be a string, number, boolean, or null.");
      }
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new Error(path + " must be finite.");
      }
      return value;
    case "union": {
      let errors = [];
      for (let variant of schema.variants) {
        try {
          return validateValue(value, variant, path);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      throw new Error(path + " must match " + schemaName(schema) + ". " + errors.join(" "));
    }
    case "array":
      if (!Array.isArray(value)) throw new Error(path + " must be an array.");
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        throw new Error(path + " may contain at most " + schema.maxLength + " items.");
      }
      return value.map((item, index) => validateValue(item, schema.items, path + "[" + index + "]"));
    case "object": {
      if (!plainObject(value)) throw new Error(path + " must be an object.");
      let allowed = Object.keys(schema.fields);
      for (let key of Object.keys(value)) {
        if (!schema.fields[key]) {
          throw new Error(path + " has unknown field " + JSON.stringify(key) +
            ". Allowed fields: " + allowed.join(", ") + ".");
        }
      }
      let result = {};
      for (let [key, field] of Object.entries(schema.fields)) {
        if (value[key] === undefined) {
          if (!field.optional) throw new Error(path + "." + key + " is required.");
        } else {
          result[key] = validateValue(value[key], field.schema, path + "." + key);
        }
      }
      return result;
    }
    case "record": {
      if (!plainObject(value)) throw new Error(path + " must be an object.");
      let result = {};
      for (let [key, child] of Object.entries(value)) {
        if (BLOCKED_KEYS.has(key)) throw new Error(path + " contains forbidden key " + key + ".");
        result[key] = validateValue(child, schema.values, path + "." + key);
      }
      return result;
    }
  }
}

function isBind(value) {
  return plainObject(value) && Object.keys(value).length === 1 && typeof value.$bind === "string";
}

function flattenChildren(values, out, path, depth, counter, paths) {
  for (let value of values) {
    if (value === null || value === undefined || typeof value === "boolean") continue;
    if (Array.isArray(value)) {
      flattenChildren(value, out, path, depth, counter, paths);
    } else if (typeof value === "string" || typeof value === "number") {
      out.push(String(value));
    } else {
      out.push(validateNode(value, path + ".children[" + out.length + "]", depth, counter, paths));
    }
  }
}

function validateNode(raw, path, depth, counter, paths) {
  if (depth > MAX_DEPTH) throw new Error(path + " exceeds the maximum tree depth.");
  if (++counter.count > MAX_NODES) throw new Error("renderUI tree exceeds the " + MAX_NODES + "-node limit.");
  if (!plainObject(raw) || typeof raw.type !== "string" || !plainObject(raw.props) ||
      !Array.isArray(raw.children)) {
    throw new Error(path + " is not a JSX component node.");
  }
  let component = CATALOG[raw.type];
  let allowedComponents = Object.keys(CATALOG).join(", ");
  if (!component) {
    throw new Error("Unknown renderUI component " + JSON.stringify(raw.type) +
      ". Allowed components: " + allowedComponents + ".");
  }
  let allowedProps = Object.keys(component.props);
  for (let name of Object.keys(raw.props)) {
    if (/^on[A-Z]/.test(name) || name === "dangerouslySetInnerHTML") {
      throw new Error(path + " attempts to smuggle handler prop " + JSON.stringify(name) +
        ". Event handlers and dangerouslySetInnerHTML are never allowed.");
    }
    if (!component.props[name]) {
      throw new Error(raw.type + " has unknown prop " + JSON.stringify(name) +
        ". Allowed props: " + (allowedProps.join(", ") || "(none)") + ".");
    }
  }
  let props = {};
  for (let [name, prop] of Object.entries(component.props)) {
    let value = raw.props[name];
    if (value === undefined) {
      if (!prop.optional) throw new Error(raw.type + "." + name + " is required.");
      continue;
    }
    if (isBind(value)) {
      if (!prop.bindable) throw new Error(raw.type + "." + name + " cannot be bound to state.");
      if (!paths.has(value.$bind)) {
        let allowed = [...paths.keys()].join(", ") || "(none)";
        throw new Error("Unknown renderUI bind path " + JSON.stringify(value.$bind) +
          ". Allowed bind paths: " + allowed + ".");
      }
      validateValue(paths.get(value.$bind), prop.schema, "state." + value.$bind);
      props[name] = {$bind: value.$bind};
    } else {
      props[name] = validateValue(value, prop.schema, raw.type + "." + name);
    }
  }
  let children = [];
  flattenChildren(raw.children, children, path, depth + 1, counter, paths);
  if (!component.children && children.length > 0) {
    throw new Error(raw.type + " does not accept children. Allowed props: " +
      (allowedProps.join(", ") || "(none)") + ".");
  }
  return {type: raw.type, props, children};
}

export function validateState(state) {
  return {state, paths: statePaths(state)};
}

export function validateRenderResult(raw, prepared) {
  let tree = validateNode(raw, "tree", 0, {count: 0}, prepared.paths);
  let encoded = JSON.stringify(tree);
  let bytes = new TextEncoder().encode(encoded).byteLength;
  if (bytes > MAX_TREE_BYTES) {
    throw new Error("renderUI tree exceeds the " + MAX_TREE_BYTES + "-byte tree limit.");
  }
  return {tree, stateDefaults: prepared.state, catalogVersion: CATALOG_VERSION};
}
`;

const HARNESS_SOURCE = `
import {WorkerEntrypoint} from "cloudflare:workers";
import render from "user.js";
import {validateRenderResult, validateState} from "runtime.js";

export default class extends WorkerEntrypoint {
  async render(stateJson) {
    try {
      let prepared = validateState(JSON.parse(stateJson));
      return JSON.stringify({ok: true, result: validateRenderResult(await render(), prepared)});
    } catch (error) {
      return JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
`;

interface RenderUIEntrypoint extends WorkerEntrypoint {
  render(stateJson: string): Promise<string>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  let prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertJsonValue(value: unknown, path: string, depth = 0): asserts value is JsonValue {
  if (depth > 64) throw new Error(`${path} exceeds the maximum nesting depth.`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number.`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!isPlainRecord(value)) throw new Error(`${path} is not JSON.`);
  for (let [key, child] of Object.entries(value)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new Error(`${path} contains forbidden key ${key}.`);
    }
    assertJsonValue(child, `${path}.${key}`, depth + 1);
  }
}

function assertBind(value: unknown, path: string): asserts value is GenerativeUiBinding {
  if (!isPlainRecord(value) || Object.keys(value).length !== 1 ||
      typeof value.$bind !== "string") {
    throw new Error(`${path} contains an invalid bind marker.`);
  }
}

function assertNode(value: unknown, path: string, depth = 0): asserts value is GenerativeUiNode {
  if (depth > 64 || !isPlainRecord(value) || typeof value.type !== "string" ||
      !isPlainRecord(value.props) || !Array.isArray(value.children)) {
    throw new Error(`${path} is not a valid renderUI node.`);
  }
  if (!(value.type in RENDER_UI_CATALOG)) {
    throw new Error(`${path} returned an unknown component.`);
  }
  for (let [name, prop] of Object.entries(value.props)) {
    if (isPlainRecord(prop) && "$bind" in prop) assertBind(prop, `${path}.props.${name}`);
    else assertJsonValue(prop, `${path}.props.${name}`, depth + 1);
  }
  value.children.forEach((child, index) => {
    if (typeof child !== "string") assertNode(child, `${path}.children[${index}]`, depth + 1);
  });
}

function assertRenderUIResult(value: unknown): asserts value is GenerativeUiResult {
  if (!isPlainRecord(value) || value.catalogVersion !== RENDER_UI_CATALOG_VERSION ||
      !isPlainRecord(value.stateDefaults)) {
    throw new Error("The renderUI isolate returned an invalid result envelope.");
  }
  assertNode(value.tree, "tree");
  assertJsonValue(value.stateDefaults, "stateDefaults");
}

/** Execute transformed JSX in a fresh, outbound-disabled Dynamic Worker and return its tree. */
export async function executeRenderUI(
    loader: WorkerLoader, jsxSource: string,
    stateDefaults: Record<string, unknown> = {}): Promise<GenerativeUiResult> {
  assertJsonValue(stateDefaults, "state");
  let transformed = transformRenderUIJsx(jsxSource);
  let worker: WorkerLoaderWorkerCode = {
    compatibilityDate: "2026-08-01",
    compatibilityFlags: ["disallow_importable_env"],
    limits: {cpuMs: RENDER_UI_CPU_MS, subRequests: 0},
    mainModule: "harness.js",
    modules: {
      "harness.js": HARNESS_SOURCE,
      "runtime.js": RUNTIME_SOURCE,
      "user.js": `import {jsx, bind} from "runtime.js";\n` +
          `export default async function renderUIExpression() {\n` +
          `  return (${transformed});\n` +
          `}\n`,
    },
    env: {},
    globalOutbound: null,
  };
  let entrypoint = loader.load(worker).getEntrypoint<RenderUIEntrypoint>(undefined, {
    limits: {cpuMs: RENDER_UI_CPU_MS, subRequests: 0},
  });
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timeout = new Promise<never>((_resolve, reject) => {
    // Production enforces cpuMs directly. This wall-clock fence also covers a program that only
    // waits, and keeps local workerd versions that do not enforce custom CPU limits from wedging
    // the parent invocation forever.
    timeoutId = setTimeout(() => reject(new Error(
        `renderUI isolate exceeded its ${RENDER_UI_CPU_MS}ms CPU limit.`)),
    RENDER_UI_CPU_MS * 2);
  });
  let invocation = Promise.resolve(entrypoint.render(JSON.stringify(stateDefaults)));
  let encodedResult: string;
  try {
    encodedResult = await Promise.race([invocation, timeout]);
  } finally {
    clearTimeout(timeoutId);
    invocation.catch(() => {});
    (entrypoint as unknown as {[Symbol.dispose]?(): void})[Symbol.dispose]?.();
  }
  let envelope: unknown = JSON.parse(encodedResult);
  if (!isPlainRecord(envelope) || typeof envelope.ok !== "boolean") {
    throw new Error("The renderUI isolate returned an invalid response envelope.");
  }
  if (!envelope.ok) {
    throw new Error(typeof envelope.error === "string"
      ? envelope.error : "The renderUI isolate rejected the expression.");
  }
  let result: unknown = envelope.result;
  assertRenderUIResult(result);
  return result;
}

/** Return every {$bind:path} marker used by a validated renderUI tree. */
export function listRenderUIBindPaths(tree: GenerativeUiNode): string[] {
  let paths = new Set<string>();
  function visit(node: GenerativeUiNode) {
    for (let value of Object.values(node.props)) {
      if (isPlainRecord(value) && typeof value.$bind === "string") paths.add(value.$bind);
    }
    for (let child of node.children) if (typeof child !== "string") visit(child);
  }
  visit(tree);
  return [...paths].toSorted();
}

/** Resolve a dot path from validated renderUI state defaults. */
export function renderUIStateValue(
    state: Record<string, unknown>, statePath: string): unknown {
  let value: unknown = state;
  for (let part of statePath.split(".")) {
    if (Array.isArray(value)) {
      let index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= value.length) return undefined;
      value = value[index];
    } else if (isPlainRecord(value) && part in value) {
      value = value[part];
    } else {
      return undefined;
    }
  }
  return value;
}

function validateBoundStateValue(value: unknown, schema: ValueSchema, path: string): void {
  if (schema.type === "union") {
    let errors: unknown[] = [];
    for (let variant of schema.variants) {
      try {
        validateBoundStateValue(value, variant, path);
        return;
      } catch (error) {
        errors.push(error);
      }
    }
    throw new Error(`${path} does not match its bound control type: ` +
        errors.map(error => error instanceof Error ? error.message : String(error)).join(" "));
  }
  if (schema.type === "string") {
    if (typeof value !== "string") throw new Error(`${path} must be a string.`);
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      throw new Error(`${path} is too short.`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      throw new Error(`${path} is too long.`);
    }
    if (schema.enum && !schema.enum.some(candidate => schema.caseInsensitive
      ? candidate.toLowerCase() === value.toLowerCase() : candidate === value)) {
      throw new Error(`${path} must be one of: ${schema.enum.join(", ")}.`);
    }
    return;
  }
  if (schema.type === "number") {
    let numericValue = schema.coerce && typeof value === "string" && value.trim() !== ""
      ? Number(value) : value;
    if (typeof numericValue !== "number" || !Number.isFinite(numericValue)) {
      throw new Error(`${path} must be a finite number or numeric string.`);
    }
    if (schema.min !== undefined && numericValue < schema.min) {
      throw new Error(`${path} must be at least ${schema.min}.`);
    }
    if (schema.max !== undefined && numericValue > schema.max) {
      throw new Error(`${path} must be at most ${schema.max}.`);
    }
    return;
  }
  if (schema.type === "boolean") {
    if (typeof value !== "boolean") throw new Error(`${path} must be a boolean.`);
    return;
  }
  throw new Error(`${path} uses an unsupported bound state schema.`);
}

/** Validate one whole-state mirror against the bindings in a previously validated tree. */
export function validateRenderUIState(
    tree: GenerativeUiNode, state: Record<string, unknown>): void {
  assertJsonValue(state, "state");
  if (sourceByteLength(JSON.stringify(state)) > MAX_RENDER_UI_STATE_BYTES) {
    throw new Error(`renderUI state exceeds the ${MAX_RENDER_UI_STATE_BYTES}-byte limit.`);
  }
  function visit(node: GenerativeUiNode) {
    let component = RENDER_UI_CATALOG[node.type];
    if (!component) throw new Error(`Unknown renderUI component ${JSON.stringify(node.type)}.`);
    for (let [name, marker] of Object.entries(node.props)) {
      if (!isPlainRecord(marker) || typeof marker.$bind !== "string") continue;
      let prop = component.props[name];
      if (!prop?.bindable) {
        throw new Error(`${node.type}.${name} is not a bindable renderUI prop.`);
      }
      let value = renderUIStateValue(state, marker.$bind);
      if (value === undefined) {
        throw new Error(`Missing renderUI state path ${JSON.stringify(marker.$bind)}.`);
      }
      validateBoundStateValue(value, prop.schema, `state.${marker.$bind}`);
    }
    for (let child of node.children) if (typeof child !== "string") visit(child);
  }
  visit(tree);
}

/** Replace an existing dot path in a validated whole-state object. */
export function setRenderUIStateValue(
    state: Record<string, unknown>, statePath: string, value: string | number | boolean): void {
  let parts = statePath.split(".");
  let cursor: unknown = state;
  for (let index = 0; index < parts.length; index++) {
    let part = parts[index];
    let last = index === parts.length - 1;
    if (Array.isArray(cursor)) {
      let arrayIndex = Number(part);
      if (!Number.isInteger(arrayIndex) || arrayIndex < 0 || arrayIndex >= cursor.length) {
        throw new Error(`Unknown renderUI state path ${JSON.stringify(statePath)}.`);
      }
      if (last) cursor[arrayIndex] = value;
      else cursor = cursor[arrayIndex];
    } else if (isPlainRecord(cursor) && part in cursor) {
      if (last) cursor[part] = value;
      else cursor = cursor[part];
    } else {
      throw new Error(`Unknown renderUI state path ${JSON.stringify(statePath)}.`);
    }
  }
}

/** Whether a validated tree contains an enabled Button with the requested action. */
export function hasRenderUIButtonAction(tree: GenerativeUiNode, action: string): boolean {
  if (tree.type === "Button" && tree.props.action === action && tree.props.disabled !== true) {
    return true;
  }
  return tree.children.some(child =>
    typeof child !== "string" && hasRenderUIButtonAction(child, action));
}

/** Count component nodes for the compact model-facing renderUI success summary. */
export function countRenderUINodes(tree: GenerativeUiNode): number {
  return 1 + tree.children.reduce((count, child) =>
    count + (typeof child === "string" ? 0 : countRenderUINodes(child)), 0);
}

/** Build the compact success text shown to the model for live calls and history replay. */
export function summarizeRenderUIResult(result: GenerativeUiResult): string {
  let nodes = countRenderUINodes(result.tree);
  let binds = listRenderUIBindPaths(result.tree).length;
  return `Rendered ${nodes} catalog component${nodes === 1 ? "" : "s"} ` +
      `(catalog v${result.catalogVersion}) with ${binds} bound state ` +
      `path${binds === 1 ? "" : "s"}.`;
}
