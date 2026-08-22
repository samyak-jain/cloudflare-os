// renderUI parses JSX as data in the trusted Worker. Model-authored source is never evaluated or
// loaded as JavaScript: a deliberately tiny AST interpreter accepts only catalog elements,
// literals, and bind("path"), then the independent tree validator reconstructs the durable JSON.

import {
  GENERATIVE_UI_CATALOG_VERSION,
  type GenerativeUiBinding,
  type GenerativeUiComponent,
  type GenerativeUiNode,
  type GenerativeUiResult,
} from "@gadgets/workshop-shared/api";
import {Parser, type Node} from "acorn";
import jsx from "acorn-jsx";

/** Version of the backend/frontend renderUI component catalog and validation contract. */
export const RENDER_UI_CATALOG_VERSION = GENERATIVE_UI_CATALOG_VERSION;

/** Maximum UTF-8 size of JSX accepted from a model. */
export const MAX_RENDER_UI_SOURCE_BYTES = 64 * 1024;

/** Maximum UTF-8 size of a validated renderUI tree. */
export const MAX_RENDER_UI_TREE_BYTES = 256 * 1024;

const MAX_RENDER_UI_STATE_BYTES = 64 * 1024;
const MAX_RENDER_UI_DEPTH = 64;
const MAX_RENDER_UI_NODES = 5_000;
const MAX_RENDER_UI_AST_NODES = 20_000;
const BLOCKED_JSON_KEYS = new Set(["__proto__", "prototype", "constructor"]);

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
 * Strict backend validation catalog shared by the JSX interpreter and authoritative tree pass.
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

const JsxParser = Parser.extend(jsx({
  allowNamespaces: false,
  allowNamespacedObjects: false,
}));

type AstNode = Node & Record<string, unknown>;
type AstBudget = {count: number};

function syntaxError(source: string, offset: number, message: string): Error {
  let line = source.slice(0, offset).split("\n").length;
  let column = offset - source.lastIndexOf("\n", offset - 1);
  return new Error("Invalid renderUI JSX at " + line + ":" + column + ": " + message);
}

function isAstNode(value: unknown): value is AstNode {
  return value !== null && typeof value === "object" &&
      typeof (value as {type?: unknown}).type === "string" &&
      typeof (value as {start?: unknown}).start === "number";
}

function astNode(source: string, value: unknown, parent: AstNode, field: string): AstNode {
  if (!isAstNode(value)) {
    throw syntaxError(source, parent.start, parent.type + "." + field + " is malformed.");
  }
  return value;
}

function astNodes(source: string, value: unknown, parent: AstNode, field: string): AstNode[] {
  if (!Array.isArray(value) || !value.every(isAstNode)) {
    throw syntaxError(source, parent.start, parent.type + "." + field + " is malformed.");
  }
  return value;
}

function enterAst(source: string, node: AstNode, depth: number, budget: AstBudget): void {
  if (depth > MAX_RENDER_UI_DEPTH) {
    throw syntaxError(source, node.start, "literal/element nesting exceeds the maximum depth.");
  }
  if (++budget.count > MAX_RENDER_UI_AST_NODES) {
    throw syntaxError(source, node.start,
        "JSX exceeds the " + MAX_RENDER_UI_AST_NODES + "-node syntax budget.");
  }
}

function rejectAst(source: string, node: AstNode, context: string): never {
  throw syntaxError(source, node.start, node.type + " is not allowed in " + context +
      ". Allowed syntax is catalog JSX, JSON literals, and bind(\"path\").");
}

function literalValue(source: string, node: AstNode): JsonValue {
  if (node.type !== "Literal") rejectAst(source, node, "a literal value");
  let value = node.value;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return rejectAst(source, node, "a JSON literal");
}

function objectKey(source: string, node: AstNode): string {
  if (node.type === "Identifier" && typeof node.name === "string") return node.name;
  if (node.type === "Literal") {
    let value = literalValue(source, node);
    if (typeof value === "string" || typeof value === "number") return String(value);
  }
  return rejectAst(source, node, "an object key");
}

function interpretValue(
    source: string, node: AstNode, depth: number, budget: AstBudget,
    allowBind: boolean): JsonValue | GenerativeUiBinding {
  enterAst(source, node, depth, budget);
  if (node.type === "Literal") return literalValue(source, node);

  if (node.type === "ArrayExpression") {
    let elements = node.elements;
    if (!Array.isArray(elements)) return rejectAst(source, node, "an array literal");
    return elements.map((element, index) => {
      if (element === null || !isAstNode(element)) {
        throw syntaxError(source, node.start, "array literals cannot contain holes at index " + index + ".");
      }
      if (element.type === "SpreadElement") {
        return rejectAst(source, element, "an array literal");
      }
      return interpretValue(source, element, depth + 1, budget, false) as JsonValue;
    });
  }

  if (node.type === "ObjectExpression") {
    let result: {[key: string]: JsonValue} = Object.create(null);
    for (let property of astNodes(source, node.properties, node, "properties")) {
      enterAst(source, property, depth + 1, budget);
      if (property.type !== "Property" || property.kind !== "init" ||
          property.method === true || property.computed === true || property.shorthand === true) {
        rejectAst(source, property, "an object literal");
      }
      let keyNode = astNode(source, property.key, property, "key");
      enterAst(source, keyNode, depth + 2, budget);
      let key = objectKey(source, keyNode);
      if (key === "$bind") {
        throw syntaxError(source, keyNode.start,
            "raw $bind objects are not accepted in JSX; use bind(\"path\") instead.");
      }
      if (BLOCKED_JSON_KEYS.has(key)) {
        throw syntaxError(source, keyNode.start, "object key " + JSON.stringify(key) + " is forbidden.");
      }
      if (Object.hasOwn(result, key)) {
        throw syntaxError(source, keyNode.start, "duplicate object key " + JSON.stringify(key) + ".");
      }
      let valueNode = astNode(source, property.value, property, "value");
      Object.defineProperty(result, key, {
        value: interpretValue(source, valueNode, depth + 2, budget, false) as JsonValue,
        enumerable: true,
      });
    }
    return result;
  }

  if (node.type === "CallExpression" && allowBind) {
    let callee = astNode(source, node.callee, node, "callee");
    let args = astNodes(source, node.arguments, node, "arguments");
    if (callee.type !== "Identifier" || callee.name !== "bind" || args.length !== 1) {
      return rejectAst(source, node, "a prop value");
    }
    enterAst(source, callee, depth + 1, budget);
    let argument = args[0];
    enterAst(source, argument, depth + 1, budget);
    if (argument.type !== "Literal" || typeof argument.value !== "string" ||
        argument.value.length === 0) {
      throw syntaxError(source, argument.start,
          "bind() requires exactly one non-empty string literal path.");
    }
    return {$bind: argument.value};
  }

  return rejectAst(source, node, "a prop value");
}

function jsxName(source: string, value: unknown, parent: AstNode): string {
  let node = astNode(source, value, parent, "name");
  if (node.type !== "JSXIdentifier" || typeof node.name !== "string") {
    return rejectAst(source, node, "a component or prop name");
  }
  return node.name;
}

function interpretAttribute(
    source: string, attribute: AstNode, depth: number, budget: AstBudget): [string, unknown] {
  enterAst(source, attribute, depth, budget);
  if (attribute.type === "JSXSpreadAttribute") {
    rejectAst(source, attribute, "component props");
  }
  if (attribute.type !== "JSXAttribute") {
    rejectAst(source, attribute, "component props");
  }
  let name = jsxName(source, attribute.name, attribute);
  if (/^on[A-Z]/.test(name) || name === "dangerouslySetInnerHTML" ||
      BLOCKED_JSON_KEYS.has(name)) {
    throw syntaxError(source, attribute.start, "forbidden prop " + JSON.stringify(name) +
        " attempts handler or reserved-prop smuggling; event handlers and HTML are never allowed.");
  }
  let value = attribute.value;
  if (value === null) return [name, true];

  let valueNode = astNode(source, value, attribute, "value");
  if (valueNode.type === "Literal") {
    enterAst(source, valueNode, depth + 1, budget);
    return [name, literalValue(source, valueNode)];
  }
  if (valueNode.type !== "JSXExpressionContainer") {
    return rejectAst(source, valueNode, "a prop value");
  }
  enterAst(source, valueNode, depth + 1, budget);
  let expression = astNode(source, valueNode.expression, valueNode, "expression");
  if (expression.type === "JSXEmptyExpression") {
    throw syntaxError(source, expression.start, "prop " + name + " has an empty expression.");
  }
  return [name, interpretValue(source, expression, depth + 2, budget, true)];
}

function jsxText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ") : "";
}

function interpretChildExpression(
    source: string, node: AstNode, depth: number, budget: AstBudget):
    GenerativeUiNode | string | null {
  if (node.type === "JSXElement") return interpretElement(source, node, depth, budget);
  let value = interpretValue(source, node, depth, budget, false);
  if (value === null || typeof value === "boolean") return null;
  if (typeof value === "string" || typeof value === "number") return String(value);
  return rejectAst(source, node, "JSX children");
}

function interpretElement(
    source: string, element: AstNode, depth: number, budget: AstBudget): GenerativeUiNode {
  enterAst(source, element, depth, budget);
  if (element.type !== "JSXElement") return rejectAst(source, element, "the renderUI root");

  let opening = astNode(source, element.openingElement, element, "openingElement");
  enterAst(source, opening, depth + 1, budget);
  let type = jsxName(source, opening.name, opening);
  if (!Object.hasOwn(RENDER_UI_CATALOG, type)) {
    throw syntaxError(source, opening.start, "Unknown renderUI component " + JSON.stringify(type) +
        ". Allowed components: " + Object.keys(RENDER_UI_CATALOG).join(", ") + ".");
  }
  let component = RENDER_UI_CATALOG[type];
  let allowedProps = Object.keys(component.props);
  let props: Record<string, unknown> = Object.create(null);
  for (let attribute of astNodes(source, opening.attributes, opening, "attributes")) {
    let [name, value] = interpretAttribute(source, attribute, depth + 2, budget);
    if (/^on[A-Z]/.test(name) || name === "dangerouslySetInnerHTML" ||
        BLOCKED_JSON_KEYS.has(name)) {
      throw syntaxError(source, attribute.start, "forbidden prop " + JSON.stringify(name) +
          " attempts handler or reserved-prop smuggling; event handlers and HTML are never allowed.");
    }
    if (!Object.hasOwn(component.props, name)) {
      throw syntaxError(source, attribute.start, type + " has unknown prop " + JSON.stringify(name) +
          ". Allowed props: " + (allowedProps.join(", ") || "(none)") + ".");
    }
    if (Object.hasOwn(props, name)) {
      throw syntaxError(source, attribute.start, "duplicate prop " + JSON.stringify(name) + ".");
    }
    Object.defineProperty(props, name, {value, enumerable: true});
  }

  let children: Array<GenerativeUiNode | string> = [];
  for (let child of astNodes(source, element.children, element, "children")) {
    if (child.type === "JSXText") {
      enterAst(source, child, depth + 1, budget);
      let childText = jsxText(child.value);
      if (childText.trim()) children.push(childText);
      continue;
    }
    if (child.type === "JSXElement") {
      children.push(interpretElement(source, child, depth + 1, budget));
      continue;
    }
    if (child.type === "JSXExpressionContainer") {
      enterAst(source, child, depth + 1, budget);
      let expression = astNode(source, child.expression, child, "expression");
      if (expression.type === "JSXEmptyExpression") continue;
      let interpreted = interpretChildExpression(source, expression, depth + 2, budget);
      if (interpreted !== null) children.push(interpreted);
      continue;
    }
    rejectAst(source, child, "JSX children");
  }
  return {type, props, children};
}

function parseRootElement(source: string): GenerativeUiNode {
  let program: AstNode;
  try {
    program = JsxParser.parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
    }) as unknown as AstNode;
  } catch (error) {
    let detail = error instanceof Error ? error.message : String(error);
    throw new Error("Invalid renderUI JSX: " + detail, {cause: error});
  }
  let body = astNodes(source, program.body, program, "body");
  if (body.length !== 1 || body[0].type !== "ExpressionStatement") {
    let received = body.map(statement => statement.type).join(", ") || "empty input";
    throw syntaxError(source, body[0]?.start ?? 0,
        "expected exactly one root catalog element; received " + received + ".");
  }
  let expression = astNode(source, body[0].expression, body[0], "expression");
  if (expression.type !== "JSXElement") {
    return rejectAst(source, expression, "the renderUI root");
  }
  return interpretElement(source, expression, 0, {count: 0});
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  let prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertJsonValue(value: unknown, path: string, depth = 0): asserts value is JsonValue {
  if (depth > MAX_RENDER_UI_DEPTH) throw new Error(`${path} exceeds the maximum nesting depth.`);
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
    if (BLOCKED_JSON_KEYS.has(key)) {
      throw new Error(`${path} contains forbidden key ${key}.`);
    }
    assertJsonValue(child, `${path}.${key}`, depth + 1);
  }
}

function validateBind(value: unknown, path: string): GenerativeUiBinding {
  if (!isPlainRecord(value) || Object.keys(value).length !== 1 ||
      typeof value.$bind !== "string") {
    throw new Error(`${path} contains an invalid bind marker.`);
  }
  if (!value.$bind) throw new Error(`${path} contains an empty bind path.`);
  return {$bind: value.$bind};
}

function schemaName(schema: ValueSchema): string {
  if (schema.type === "string" && schema.enum) {
    return schema.enum.map(value => JSON.stringify(value)).join(" | ");
  }
  if (schema.type === "union") return schema.variants.map(schemaName).join(" or ");
  if (schema.type === "array") return "array";
  if (schema.type === "object" || schema.type === "record") return "object";
  if (schema.type === "scalar") return "string, number, boolean, or null";
  return schema.type;
}

function validateCatalogValue(value: unknown, schema: ValueSchema, path: string): JsonValue {
  switch (schema.type) {
    case "string": {
      if (typeof value !== "string") throw new Error(`${path} must be a string.`);
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        throw new Error(`${path} must not be empty.`);
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        throw new Error(`${path} exceeds its ${schema.maxLength}-character limit.`);
      }
      if (!schema.enum) return value;
      let matched = schema.caseInsensitive
        ? schema.enum.find(candidate => candidate.toLowerCase() === value.toLowerCase())
        : schema.enum.find(candidate => candidate === value);
      if (matched === undefined) {
        throw new Error(`${path} must be one of: ${schemaName(schema)}.`);
      }
      return matched;
    }
    case "number": {
      let normalized = schema.coerce && typeof value === "string" && value.trim() !== ""
        ? Number(value) : value;
      if (typeof normalized !== "number" || !Number.isFinite(normalized)) {
        throw new Error(`${path} must be a finite number or numeric string.`);
      }
      if (schema.min !== undefined && normalized < schema.min) {
        throw new Error(`${path} must be at least ${schema.min}.`);
      }
      if (schema.max !== undefined && normalized > schema.max) {
        throw new Error(`${path} must be at most ${schema.max}.`);
      }
      return normalized;
    }
    case "boolean":
      if (typeof value !== "boolean") throw new Error(`${path} must be a boolean.`);
      return value;
    case "scalar":
      if (value !== null && typeof value !== "string" && typeof value !== "boolean" &&
          (typeof value !== "number" || !Number.isFinite(value))) {
        throw new Error(`${path} must be a string, number, boolean, or null.`);
      }
      return value;
    case "union": {
      let errors: string[] = [];
      for (let variant of schema.variants) {
        try {
          return validateCatalogValue(value, variant, path);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      throw new Error(`${path} must match ${schemaName(schema)}. ${errors.join(" ")}`);
    }
    case "array":
      if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        throw new Error(`${path} may contain at most ${schema.maxLength} items.`);
      }
      return value.map((item, index) =>
        validateCatalogValue(item, schema.items, `${path}[${index}]`));
    case "object": {
      if (!isPlainRecord(value)) throw new Error(`${path} must be an object.`);
      let allowed = Object.keys(schema.fields);
      for (let key of Object.keys(value)) {
        if (BLOCKED_JSON_KEYS.has(key)) {
          throw new Error(`${path} contains forbidden key ${key}.`);
        }
        if (!Object.hasOwn(schema.fields, key)) {
          throw new Error(`${path} has unknown field ${JSON.stringify(key)}. ` +
              `Allowed fields: ${allowed.join(", ")}.`);
        }
      }
      let result: {[key: string]: JsonValue} = {};
      for (let [key, field] of Object.entries(schema.fields)) {
        if (!Object.hasOwn(value, key)) {
          if (!field.optional) throw new Error(`${path}.${key} is required.`);
        } else {
          Object.defineProperty(result, key, {
            value: validateCatalogValue(value[key], field.schema, `${path}.${key}`),
            enumerable: true,
          });
        }
      }
      return result;
    }
    case "record": {
      if (!isPlainRecord(value)) throw new Error(`${path} must be an object.`);
      let result: {[key: string]: JsonValue} = {};
      for (let [key, child] of Object.entries(value)) {
        if (BLOCKED_JSON_KEYS.has(key)) {
          throw new Error(`${path} contains forbidden key ${key}.`);
        }
        Object.defineProperty(result, key, {
          value: validateCatalogValue(child, schema.values, `${path}.${key}`),
          enumerable: true,
        });
      }
      return result;
    }
  }
}

function validateNode(
    value: unknown, path: string, depth: number, counter: {count: number}): GenerativeUiNode {
  if (depth > MAX_RENDER_UI_DEPTH || !isPlainRecord(value) ||
      typeof value.type !== "string" || !isPlainRecord(value.props) ||
      !Array.isArray(value.children)) {
    throw new Error(`${path} is not a valid renderUI node.`);
  }
  if (++counter.count > MAX_RENDER_UI_NODES) {
    throw new Error(`renderUI tree exceeds the ${MAX_RENDER_UI_NODES}-node limit.`);
  }
  let nodeKeys = Object.keys(value);
  if (nodeKeys.length !== 3 || !nodeKeys.includes("type") || !nodeKeys.includes("props") ||
      !nodeKeys.includes("children")) {
    throw new Error(`${path} must contain exactly type, props, and children.`);
  }
  if (!Object.hasOwn(RENDER_UI_CATALOG, value.type)) {
    throw new Error(`Unknown renderUI component ${JSON.stringify(value.type)}. ` +
        `Allowed components: ${Object.keys(RENDER_UI_CATALOG).join(", ")}.`);
  }
  let component = RENDER_UI_CATALOG[value.type];
  let allowedProps = Object.keys(component.props);
  for (let name of Object.keys(value.props)) {
    if (/^on[A-Z]/.test(name) || name === "dangerouslySetInnerHTML" ||
        BLOCKED_JSON_KEYS.has(name)) {
      throw new Error(`${path} attempts to smuggle forbidden prop ${JSON.stringify(name)}. ` +
          `Event handlers, reserved keys, and dangerouslySetInnerHTML are never allowed.`);
    }
    if (!Object.hasOwn(component.props, name)) {
      throw new Error(`${value.type} has unknown prop ${JSON.stringify(name)}. ` +
          `Allowed props: ${allowedProps.join(", ") || "(none)"}.`);
    }
  }
  let props: Record<string, unknown> = {};
  for (let [name, prop] of Object.entries(component.props)) {
    if (!Object.hasOwn(value.props, name)) {
      if (!prop.optional) throw new Error(`${value.type}.${name} is required.`);
      continue;
    }
    let raw = value.props[name];
    if (isPlainRecord(raw) && Object.hasOwn(raw, "$bind")) {
      if (!prop.bindable) throw new Error(`${value.type}.${name} cannot be bound to state.`);
      props[name] = validateBind(raw, `${path}.props.${name}`);
    } else {
      props[name] = validateCatalogValue(raw, prop.schema, `${value.type}.${name}`);
    }
  }
  let children = value.children.map((child, index) => {
    if (typeof child === "string") return child;
    return validateNode(child, `${path}.children[${index}]`, depth + 1, counter);
  });
  if (!component.children && children.length > 0) {
    throw new Error(`${value.type} does not accept children. Allowed props: ` +
        `${allowedProps.join(", ") || "(none)"}.`);
  }
  return {type: value.type, props, children};
}

/** Independently validate and reconstruct a renderUI tree from unknown input. */
export function validateRenderUINode(value: unknown): GenerativeUiNode {
  return validateNode(value, "tree", 0, {count: 0});
}

/** Parse the literal-only JSX subset and return the validated durable wire result. */
export async function parseRenderUIJsx(
    jsxSource: string,
    stateDefaults: Record<string, unknown> = {}): Promise<GenerativeUiResult> {
  let sourceBytes = sourceByteLength(jsxSource);
  if (sourceBytes > MAX_RENDER_UI_SOURCE_BYTES) {
    throw new Error(`renderUI JSX exceeds the ${MAX_RENDER_UI_SOURCE_BYTES}-byte source limit.`);
  }
  if (!jsxSource.trim()) throw new Error("renderUI JSX cannot be empty.");
  assertJsonValue(stateDefaults, "state");

  // The interpreter already consults the catalog while walking the AST. Reconstructing the tree
  // here is deliberately redundant: persistence never trusts even its own first-pass output.
  let tree = validateRenderUINode(parseRootElement(jsxSource));
  let treeBytes = sourceByteLength(JSON.stringify(tree));
  if (treeBytes > MAX_RENDER_UI_TREE_BYTES) {
    throw new Error(`renderUI tree exceeds the ${MAX_RENDER_UI_TREE_BYTES}-byte tree limit.`);
  }
  let trustedState = structuredClone(stateDefaults);
  validateRenderUIState(tree, trustedState);
  return {tree, stateDefaults: trustedState, catalogVersion: RENDER_UI_CATALOG_VERSION};
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
    } else if (isPlainRecord(value) && Object.hasOwn(value, part)) {
      value = value[part];
    } else {
      return undefined;
    }
  }
  return value;
}

function validateBoundStateValue(value: unknown, schema: ValueSchema, path: string): void {
  validateCatalogValue(value, schema, path);
}

function validateStateShape(
    value: unknown, path: string, bindPaths: ReadonlySet<string>,
    bindPrefixes: ReadonlySet<string>): void {
  if (path && !bindPrefixes.has(path)) {
    throw new Error(`Unknown renderUI state path ${JSON.stringify(path)}. ` +
        `Allowed bind paths: ${[...bindPaths].toSorted().join(", ") || "(none)"}.`);
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      validateStateShape(child, path ? `${path}.${index}` : `${index}`, bindPaths, bindPrefixes));
    return;
  }
  if (isPlainRecord(value)) {
    for (let [key, child] of Object.entries(value)) {
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) || BLOCKED_JSON_KEYS.has(key)) {
        throw new Error(`Invalid renderUI state key ${JSON.stringify(key)}.`);
      }
      validateStateShape(child, path ? `${path}.${key}` : key, bindPaths, bindPrefixes);
    }
    return;
  }
  if (!bindPaths.has(path)) {
    throw new Error(`Unknown renderUI state path ${JSON.stringify(path)}. ` +
        `Allowed bind paths: ${[...bindPaths].toSorted().join(", ") || "(none)"}.`);
  }
}

/** Validate one whole-state mirror against the bindings in a previously validated tree. */
export function validateRenderUIState(
    tree: GenerativeUiNode, state: Record<string, unknown>): void {
  if (!isPlainRecord(state)) throw new Error("renderUI state must be a JSON object.");
  assertJsonValue(state, "state");
  if (sourceByteLength(JSON.stringify(state)) > MAX_RENDER_UI_STATE_BYTES) {
    throw new Error(`renderUI state exceeds the ${MAX_RENDER_UI_STATE_BYTES}-byte limit.`);
  }
  let paths = new Set(listRenderUIBindPaths(tree));
  let prefixes = new Set<string>();
  for (let statePath of paths) {
    let parts = statePath.split(".");
    for (let index = 1; index <= parts.length; index++) {
      prefixes.add(parts.slice(0, index).join("."));
    }
  }
  validateStateShape(state, "", paths, prefixes);
  function visit(node: GenerativeUiNode) {
    if (!Object.hasOwn(RENDER_UI_CATALOG, node.type)) {
      throw new Error(`Unknown renderUI component ${JSON.stringify(node.type)}.`);
    }
    let component = RENDER_UI_CATALOG[node.type];
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

/** Validate one candidate durable value against every control bound to the same state path. */
export function validateRenderUIBindValue(
    tree: GenerativeUiNode, statePath: string, value: string | number | boolean): void {
  let found = false;
  function visit(node: GenerativeUiNode) {
    let component = RENDER_UI_CATALOG[node.type];
    if (!component) throw new Error(`Unknown renderUI component ${JSON.stringify(node.type)}.`);
    for (let [name, marker] of Object.entries(node.props)) {
      if (!isPlainRecord(marker) || marker.$bind !== statePath) continue;
      let prop = component.props[name];
      if (!prop?.bindable) throw new Error(`${node.type}.${name} is not bindable.`);
      found = true;
      validateBoundStateValue(value, prop.schema, `state.${statePath}`);
    }
    for (let child of node.children) if (typeof child !== "string") visit(child);
  }
  visit(tree);
  if (!found) throw new Error(`Unknown renderUI bind path ${JSON.stringify(statePath)}.`);
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
    } else if (isPlainRecord(cursor) && Object.hasOwn(cursor, part)) {
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
