// renderUI parses JSX as data in the trusted Worker. Model-authored source is never evaluated or
// loaded as JavaScript: a bounded AST interpreter accepts catalog elements and a terminating
// expression grammar over static JSON, then the independent tree validator reconstructs the
// durable JSON.

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

/** Maximum UTF-8 size of the optional static data scope. */
export const MAX_RENDER_UI_DATA_BYTES = 64 * 1024;

/** Maximum number of expression evaluations performed by one renderUI interpretation. */
export const MAX_RENDER_UI_EXPRESSION_EVALUATIONS = 100_000;

/** Maximum total and nested-product callback iterations across all whitelisted .map calls. */
export const MAX_RENDER_UI_MAP_ITERATIONS = 10_000;

/** Maximum number of contiguous pure member/index reads in one expression. */
export const MAX_RENDER_UI_MEMBER_DEPTH = 32;

/** Maximum UTF-16 length of any string produced by the expression interpreter. */
export const MAX_RENDER_UI_STRING_LENGTH = 16 * 1024;

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
type SyntaxBudget = {count: number};
type RuntimeObject = {[key: string]: RuntimeValue};
type RuntimeValue = null | boolean | number | string | RuntimeValue[] | RuntimeObject |
    GenerativeUiBinding | EvaluatedElement;
type RuntimeScope = ReadonlyMap<string, RuntimeValue>;
type EvaluationBudget = {
  evaluations: number;
  emittedNodes: number;
  mapIterations: number;
  producedStringBytes: number;
};
type EvaluationContext = {
  source: string;
  scope: RuntimeScope;
  budget: EvaluationBudget;
  mapProduct: number;
};

const EVALUATED_ELEMENT = Symbol("renderUI element");
type EvaluatedElement = {
  [EVALUATED_ELEMENT]: true;
  node: GenerativeUiNode;
};

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

function enterSyntax(source: string, node: AstNode, depth: number, budget: SyntaxBudget): void {
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
      ". Allowed syntax is bounded catalog JSX expressions over data, literals, .map(), " +
      "conditionals, pure member reads, string building, and bind(\"path\").");
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

function jsxName(source: string, value: unknown, parent: AstNode): string {
  let node = astNode(source, value, parent, "name");
  if (node.type !== "JSXIdentifier" || typeof node.name !== "string") {
    return rejectAst(source, node, "a component or prop name");
  }
  return node.name;
}

function jsxText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ") : "";
}

function assertSafeKey(source: string, node: AstNode, key: string, context: string): string {
  if (BLOCKED_JSON_KEYS.has(key)) {
    throw syntaxError(source, node.start, context + " key " + JSON.stringify(key) + " is forbidden.");
  }
  return key;
}

function memberKey(source: string, member: AstNode): string {
  let property = astNode(source, member.property, member, "property");
  if (member.computed === true) {
    if (property.type !== "Literal") {
      throw syntaxError(source, property.start,
          "computed member access requires a literal string or non-negative integer index.");
    }
    let value = literalValue(source, property);
    if (typeof value === "string") return assertSafeKey(source, property, value, "member");
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
      return String(value);
    }
    return rejectAst(source, property, "computed member access");
  }
  if (property.type !== "Identifier" || typeof property.name !== "string") {
    return rejectAst(source, property, "member access");
  }
  return assertSafeKey(source, property, property.name, "member");
}

function isBindCall(source: string, node: AstNode): boolean {
  if (node.type !== "CallExpression") return false;
  let callee = astNode(source, node.callee, node, "callee");
  return callee.type === "Identifier" && callee.name === "bind";
}

function isMapCall(source: string, node: AstNode): boolean {
  if (node.type !== "CallExpression") return false;
  let callee = astNode(source, node.callee, node, "callee");
  if (callee.type !== "MemberExpression" || callee.computed === true || callee.optional === true) {
    return false;
  }
  let property = astNode(source, callee.property, callee, "property");
  return property.type === "Identifier" && property.name === "map";
}

function validateObjectAst(
    source: string, node: AstNode, scope: ReadonlySet<string>, depth: number,
    budget: SyntaxBudget): void {
  for (let property of astNodes(source, node.properties, node, "properties")) {
    enterSyntax(source, property, depth + 1, budget);
    if (property.type !== "Property" || property.kind !== "init" || property.method === true ||
        property.computed === true || property.shorthand === true) {
      rejectAst(source, property, "an object literal");
    }
    let keyNode = astNode(source, property.key, property, "key");
    enterSyntax(source, keyNode, depth + 2, budget);
    let key = objectKey(source, keyNode);
    if (key === "$bind") {
      throw syntaxError(source, keyNode.start,
          "raw $bind objects are not accepted in JSX; use bind(\"path\") instead.");
    }
    assertSafeKey(source, keyNode, key, "object");
    validateExpressionAst(source, astNode(source, property.value, property, "value"),
        scope, depth + 2, budget, false, 0);
  }
}

function validateMapAst(
    source: string, node: AstNode, scope: ReadonlySet<string>, depth: number,
    budget: SyntaxBudget): void {
  let callee = astNode(source, node.callee, node, "callee");
  enterSyntax(source, callee, depth + 1, budget);
  let property = astNode(source, callee.property, callee, "property");
  enterSyntax(source, property, depth + 2, budget);
  validateExpressionAst(source, astNode(source, callee.object, callee, "object"),
      scope, depth + 2, budget, false, 0);
  let args = astNodes(source, node.arguments, node, "arguments");
  if (node.optional === true || args.length !== 1 || args[0].type !== "ArrowFunctionExpression") {
    throw syntaxError(source, node.start,
        ".map() requires exactly one direct concise arrow callback.");
  }
  let callback = args[0];
  enterSyntax(source, callback, depth + 1, budget);
  let params = astNodes(source, callback.params, callback, "params");
  if (params.length < 1 || params.length > 2 || callback.async === true ||
      callback.generator === true || callback.expression !== true) {
    throw syntaxError(source, callback.start,
        ".map() callbacks must be a synchronous concise arrow with item or item,index parameters.");
  }
  let callbackScope = new Set(scope);
  let parameterNames = new Set<string>();
  for (let param of params) {
    enterSyntax(source, param, depth + 2, budget);
    if (param.type !== "Identifier" || typeof param.name !== "string" ||
        param.name === "data" || param.name === "bind" || parameterNames.has(param.name)) {
      throw syntaxError(source, param.start,
          ".map() parameters must be unique identifiers other than data or bind.");
    }
    parameterNames.add(param.name);
    callbackScope.add(param.name);
  }
  validateExpressionAst(source, astNode(source, callback.body, callback, "body"),
      callbackScope, depth + 2, budget, false, 0);
}

function validateElementAst(
    source: string, element: AstNode, scope: ReadonlySet<string>, depth: number,
    budget: SyntaxBudget): void {
  let opening = astNode(source, element.openingElement, element, "openingElement");
  enterSyntax(source, opening, depth + 1, budget);
  let type = jsxName(source, opening.name, opening);
  if (!Object.hasOwn(RENDER_UI_CATALOG, type)) {
    throw syntaxError(source, opening.start, "Unknown renderUI component " + JSON.stringify(type) +
        ". Allowed components: " + Object.keys(RENDER_UI_CATALOG).join(", ") + ".");
  }
  let component = RENDER_UI_CATALOG[type];
  let allowedProps = Object.keys(component.props);
  let seen = new Set<string>();
  for (let attribute of astNodes(source, opening.attributes, opening, "attributes")) {
    enterSyntax(source, attribute, depth + 2, budget);
    if (attribute.type !== "JSXAttribute") rejectAst(source, attribute, "component props");
    let name = jsxName(source, attribute.name, attribute);
    if (/^on[A-Z]/.test(name) || name === "dangerouslySetInnerHTML" ||
        BLOCKED_JSON_KEYS.has(name)) {
      throw syntaxError(source, attribute.start, "forbidden prop " + JSON.stringify(name) +
          " attempts handler or reserved-prop smuggling; event handlers and HTML are never allowed.");
    }
    if (!Object.hasOwn(component.props, name)) {
      throw syntaxError(source, attribute.start, type + " has unknown prop " + JSON.stringify(name) +
          ". Allowed props: " + (allowedProps.join(", ") || "(none)") + ".");
    }
    if (seen.has(name)) {
      throw syntaxError(source, attribute.start, "duplicate prop " + JSON.stringify(name) + ".");
    }
    seen.add(name);
    if (attribute.value === null) continue;
    let value = astNode(source, attribute.value, attribute, "value");
    enterSyntax(source, value, depth + 3, budget);
    if (value.type === "Literal") {
      literalValue(source, value);
      continue;
    }
    if (value.type !== "JSXExpressionContainer") rejectAst(source, value, "a prop value");
    let expression = astNode(source, value.expression, value, "expression");
    if (expression.type === "JSXEmptyExpression") {
      throw syntaxError(source, expression.start, "prop " + name + " has an empty expression.");
    }
    validateExpressionAst(source, expression, scope, depth + 4, budget, true, 0);
  }
  for (let child of astNodes(source, element.children, element, "children")) {
    enterSyntax(source, child, depth + 1, budget);
    if (child.type === "JSXText") continue;
    if (child.type === "JSXElement") {
      validateElementAst(source, child, scope, depth + 1, budget);
      continue;
    }
    if (child.type !== "JSXExpressionContainer") rejectAst(source, child, "JSX children");
    let expression = astNode(source, child.expression, child, "expression");
    if (expression.type !== "JSXEmptyExpression") {
      validateExpressionAst(source, expression, scope, depth + 2, budget, false, 0);
    }
  }
}

function validateExpressionAst(
    source: string, node: AstNode, scope: ReadonlySet<string>, depth: number,
    budget: SyntaxBudget, allowBind: boolean, memberDepth: number): void {
  enterSyntax(source, node, depth, budget);
  switch (node.type) {
    case "Literal":
      literalValue(source, node);
      return;
    case "Identifier":
      if (typeof node.name !== "string" || !scope.has(node.name)) {
        throw syntaxError(source, node.start, "Unknown identifier " + JSON.stringify(node.name) +
            ". Allowed identifiers: " + ([...scope].join(", ") || "(none)") + ".");
      }
      return;
    case "ArrayExpression": {
      let elements = node.elements;
      if (!Array.isArray(elements)) rejectAst(source, node, "an array literal");
      elements.forEach((element, index) => {
        if (element === null || !isAstNode(element)) {
          throw syntaxError(source, node.start,
              "array literals cannot contain holes at index " + index + ".");
        }
        if (element.type === "SpreadElement") rejectAst(source, element, "an array literal");
        validateExpressionAst(source, element, scope, depth + 1, budget, false, 0);
      });
      return;
    }
    case "ObjectExpression":
      validateObjectAst(source, node, scope, depth, budget);
      return;
    case "JSXElement":
      validateElementAst(source, node, scope, depth, budget);
      return;
    case "ConditionalExpression":
      validateExpressionAst(source, astNode(source, node.test, node, "test"),
          scope, depth + 1, budget, false, 0);
      validateExpressionAst(source, astNode(source, node.consequent, node, "consequent"),
          scope, depth + 1, budget, allowBind, 0);
      validateExpressionAst(source, astNode(source, node.alternate, node, "alternate"),
          scope, depth + 1, budget, allowBind, 0);
      return;
    case "LogicalExpression":
      if (node.operator !== "&&" && node.operator !== "||") {
        rejectAst(source, node, "a logical expression");
      }
      validateExpressionAst(source, astNode(source, node.left, node, "left"),
          scope, depth + 1, budget, false, 0);
      validateExpressionAst(source, astNode(source, node.right, node, "right"),
          scope, depth + 1, budget, allowBind, 0);
      return;
    case "BinaryExpression":
      if (!["+", "===", "!==", "<", ">", "<=", ">="].includes(String(node.operator))) {
        rejectAst(source, node, "a binary expression");
      }
      validateExpressionAst(source, astNode(source, node.left, node, "left"),
          scope, depth + 1, budget, false, 0);
      validateExpressionAst(source, astNode(source, node.right, node, "right"),
          scope, depth + 1, budget, false, 0);
      return;
    case "UnaryExpression": {
      let argument = astNode(source, node.argument, node, "argument");
      if (node.operator !== "-" || argument.type !== "Literal" ||
          typeof argument.value !== "number" || !Number.isFinite(argument.value)) {
        rejectAst(source, node, "a numeric literal");
      }
      validateExpressionAst(source, argument, scope, depth + 1, budget, false, 0);
      return;
    }
    case "MemberExpression":
      if (node.optional === true || ++memberDepth > MAX_RENDER_UI_MEMBER_DEPTH) {
        throw syntaxError(source, node.start,
            "member access exceeds the " + MAX_RENDER_UI_MEMBER_DEPTH + "-read depth limit.");
      }
      enterSyntax(source, astNode(source, node.property, node, "property"), depth + 1, budget);
      memberKey(source, node);
      validateExpressionAst(source, astNode(source, node.object, node, "object"),
          scope, depth + 1, budget, false, memberDepth);
      return;
    case "TemplateLiteral":
      for (let quasi of astNodes(source, node.quasis, node, "quasis")) {
        enterSyntax(source, quasi, depth + 1, budget);
        if (quasi.type !== "TemplateElement") rejectAst(source, quasi, "a template literal");
      }
      for (let expression of astNodes(source, node.expressions, node, "expressions")) {
        validateExpressionAst(source, expression, scope, depth + 1, budget, false, 0);
      }
      return;
    case "CallExpression":
      if (isBindCall(source, node)) {
        if (!allowBind) {
          throw syntaxError(source, node.start, "bind() is allowed only as a bindable prop value.");
        }
        let callee = astNode(source, node.callee, node, "callee");
        enterSyntax(source, callee, depth + 1, budget);
        let args = astNodes(source, node.arguments, node, "arguments");
        if (node.optional === true || args.length !== 1 || args[0].type !== "Literal" ||
            typeof args[0].value !== "string" || args[0].value.length === 0) {
          throw syntaxError(source, node.start,
              "bind() requires exactly one non-empty string literal path.");
        }
        enterSyntax(source, args[0], depth + 1, budget);
        return;
      }
      if (isMapCall(source, node)) {
        validateMapAst(source, node, scope, depth, budget);
        return;
      }
      return rejectAst(source, node, "a call expression");
    default:
      return rejectAst(source, node, "an expression");
  }
}

function tickEvaluation(context: EvaluationContext, node: AstNode, depth: number): void {
  if (depth > MAX_RENDER_UI_DEPTH) {
    throw syntaxError(context.source, node.start, "expression nesting exceeds the maximum depth.");
  }
  if (++context.budget.evaluations > MAX_RENDER_UI_EXPRESSION_EVALUATIONS) {
    throw syntaxError(context.source, node.start,
        "renderUI exceeds the " + MAX_RENDER_UI_EXPRESSION_EVALUATIONS +
        "-evaluation expression budget.");
  }
}

function boundedString(context: EvaluationContext, node: AstNode, value: string): string {
  if (value.length > MAX_RENDER_UI_STRING_LENGTH) {
    throw syntaxError(context.source, node.start,
        "string exceeds the " + MAX_RENDER_UI_STRING_LENGTH + "-character limit.");
  }
  context.budget.producedStringBytes += sourceByteLength(value);
  if (context.budget.producedStringBytes > MAX_RENDER_UI_TREE_BYTES) {
    throw syntaxError(context.source, node.start,
        "evaluated strings exceed the " + MAX_RENDER_UI_TREE_BYTES + "-byte aggregate limit.");
  }
  return value;
}

function evaluateLiteral(context: EvaluationContext, node: AstNode): JsonValue {
  let value = literalValue(context.source, node);
  return typeof value === "string" ? boundedString(context, node, value) : value;
}

function scalarString(context: EvaluationContext, node: AstNode, value: RuntimeValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" ||
      typeof value === "string") {
    return String(value);
  }
  throw syntaxError(context.source, node.start,
      "string interpolation accepts only string, number, boolean, or null values.");
}

function readMember(
    context: EvaluationContext, node: AstNode, object: RuntimeValue, key: string): RuntimeValue {
  if (Array.isArray(object)) {
    if (key === "length") return object.length;
    if (!/^(0|[1-9][0-9]*)$/.test(key)) {
      throw syntaxError(context.source, node.start,
          "arrays expose only literal indices and .length.");
    }
    let index = Number(key);
    if (index >= object.length) {
      throw syntaxError(context.source, node.start, "array index " + index + " is out of bounds.");
    }
    return object[index];
  }
  if (typeof object === "string") {
    if (key === "length") return object.length;
    if (/^(0|[1-9][0-9]*)$/.test(key) && Number(key) < object.length) {
      return boundedString(context, node, object[Number(key)]);
    }
    throw syntaxError(context.source, node.start,
        "strings expose only literal indices and .length.");
  }
  if (object !== null && typeof object === "object" && !(EVALUATED_ELEMENT in object) &&
      !Object.hasOwn(object, "$bind")) {
    let record = object as RuntimeObject;
    if (!Object.hasOwn(record, key)) {
      throw syntaxError(context.source, node.start,
          "unknown own data member " + JSON.stringify(key) + ".");
    }
    let value = record[key];
    return typeof value === "string" ? boundedString(context, node, value) : value;
  }
  throw syntaxError(context.source, node.start,
      "member access is allowed only on static data arrays, strings, and objects.");
}

function evaluateMap(
    context: EvaluationContext, node: AstNode, depth: number): RuntimeValue[] {
  let callee = astNode(context.source, node.callee, node, "callee");
  let receiver = evaluateExpression(context,
      astNode(context.source, callee.object, callee, "object"), depth + 1, false);
  if (!Array.isArray(receiver)) {
    throw syntaxError(context.source, node.start, ".map() receiver must be a static array.");
  }
  if (receiver.length > MAX_RENDER_UI_MAP_ITERATIONS - context.budget.mapIterations) {
    throw syntaxError(context.source, node.start,
        ".map() exceeds the " + MAX_RENDER_UI_MAP_ITERATIONS + "-iteration total limit.");
  }
  if (receiver.length > 0 &&
      context.mapProduct > Math.floor(MAX_RENDER_UI_MAP_ITERATIONS / receiver.length)) {
    throw syntaxError(context.source, node.start,
        "nested .map() exceeds the " + MAX_RENDER_UI_MAP_ITERATIONS +
        "-iteration product limit.");
  }
  context.budget.mapIterations += receiver.length;
  let product = context.mapProduct * receiver.length;
  let callback = astNodes(context.source, node.arguments, node, "arguments")[0];
  let params = astNodes(context.source, callback.params, callback, "params");
  let body = astNode(context.source, callback.body, callback, "body");
  let results: RuntimeValue[] = [];
  for (let index = 0; index < receiver.length; index++) {
    let scope = new Map(context.scope);
    scope.set(String(params[0].name), receiver[index]);
    if (params[1]) scope.set(String(params[1].name), index);
    results.push(evaluateExpression({...context, scope, mapProduct: product}, body, depth + 1, false));
  }
  return results;
}

function evaluateExpression(
    context: EvaluationContext, node: AstNode, depth: number, allowBind: boolean): RuntimeValue {
  tickEvaluation(context, node, depth);
  switch (node.type) {
    case "Literal":
      return evaluateLiteral(context, node);
    case "Identifier": {
      let name = String(node.name);
      if (!context.scope.has(name)) {
        throw syntaxError(context.source, node.start, "Unknown identifier " + JSON.stringify(name) + ".");
      }
      let value = context.scope.get(name) as RuntimeValue;
      return typeof value === "string" ? boundedString(context, node, value) : value;
    }
    case "ArrayExpression":
      return (node.elements as unknown[]).map(element =>
        evaluateExpression(context, element as AstNode, depth + 1, false));
    case "ObjectExpression": {
      let result: RuntimeObject = Object.create(null);
      for (let property of astNodes(context.source, node.properties, node, "properties")) {
        let keyNode = astNode(context.source, property.key, property, "key");
        let key = assertSafeKey(context.source, keyNode,
            objectKey(context.source, keyNode), "object");
        if (Object.hasOwn(result, key)) {
          throw syntaxError(context.source, property.start,
              "duplicate object key " + JSON.stringify(key) + ".");
        }
        Object.defineProperty(result, key, {
          value: evaluateExpression(context,
              astNode(context.source, property.value, property, "value"), depth + 1, false),
          enumerable: true,
        });
      }
      return result;
    }
    case "JSXElement":
      return evaluateElement(context, node, depth);
    case "ConditionalExpression": {
      let test = evaluateExpression(context,
          astNode(context.source, node.test, node, "test"), depth + 1, false);
      return evaluateExpression(context, astNode(context.source,
          test ? node.consequent : node.alternate, node, test ? "consequent" : "alternate"),
          depth + 1, allowBind);
    }
    case "LogicalExpression": {
      let left = evaluateExpression(context,
          astNode(context.source, node.left, node, "left"), depth + 1, false);
      if (node.operator === "&&") {
        return left ? evaluateExpression(context,
            astNode(context.source, node.right, node, "right"), depth + 1, allowBind) : left;
      }
      return left ? left : evaluateExpression(context,
          astNode(context.source, node.right, node, "right"), depth + 1, allowBind);
    }
    case "BinaryExpression": {
      let left = evaluateExpression(context,
          astNode(context.source, node.left, node, "left"), depth + 1, false);
      let right = evaluateExpression(context,
          astNode(context.source, node.right, node, "right"), depth + 1, false);
      switch (node.operator) {
        case "+":
          if (typeof left !== "string" && typeof right !== "string") {
            throw syntaxError(context.source, node.start,
                "+ is string concatenation only; at least one operand must be a string.");
          }
          return boundedString(context, node,
              scalarString(context, node, left) + scalarString(context, node, right));
        case "===": return left === right;
        case "!==": return left !== right;
        case "<":
        case ">":
        case "<=":
        case ">=": {
          if (typeof left === "number" && typeof right === "number") {
            if (node.operator === "<") return left < right;
            if (node.operator === ">") return left > right;
            if (node.operator === "<=") return left <= right;
            return left >= right;
          }
          if (typeof left === "string" && typeof right === "string") {
            if (node.operator === "<") return left < right;
            if (node.operator === ">") return left > right;
            if (node.operator === "<=") return left <= right;
            return left >= right;
          }
          throw syntaxError(context.source, node.start,
              "relational comparisons require two numbers or two strings.");
        }
      }
      return rejectAst(context.source, node, "a binary expression");
    }
    case "UnaryExpression": {
      let value = evaluateExpression(context,
          astNode(context.source, node.argument, node, "argument"), depth + 1, false);
      if (typeof value !== "number") return rejectAst(context.source, node, "a numeric literal");
      return -value;
    }
    case "MemberExpression": {
      let object = evaluateExpression(context,
          astNode(context.source, node.object, node, "object"), depth + 1, false);
      return readMember(context, node, object, memberKey(context.source, node));
    }
    case "TemplateLiteral": {
      let quasis = astNodes(context.source, node.quasis, node, "quasis");
      let expressions = astNodes(context.source, node.expressions, node, "expressions");
      let result = "";
      for (let index = 0; index < quasis.length; index++) {
        let cooked = (quasis[index].value as {cooked?: unknown} | undefined)?.cooked;
        if (typeof cooked !== "string") rejectAst(context.source, quasis[index], "a template literal");
        result += cooked;
        if (result.length > MAX_RENDER_UI_STRING_LENGTH) {
          throw syntaxError(context.source, node.start,
              "template string exceeds the " + MAX_RENDER_UI_STRING_LENGTH + "-character limit.");
        }
        if (index < expressions.length) {
          result += scalarString(context, expressions[index],
              evaluateExpression(context, expressions[index], depth + 1, false));
        }
      }
      return boundedString(context, node, result);
    }
    case "CallExpression":
      if (isBindCall(context.source, node) && allowBind) {
        let argument = astNodes(context.source, node.arguments, node, "arguments")[0];
        return {$bind: String(argument.value)};
      }
      if (isMapCall(context.source, node)) return evaluateMap(context, node, depth);
      return rejectAst(context.source, node, "a call expression");
    default:
      return rejectAst(context.source, node, "an expression");
  }
}

function appendChild(
    context: EvaluationContext, sourceNode: AstNode, value: RuntimeValue,
    children: Array<GenerativeUiNode | string>): void {
  if (value === null || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    for (let item of value) appendChild(context, sourceNode, item, children);
    return;
  }
  if (typeof value === "string") {
    children.push(value);
    return;
  }
  if (typeof value === "number") {
    children.push(boundedString(context, sourceNode, String(value)));
    return;
  }
  if (EVALUATED_ELEMENT in value) {
    children.push(value.node);
    return;
  }
  throw syntaxError(context.source, sourceNode.start,
      "JSX children must evaluate to elements, arrays of children, scalars, or null/boolean.");
}

function evaluateAttribute(
    context: EvaluationContext, attribute: AstNode, depth: number): [string, RuntimeValue] {
  let name = jsxName(context.source, attribute.name, attribute);
  if (attribute.value === null) return [name, true];
  let value = astNode(context.source, attribute.value, attribute, "value");
  if (value.type === "Literal") return [name, evaluateExpression(context, value, depth + 1, false)];
  let expression = astNode(context.source, value.expression, value, "expression");
  return [name, evaluateExpression(context, expression, depth + 1, true)];
}

function evaluateElement(
    context: EvaluationContext, element: AstNode, depth: number): EvaluatedElement {
  tickEvaluation(context, element, depth);
  if (++context.budget.emittedNodes > MAX_RENDER_UI_NODES) {
    throw syntaxError(context.source, element.start,
        "renderUI tree exceeds the " + MAX_RENDER_UI_NODES + "-node limit.");
  }
  let opening = astNode(context.source, element.openingElement, element, "openingElement");
  let type = jsxName(context.source, opening.name, opening);
  let props: Record<string, unknown> = Object.create(null);
  for (let attribute of astNodes(context.source, opening.attributes, opening, "attributes")) {
    let [name, value] = evaluateAttribute(context, attribute, depth + 1);
    Object.defineProperty(props, name, {value, enumerable: true});
  }
  let children: Array<GenerativeUiNode | string> = [];
  for (let child of astNodes(context.source, element.children, element, "children")) {
    if (child.type === "JSXText") {
      let value = jsxText(child.value);
      if (value.trim()) children.push(boundedString(context, child, value));
      continue;
    }
    if (child.type === "JSXElement") {
      appendChild(context, child, evaluateElement(context, child, depth + 1), children);
      continue;
    }
    let expression = astNode(context.source, child.expression, child, "expression");
    if (expression.type !== "JSXEmptyExpression") {
      appendChild(context, expression,
          evaluateExpression(context, expression, depth + 1, false), children);
    }
  }
  return {[EVALUATED_ELEMENT]: true, node: {type, props, children}};
}

function parseRootExpression(source: string): AstNode {
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
  validateExpressionAst(source, expression, new Set(["data"]), 0, {count: 0}, false, 0);
  return expression;
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
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) throw new Error(`${path}[${index}] is missing.`);
      assertJsonValue(value[index], `${path}[${index}]`, depth + 1);
    }
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

/** Interpret bounded JSX expressions over static JSON and return the validated durable wire result. */
export async function parseRenderUIJsx(
    jsxSource: string,
    stateDefaults: Record<string, unknown> = {},
    data: unknown = null): Promise<GenerativeUiResult> {
  let sourceBytes = sourceByteLength(jsxSource);
  if (sourceBytes > MAX_RENDER_UI_SOURCE_BYTES) {
    throw new Error(`renderUI JSX exceeds the ${MAX_RENDER_UI_SOURCE_BYTES}-byte source limit.`);
  }
  if (!jsxSource.trim()) throw new Error("renderUI JSX cannot be empty.");
  assertJsonValue(stateDefaults, "state");
  let trustedData = structuredClone(data);
  assertJsonValue(trustedData, "data");
  if (sourceByteLength(JSON.stringify(trustedData)) > MAX_RENDER_UI_DATA_BYTES) {
    throw new Error(`renderUI data exceeds the ${MAX_RENDER_UI_DATA_BYTES}-byte limit.`);
  }

  let expression = parseRootExpression(jsxSource);
  let budget: EvaluationBudget = {
    evaluations: 0,
    emittedNodes: 0,
    mapIterations: 0,
    producedStringBytes: 0,
  };
  let evaluated = evaluateExpression({
    source: jsxSource,
    scope: new Map([["data", trustedData]]),
    budget,
    mapProduct: 1,
  }, expression, 0, false);
  if (evaluated === null || typeof evaluated !== "object" ||
      !(EVALUATED_ELEMENT in evaluated)) {
    throw syntaxError(jsxSource, expression.start,
        "the renderUI root must evaluate to exactly one catalog element.");
  }

  // The interpreter already consults the catalog while walking the AST. Reconstructing the tree
  // here is deliberately redundant: persistence never trusts even its own first-pass output.
  let tree = validateRenderUINode(evaluated.node);
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
