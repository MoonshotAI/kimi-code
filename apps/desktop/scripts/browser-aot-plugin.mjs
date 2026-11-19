import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { build } from 'tsdown';
import { Build } from 'typebox/schema';

const sharedDir = fileURLToPath(new URL('../src/shared/', import.meta.url)).replaceAll('\\', '/');
const registry = fileURLToPath(new URL('./browser-aot-registry.ts', import.meta.url));
const runtimeId = '\0browser-aot';
const minimumSharedSize = 48;

const schemaKeywords = new Set(['additionalItems', 'additionalProperties', 'contains', 'else', 'if', 'items', 'not', 'propertyNames', 'then']);
const schemaListKeywords = new Set(['allOf', 'anyOf', 'items', 'oneOf', 'prefixItems']);
const schemaMapKeywords = new Set(['dependentSchemas', 'patternProperties', 'properties']);
const ignoredMarkers = new Set(['~optional', '~readonly']);

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function schemaChildren(node) {
  const children = [];
  for (const key of Reflect.ownKeys(node)) {
    if (typeof key !== 'string') continue;
    const value = node[key];
    if (schemaKeywords.has(key) && isPlainObject(value)) children.push({ key, value });
    else if (schemaListKeywords.has(key) && Array.isArray(value)) value.forEach((item, index) => { if (isPlainObject(item)) children.push({ key, index, value: item }); });
    else if (schemaMapKeywords.has(key) && isPlainObject(value)) {
      for (const name of Reflect.ownKeys(value)) if (typeof name === 'string' && isPlainObject(value[name])) children.push({ key, name, value: value[name] });
    }
  }
  return children;
}

function canonicalEntries(target, item) {
  const array = Array.isArray(target);
  const parts = [];
  for (const key of Reflect.ownKeys(target)) {
    if (typeof key !== 'string') return null;
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!('value' in descriptor)) return null;
    if (array && key === 'length') continue;
    const value = item(key, descriptor.value);
    if (value === undefined) continue;
    if (value === null) return null;
    parts.push(`${descriptor.enumerable ? '' : '!'}${JSON.stringify(key)}:${value}`);
  }
  return `${array ? 'a' : 'o'}${Object.getPrototypeOf(target) === null ? 'n' : ''}{${parts.join(',')}}`;
}

function canonicalValue(value, seen = new Set()) {
  if (value === undefined) return 'u';
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return Object.is(value, -0) ? '-0' : String(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value !== 'object' || seen.has(value)) return null;
  if (value instanceof RegExp) return Object.getPrototypeOf(value) === RegExp.prototype && Reflect.ownKeys(value).length === 1 && value.lastIndex === 0 ? `r${JSON.stringify([value.source, value.flags])}` : null;
  if (!Array.isArray(value) && !isPlainObject(value)) return null;
  seen.add(value);
  const result = canonicalEntries(value, (_, item) => canonicalValue(item, seen));
  seen.delete(value);
  return result;
}

function schemaCanonicalizer() {
  const cache = new Map();
  const canonical = node => {
    if (cache.has(node)) return cache.get(node);
    cache.set(node, null);
    const container = target => canonicalEntries(target, (_, item) => isPlainObject(item) ? canonical(item) : canonicalValue(item));
    const result = canonicalEntries(node, (key, value) => {
      if (ignoredMarkers.has(key)) return undefined;
      if (schemaKeywords.has(key) && isPlainObject(value)) return canonical(value);
      if ((schemaListKeywords.has(key) && Array.isArray(value)) || (schemaMapKeywords.has(key) && isPlainObject(value))) return container(value);
      return canonicalValue(value);
    });
    cache.set(node, result === null ? null : `s${result}`);
    return cache.get(node);
  };
  return canonical;
}

function isSelfContained(value) {
  if (Array.isArray(value)) return value.every(isSelfContained);
  if (!isPlainObject(value)) return true;
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && !key.startsWith('$') && !key.startsWith('unevaluated') && isSelfContained(value[key]));
}

function copyWith(source, replacements) {
  const copy = Object.create(Object.getPrototypeOf(source), Object.getOwnPropertyDescriptors(source));
  for (const [key, value] of replacements) Object.defineProperty(copy, key, { ...Object.getOwnPropertyDescriptor(source, key), value });
  return copy;
}

function planSharedSchemas(tops) {
  const canonical = schemaCanonicalizer();
  const safe = tops.map(schema => isPlainObject(schema) && canonical(schema) !== null && isSelfContained(schema));
  const nodes = new Map();
  const collect = node => {
    const key = canonical(node);
    if (!nodes.has(key)) nodes.set(key, node);
    for (const child of schemaChildren(node)) collect(child.value);
  };
  for (const [index, schema] of tops.entries()) if (safe[index]) collect(schema);
  const shared = new Set(tops.filter((_, index) => safe[index]).map(canonical));
  const occurrences = key => {
    let total = 0;
    const visit = (node, root) => {
      const nodeKey = canonical(node);
      if (nodeKey === key) total += 1;
      else if (root || !shared.has(nodeKey)) for (const child of schemaChildren(node)) visit(child.value, false);
    };
    for (const sharedKey of shared) visit(nodes.get(sharedKey), true);
    return total;
  };
  const candidates = [...nodes.keys()].filter(key => !shared.has(key) && key.length >= minimumSharedSize).sort((a, b) => b.length - a.length);
  for (const key of candidates) if (occurrences(key) >= 2) shared.add(key);
  return { canonical, safe, shared, nodes };
}

function buildSchemaContext(tops) {
  const { canonical, safe, shared, nodes } = planSharedSchemas(tops);
  const names = new Map();
  const context = {};
  const rewrite = (node, root) => {
    const key = canonical(node);
    if (!root && shared.has(key)) return { $ref: define(key) };
    const replacements = new Map();
    for (const child of schemaChildren(node)) {
      const next = rewrite(child.value, false);
      if (next === child.value) continue;
      if (child.index === undefined && child.name === undefined) { replacements.set(child.key, next); continue; }
      const original = node[child.key];
      if (!replacements.has(child.key)) replacements.set(child.key, Array.isArray(original) ? [...original] : copyWith(original, []));
      const container = replacements.get(child.key);
      if (child.index !== undefined) container[child.index] = next;
      else Object.defineProperty(container, child.name, { ...Object.getOwnPropertyDescriptor(original, child.name), value: next });
    }
    return replacements.size === 0 ? node : copyWith(node, replacements);
  };
  const define = key => {
    if (!names.has(key)) {
      const name = `aot${names.size}`;
      names.set(key, name);
      context[name] = rewrite(nodes.get(key), true);
    }
    return names.get(key);
  };
  const entries = tops.map((schema, index) => safe[index] ? define(canonical(schema)) : null);
  return { context, entries };
}

function rewriteCheck(func, identifier, externals, prefix) {
  const source = ts.createSourceFile('validator.mjs', func, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const edits = [];
  const visit = node => {
    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === identifier) {
      if (!ts.isNumericLiteral(node.argumentExpression)) throw new Error('Unexpected browser AOT external access');
      edits.push({ start: node.getStart(source), end: node.end, text: externals[Number(node.argumentExpression.text)] });
      return;
    }
    if (prefix && ts.isIdentifier(node) && /^check_\d+$/.test(node.text)) edits.push({ start: node.getStart(source), end: node.end, text: `${prefix}${node.text}` });
    ts.forEachChild(node, visit);
  };
  visit(source);
  let code = func;
  for (const edit of edits.sort((a, b) => b.start - a.start)) code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
  return code;
}

function entryChecks(func) {
  const source = ts.createSourceFile('entry.mjs', func, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const checks = new Map();
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.arguments.length === 1) {
      const [argument] = node.arguments;
      if (ts.isPropertyAccessExpression(argument) && ts.isIdentifier(argument.expression) && argument.expression.text === 'value') checks.set(argument.name.text, node.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return checks;
}

export function browserValidatorModule(tops) {
  const { context, entries } = buildSchemaContext(tops);
  const regexps = new Map();
  const functions = [];
  const compile = (schemaContext, schema, prefix) => {
    const built = Build(schemaContext, schema);
    if (built.UseUnevaluated()) throw new Error('Browser AOT does not support unevaluated keywords');
    const { identifier, variables } = built.External();
    const externals = variables.map((value, index) => {
      if (!(value instanceof RegExp)) throw new Error('Browser AOT only supports serializable regular expression externals');
      const key = value.global || value.sticky ? `${prefix}${index}` : JSON.stringify([value.source, value.flags]);
      if (!regexps.has(key)) regexps.set(key, { name: `pattern${regexps.size}`, value });
      return regexps.get(key).name;
    });
    const entry = /^(check_\d+)\(value\)$/.exec(built.Entry())?.[1];
    if (!entry) throw new Error(`Unexpected browser AOT entry ${built.Entry()}`);
    let root = null;
    for (const func of built.Functions()) {
      const code = rewriteCheck(func, identifier, externals, prefix);
      const isEntry = func.startsWith(`const ${entry} =`);
      if (isEntry) root = code;
      if (prefix || !isEntry) functions.push(`${code};`);
    }
    if (root === null) throw new Error('Browser AOT entry function is missing');
    return { entry: `${prefix}${entry}`, root };
  };
  const checks = tops.map(() => null);
  if (entries.some(entry => entry !== null)) {
    const shared = entries.flatMap((name, index) => name === null ? [] : [[`t${index}`, { $ref: name }]]);
    const { root } = compile(context, { type: 'object', required: shared.map(([key]) => key), properties: Object.fromEntries(shared) }, '');
    const calls = entryChecks(root);
    for (const [key] of shared) checks[Number(key.slice(1))] = calls.get(key);
  }
  for (const [index, schema] of tops.entries()) if (entries[index] === null) checks[index] = compile({}, schema, `schema${index}_`).entry;
  for (const [index, check] of checks.entries()) if (!check) throw new Error(`Browser AOT validator ${index} was not compiled`);
  const body = [
    ...[...regexps.values()].map(({ name, value }) => `const ${name} = /* @__PURE__ */ new RegExp(${JSON.stringify(value.source)}, ${JSON.stringify(value.flags)});`),
    ...functions,
    'const whole = value => value;',
    'function pick(keys) { return value => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])); }',
    'function validator(Check, project) { return { Check, Parse: value => Check(value) ? project(value) : null }; }',
    ...tops.map((schema, index) => {
      const keys = schema?.type === 'object' ? Object.keys(schema.properties ?? {}) : null;
      return `export const v${index} = /* @__PURE__ */ validator(${checks[index]}, ${keys === null ? 'whole' : `/* @__PURE__ */ pick(${JSON.stringify(keys)})`});`;
    }),
  ].join('\n');
  const used = new Set();
  const collect = node => {
    if (ts.isIdentifier(node)) used.add(node.text);
    ts.forEachChild(node, collect);
  };
  collect(ts.createSourceFile('validators.mjs', body, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS));
  const imports = [['Hashing', 'typebox/system'], ['Format', 'typebox/format'], ['Guard', 'typebox/guard']]
    .filter(([name]) => used.has(name))
    .map(([name, from]) => `import { ${name} } from ${JSON.stringify(from)};`);
  return `${imports.join('\n')}\n${body}\n`;
}

export function browserAotPlugin() {
  const modules = new Map();
  let generated = '';
  return {
    name: 'browser-aot',
    async buildStart() {
      modules.clear();
      generated = '';
      const directory = await mkdtemp(join(tmpdir(), 'browser-aot-'));
      let bundles = [];
      try {
        bundles = await build({
          config: false, entry: { registry }, format: ['esm'], platform: 'node', target: 'node20',
          outDir: directory, clean: false, dts: false, outputOptions: { codeSplitting: false },
          deps: { alwaysBundle: [/^typebox(?:\/|$)/, /^@moonshot-ai\//], onlyBundle: false },
          logLevel: 'silent',
        });
        for (const bundle of bundles) for (const chunk of bundle.chunks) {
          if (chunk.type === 'chunk') for (const id of chunk.moduleIds) if (isAbsolute(id) && !id.includes('node_modules')) this.addWatchFile(id);
        }
        const { schemas } = await import(pathToFileURL(join(directory, 'registry.mjs')).href);
        const tops = [];
        for (const [name, validators] of Object.entries(schemas)) {
          const imports = [];
          const fields = [];
          for (const [key, schema] of Object.entries(validators)) {
            const local = `aot${fields.length}`;
            imports.push(`v${tops.length} as ${local}`);
            fields.push(`${JSON.stringify(key)}: ${local}`);
            tops.push(schema);
          }
          modules.set(`${sharedDir}${name}.ts`, { imports: `import { ${imports.join(', ')} } from ${JSON.stringify(runtimeId)};`, value: `{${fields.join(',')}}` });
        }
        generated = browserValidatorModule(tops);
      } finally {
        for (const bundle of bundles) await bundle[Symbol.asyncDispose]();
        await rm(directory, { recursive: true, force: true });
      }
    },
    resolveId(id) {
      if (id === runtimeId) return { id, moduleSideEffects: false };
    },
    load(id) {
      if (id === runtimeId) return { code: generated, moduleSideEffects: false };
    },
    transform(code, id) {
      id = id.replaceAll('\\', '/');
      if (id.includes('/typebox/')) return { code, moduleSideEffects: false };
      if (!id.startsWith(sharedDir)) return;
      const replacement = modules.get(id);
      if (!replacement && !id.endsWith('/browser-schema.ts') && !id.endsWith('/browser-validator.ts')) return;
      const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true);
      const edits = [];
      let replaced = false;
      const visit = node => {
        if (replacement && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'browserValidators') {
          edits.push({ start: node.initializer.getStart(source), end: node.initializer.end, text: replacement.value });
          replaced = true;
          return;
        }
        if (ts.isVariableDeclaration(node) && node.initializer && ts.isVariableStatement(node.parent.parent) && ts.isSourceFile(node.parent.parent.parent)) {
          let buildsSchema = false;
          const inspect = child => {
            if (ts.isPropertyAccessExpression(child) && child.expression.getText(source) === 'Type') buildsSchema = true;
            ts.forEachChild(child, inspect);
          };
          inspect(node.initializer);
          if (buildsSchema) {
            edits.push({ start: node.initializer.getStart(source), end: node.initializer.end, text: `/* @__PURE__ */ (() => (${node.initializer.getText(source)}))()` });
            return;
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      if (replacement && !replaced) throw new Error(`Browser AOT registry is missing in ${id}`);
      for (const edit of edits.sort((a, b) => b.start - a.start)) code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
      return { code: `${replacement?.imports ?? ''}\n${code}`, map: null, moduleSideEffects: false };
    },
  };
}
