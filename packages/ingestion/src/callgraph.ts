import fs from 'fs';
import path from 'path';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';
import Go from 'tree-sitter-go';
import PHP from 'tree-sitter-php';

// ---------------------------------------------------------------------------
// Code tree: route > class > function/method nodes, with containment ("contains")
// and name-resolved call ("calls") edges. Supplements vector search: a hit on a
// function pulls in its route, parent class, and callees.
//
// ponytail: name-based call resolution, not full scope/import resolution —
// good enough for retrieval expansion, not a compiler. Upgrade to resolving
// through import bindings if false-positive edges become a problem.
// ---------------------------------------------------------------------------

// http_call: an outbound HTTP request site (name = "GET /api/foo"). The cross-service
// linker later matches these to route nodes in other repos via http_calls edges.
export type CodeNodeKind = 'route' | 'class' | 'function' | 'method' | 'http_call';

export interface CodeNode {
  id: string;
  kind: CodeNodeKind;
  name: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
}

export interface CodeEdge {
  from: string;
  to: string;
  kind: 'contains' | 'calls';
  confidence?: number; // set on 'calls' edges by resolution strategy; null for structural edges
}

export interface CodeTree {
  nodes: CodeNode[];
  edges: CodeEdge[];
}

// Kept for the existing /repos/:name/callgraph endpoint
export interface CallGraphNode {
  id: string;
  symbolName: string;
  filePath: string;
  language: string;
  startLine: number;
  kind: 'function' | 'method';
}

export interface CallGraphEdge {
  caller: string;
  callee: string;
}

export interface CallGraph {
  nodes: CallGraphNode[];
  edges: CallGraphEdge[];
}

const LANGUAGES: Record<string, unknown> = {
  typescript: TypeScript.typescript,
  javascript: TypeScript.typescript, // permissive superset, fine for plain JS too
  python: Python,
  go: Go,
  php: PHP.php,
};

const DECL_TYPES: Record<string, Array<{ type: string; kind: 'function' | 'method' }>> = {
  typescript: [
    { type: 'function_declaration', kind: 'function' },
    { type: 'method_definition', kind: 'method' },
  ],
  javascript: [
    { type: 'function_declaration', kind: 'function' },
    { type: 'method_definition', kind: 'method' },
  ],
  python: [{ type: 'function_definition', kind: 'function' }],
  go: [
    { type: 'function_declaration', kind: 'function' },
    { type: 'method_declaration', kind: 'method' },
  ],
  php: [
    { type: 'function_definition', kind: 'function' },
    { type: 'method_declaration', kind: 'method' },
  ],
};

const CLASS_TYPES: Record<string, string[]> = {
  typescript: ['class_declaration'],
  javascript: ['class_declaration'],
  python: ['class_definition'],
  go: [], // ponytail: Go has no classes; method nodes stand alone
  php: ['class_declaration', 'trait_declaration'],
};

const HTTP_VERBS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'all', 'route']);

interface Decl {
  node: CodeNode;
  // body to scan for outgoing calls (null for class nodes)
  bodyNode: Parser.SyntaxNode | null;
  // handlers referenced by a route registration, resolved to edges later;
  // className set for [Controller::class, 'method'] / 'Controller@method' style
  handlerRefs: Array<{ className?: string; methodName: string }>;
}

export function buildCodeTree(
  repoPath: string,
  files: Array<{ filePath: string; language: string | null }>,
): CodeTree {
  const parser = new Parser();
  const decls: Decl[] = [];
  const edges: CodeEdge[] = [];
  const edgeKeys = new Set<string>();

  const addEdge = (from: string, to: string, kind: CodeEdge['kind'], confidence?: number) => {
    const key = `${from}->${to}:${kind}`;
    if (from === to || edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from, to, kind, confidence });
  };

  for (const f of files) {
    if (!f.language || !LANGUAGES[f.language]) continue;
    let content: string;
    try {
      content = fs.readFileSync(path.join(repoPath, f.filePath), 'utf-8');
    } catch {
      continue;
    }

    parser.setLanguage(LANGUAGES[f.language] as Parser.Language);
    let tree: Parser.Tree;
    try {
      tree = parser.parse(content);
    } catch {
      continue;
    }

    collectFile(tree.rootNode, f.filePath, f.language, decls, addEdge);
  }

  // Resolve call + route-handler edges by name: same file wins, else unique global match
  const byName = new Map<string, Decl[]>();
  const byFileAndName = new Map<string, Decl>();
  for (const d of decls) {
    const list = byName.get(d.node.name) ?? [];
    list.push(d);
    byName.set(d.node.name, list);
    byFileAndName.set(`${d.node.filePath}:${d.node.name}`, d);
  }

  // Two-strategy cascade with confidence: same-file exact (0.9) beats unique-global name (0.7).
  const resolve = (fromFile: string, name: string): { decl: Decl; confidence: number } | undefined => {
    const sameFile = byFileAndName.get(`${fromFile}:${name}`);
    if (sameFile) return { decl: sameFile, confidence: 0.9 };
    const candidates = byName.get(name) ?? [];
    return candidates.length === 1 ? { decl: candidates[0], confidence: 0.7 } : undefined;
  };

  // Class-qualified resolution: find the class, then its method by name within
  // the class's file + line range (controller methods like `index` repeat everywhere)
  const resolveMethod = (className: string, methodName: string): Decl | undefined => {
    const classes = (byName.get(className) ?? []).filter((d) => d.node.kind === 'class');
    for (const cls of classes) {
      const method = decls.find(
        (d) =>
          d.node.kind === 'method' &&
          d.node.name === methodName &&
          d.node.filePath === cls.node.filePath &&
          d.node.startLine >= cls.node.startLine &&
          d.node.endLine <= cls.node.endLine,
      );
      if (method) return method;
    }
    return undefined;
  };

  // Outbound HTTP call-sites become http_call nodes contained by their enclosing decl.
  const httpNodes: CodeNode[] = [];
  const httpIds = new Set<string>();

  for (const d of decls) {
    for (const ref of d.handlerRefs) {
      const handler = ref.className
        ? resolveMethod(ref.className, ref.methodName)
        : resolve(d.node.filePath, ref.methodName)?.decl;
      if (handler) addEdge(d.node.id, handler.node.id, 'contains');
    }
    if (!d.bodyNode) continue;
    for (const calleeName of collectCallNames(d.bodyNode)) {
      const callee = resolve(d.node.filePath, calleeName);
      if (callee) addEdge(d.node.id, callee.decl.node.id, 'calls', callee.confidence);
    }
    // Test files make fake requests ($this->get(...), supertest, etc.) — not real service calls.
    if (isTestPath(d.node.filePath)) continue;
    for (const site of collectHttpCalls(d.bodyNode, d.node.language)) {
      const id = `${d.node.filePath}#http:${site.method} ${site.path}#${site.row}`;
      if (!httpIds.has(id)) {
        httpIds.add(id);
        httpNodes.push({
          id,
          kind: 'http_call',
          name: `${site.method} ${site.path}`,
          filePath: d.node.filePath,
          language: d.node.language,
          startLine: site.row,
          endLine: site.row,
        });
      }
      addEdge(d.node.id, id, 'contains');
    }
  }

  return { nodes: [...decls.map((d) => d.node), ...httpNodes], edges };
}

/** Legacy view: functions/methods + call edges only (used by the /callgraph endpoint). */
export function buildCallGraph(
  repoPath: string,
  files: Array<{ filePath: string; language: string | null }>,
): CallGraph {
  const tree = buildCodeTree(repoPath, files);
  const fnIds = new Set(
    tree.nodes.filter((n) => n.kind === 'function' || n.kind === 'method').map((n) => n.id),
  );
  return {
    nodes: tree.nodes
      .filter((n) => fnIds.has(n.id))
      .map((n) => ({
        id: n.id,
        symbolName: n.name,
        filePath: n.filePath,
        language: n.language,
        startLine: n.startLine,
        kind: n.kind as 'function' | 'method',
      })),
    edges: tree.edges
      .filter((e) => e.kind === 'calls' && fnIds.has(e.from) && fnIds.has(e.to))
      .map((e) => ({ caller: e.from, callee: e.to })),
  };
}

// ---------------------------------------------------------------------------

function collectFile(
  root: Parser.SyntaxNode,
  filePath: string,
  language: string,
  out: Decl[],
  addEdge: (from: string, to: string, kind: CodeEdge['kind']) => void,
): void {
  const declTypes = DECL_TYPES[language] ?? [];
  const classTypes = new Set(CLASS_TYPES[language] ?? []);

  const makeId = (name: string, row: number) => `${filePath}#${name}#${row}`;

  // Laravel: routes/api.php is mounted under /api by the framework's RouteServiceProvider.
  const initialPrefix = /(^|\/)routes\/api\.php$/.test(filePath) ? '/api' : '';

  // parents: enclosing class/function/route node ids, innermost last
  // prefix: accumulated Route::prefix()/group(['prefix'=>]) path for PHP route nesting
  const visit = (n: Parser.SyntaxNode, parents: string[], prefix: string) => {
    let nextParents = parents;
    let nextPrefix = prefix;
    if (language === 'php') {
      const gp = groupPrefix(n);
      if (gp) nextPrefix = joinPath(prefix, gp);
    }

    if (classTypes.has(n.type)) {
      const nameNode = n.childForFieldName('name');
      if (nameNode) {
        const id = makeId(nameNode.text, n.startPosition.row);
        out.push({
          node: {
            id,
            kind: 'class',
            name: nameNode.text,
            filePath,
            language,
            startLine: n.startPosition.row,
            endLine: n.endPosition.row,
          },
          bodyNode: null,
          handlerRefs: [],
        });
        if (parents.length) addEdge(parents[parents.length - 1], id, 'contains');
        nextParents = [...parents, id];
      }
    } else {
      const match = declTypes.find((t) => t.type === n.type);
      if (match) {
        const nameNode = n.childForFieldName('name');
        const bodyNode = n.childForFieldName('body');
        if (nameNode && bodyNode) {
          const insideClass = parents.length > 0 &&
            out.some((d) => d.node.id === parents[parents.length - 1] && d.node.kind === 'class');
          const id = makeId(nameNode.text, n.startPosition.row);
          out.push({
            node: {
              id,
              kind: insideClass && match.kind === 'function' ? 'method' : match.kind,
              name: nameNode.text,
              filePath,
              language,
              startLine: n.startPosition.row,
              endLine: n.endPosition.row,
            },
            bodyNode,
            handlerRefs: [],
          });
          if (parents.length) addEdge(parents[parents.length - 1], id, 'contains');
          if (language === 'python') {
            const route = pythonDecoratorRoute(n, filePath, language, makeId);
            if (route) {
              out.push(route);
              addEdge(route.node.id, id, 'contains');
            }
          }
          nextParents = [...parents, id];
        }
      } else if ((language === 'typescript' || language === 'javascript') && n.type === 'call_expression') {
        const route = tsRouteCall(n, filePath, language, makeId);
        if (route) {
          out.push(route);
          if (parents.length) addEdge(parents[parents.length - 1], route.node.id, 'contains');
          // inline handlers are scanned as the route's own body via bodyNode
        }
      } else if (language === 'php' && n.type === 'scoped_call_expression') {
        const route = phpRouteCall(n, filePath, language, makeId, prefix);
        if (route) {
          out.push(route);
          if (parents.length) addEdge(parents[parents.length - 1], route.node.id, 'contains');
        }
      }
    }

    for (const child of n.children) visit(child, nextParents, nextPrefix);
  };

  visit(root, [], initialPrefix);
}

/** app.get('/path', handler) style registration → route node. */
function tsRouteCall(
  n: Parser.SyntaxNode,
  filePath: string,
  language: string,
  makeId: (name: string, row: number) => string,
): Decl | null {
  const fn = n.childForFieldName('function');
  if (!fn || fn.type !== 'member_expression') return null;
  const prop = fn.childForFieldName('property');
  if (!prop || !HTTP_VERBS.has(prop.text)) return null;

  const args = n.childForFieldName('arguments');
  if (!args) return null;
  const argNodes = args.namedChildren;
  const first = argNodes[0];
  if (!first || (first.type !== 'string' && first.type !== 'template_string')) return null;

  const routePath = first.text.replace(/^[`'"]|[`'"]$/g, '');
  // ignore non-path strings (event names etc.) — routes start with /
  if (!routePath.startsWith('/')) return null;

  const name = `${prop.text.toUpperCase()} ${routePath}`;
  const handlerRefs: Decl['handlerRefs'] = [];
  let bodyNode: Parser.SyntaxNode | null = null;

  for (const arg of argNodes.slice(1)) {
    if (arg.type === 'identifier') handlerRefs.push({ methodName: arg.text });
    if (arg.type === 'arrow_function' || arg.type === 'function_expression' || arg.type === 'function') {
      bodyNode = arg; // inline handler: its calls become the route's calls
    }
  }

  return {
    node: {
      id: makeId(`route:${name}`, n.startPosition.row),
      kind: 'route',
      name,
      filePath,
      language,
      startLine: n.startPosition.row,
      endLine: n.endPosition.row,
    },
    bodyNode,
    handlerRefs,
  };
}

/** Join a route prefix and path into one normalized absolute path: /a/b, no trailing slash. */
function joinPath(prefix: string, path: string): string {
  const segs = `${prefix}/${path}`.split('/').filter((s) => s.length > 0);
  return segs.length ? '/' + segs.join('/') : '/';
}

/**
 * The path prefix contributed by a Laravel route group, or null if `n` isn't a
 * group call or carries no prefix. Handles `Route::prefix('x')->group(...)`
 * (including middleware/controller chains) and `Route::group(['prefix'=>'x'], ...)`.
 */
function groupPrefix(n: Parser.SyntaxNode): string | null {
  const method = n.childForFieldName('name')?.text;
  if (method !== 'group') return null;

  // Route::group(['prefix' => 'x'], ...)
  if (n.type === 'scoped_call_expression') {
    const args = n.childForFieldName('arguments');
    const first = args?.namedChildren.map((a) => (a.type === 'argument' ? a.namedChildren[0] ?? a : a))[0];
    if (first?.type === 'array_creation_expression') {
      for (const el of first.namedChildren) {
        const parts = el.namedChildren;
        if (parts.length >= 2 && stripQuotes(parts[0].text) === 'prefix') {
          return stripQuotes(parts[1].text);
        }
      }
    }
    return null;
  }

  // Route::prefix('x')->group(...) / Route::middleware(...)->prefix('x')->group(...)
  let obj: Parser.SyntaxNode | null = n.childForFieldName('object');
  while (obj && (obj.type === 'member_call_expression' || obj.type === 'scoped_call_expression')) {
    if (obj.childForFieldName('name')?.text === 'prefix') {
      const args = obj.childForFieldName('arguments');
      const first = args?.namedChildren.map((a) => (a.type === 'argument' ? a.namedChildren[0] ?? a : a))[0];
      if (first && STRING_NODE_TYPES.has(first.type)) return stripQuotes(first.text);
    }
    obj = obj.childForFieldName('object');
  }
  return null;
}

/**
 * Laravel `Route::get('/x', [Controller::class, 'method'])` → route node.
 * Also handles legacy 'Controller@method' strings and inline closures.
 */
function phpRouteCall(
  n: Parser.SyntaxNode,
  filePath: string,
  language: string,
  makeId: (name: string, row: number) => string,
  prefix: string,
): Decl | null {
  const scope = n.childForFieldName('scope');
  const verb = n.childForFieldName('name');
  if (!scope || scope.text !== 'Route' || !verb || !HTTP_VERBS.has(verb.text)) return null;

  const args = n.childForFieldName('arguments');
  if (!args) return null;
  const argNodes = args.namedChildren.map((a) => (a.type === 'argument' ? a.namedChildren[0] ?? a : a));
  const first = argNodes[0];
  if (!first || (first.type !== 'string' && first.type !== 'encapsed_string')) return null;

  // Laravel paths often omit the leading slash ('bookings/{id}'); join with the group prefix.
  const routePath = first.text.replace(/^['"]|['"]$/g, '');
  const fullPath = joinPath(prefix, routePath);

  const name = `${verb.text.toUpperCase()} ${fullPath}`;
  const handlerRefs: Decl['handlerRefs'] = [];
  let bodyNode: Parser.SyntaxNode | null = null;

  for (const arg of argNodes.slice(1)) {
    if (!arg) continue;
    if (arg.type === 'array_creation_expression') {
      // [Controller::class, 'method']
      let className: string | undefined;
      let methodName: string | undefined;
      for (const el of arg.descendantsOfType('class_constant_access_expression')) {
        className = el.namedChildren[0]?.text;
      }
      for (const el of arg.descendantsOfType(['string', 'encapsed_string'])) {
        methodName = el.text.replace(/^['"]|['"]$/g, '');
      }
      if (className && methodName) handlerRefs.push({ className, methodName });
    } else if (arg.type === 'string' || arg.type === 'encapsed_string') {
      // 'Controller@method'
      const [className, methodName] = arg.text.replace(/^['"]|['"]$/g, '').split('@');
      if (className && methodName) handlerRefs.push({ className, methodName });
    } else if (arg.type === 'anonymous_function' || arg.type === 'arrow_function') {
      bodyNode = arg;
    }
  }

  return {
    node: {
      id: makeId(`route:${name}`, n.startPosition.row),
      kind: 'route',
      name,
      filePath,
      language,
      startLine: n.startPosition.row,
      endLine: n.endPosition.row,
    },
    bodyNode,
    handlerRefs,
  };
}

/** @app.get("/path") decorator (FastAPI/Flask style) → route node containing the function. */
function pythonDecoratorRoute(
  fnNode: Parser.SyntaxNode,
  filePath: string,
  language: string,
  makeId: (name: string, row: number) => string,
): Decl | null {
  const wrapper = fnNode.parent;
  if (!wrapper || wrapper.type !== 'decorated_definition') return null;

  for (const child of wrapper.namedChildren) {
    if (child.type !== 'decorator') continue;
    const call = child.namedChildren.find((c) => c.type === 'call');
    if (!call) continue;
    const fn = call.childForFieldName('function');
    if (!fn || fn.type !== 'attribute') continue;
    const attr = fn.childForFieldName('attribute');
    if (!attr || !HTTP_VERBS.has(attr.text)) continue;
    const args = call.childForFieldName('arguments');
    const first = args?.namedChildren[0];
    if (!first || first.type !== 'string') continue;

    const routePath = first.text.replace(/^['"]|['"]$/g, '');
    if (!routePath.startsWith('/')) continue;
    const name = `${attr.text.toUpperCase()} ${routePath}`;
    return {
      node: {
        id: makeId(`route:${name}`, child.startPosition.row),
        kind: 'route',
        name,
        filePath,
        language,
        startLine: child.startPosition.row,
        endLine: wrapper.endPosition.row,
      },
      bodyNode: null,
      handlerRefs: [],
    };
  }
  return null;
}

// ts/js/python/go call nodes carry a 'function' field; php splits by call style
const CALL_TYPES = new Set(['call_expression', 'call', 'function_call_expression']);
const PHP_METHOD_CALL_TYPES = new Set([
  'member_call_expression',
  'scoped_call_expression',
  'nullsafe_member_call_expression',
]);

// ---------------------------------------------------------------------------
// Outbound HTTP call-site extraction. Pulls (method, path) from HTTP-client calls
// so the cross-service linker can match them to route nodes in other repos.
//   fetch(url) · axios.get(url) · this.http.post(url) · requests.get(url)
//   client.request('GET', url) · http.Get(url) · http.NewRequest("GET", url) · $c->get(url)
// ponytail: literal/template URLs only — dynamic URLs built at runtime are out of scope;
// confidence on the resulting edge reflects match quality, not extraction certainty.
// ---------------------------------------------------------------------------

const HTTP_METHOD_NAMES = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options']);

/** Test files/dirs across ecosystems — their HTTP calls are fixtures, not service dependencies. */
function isTestPath(filePath: string): boolean {
  return /(^|\/)(tests?|__tests__|spec|specs)(\/|$)|\.(test|spec)\.|_test\.|Test\.php$/i.test(filePath);
}

export interface HttpCallSite {
  method: string;
  path: string;
  row: number;
}

/** Strip a string/template literal to a matchable path: drop quotes, scheme+host, query/hash;
 *  collapse interpolations (${x}) to a `{}` placeholder. Returns null if no path is resolvable. */
function extractPath(rawArg: string): string | null {
  // Strip an optional string prefix (Python f/r/b, etc.) plus surrounding quotes/backticks.
  let s = rawArg.trim().replace(/^[a-zA-Z]*[`'"]/, '').replace(/[`'"]$/, '');
  s = s.replace(/\$?\{[^}]*\}/g, '{}'); // ${x} (JS) and {x} (Python f-string) → placeholder
  s = s.split(/[?#]/)[0]; // drop query string / hash

  const scheme = s.indexOf('://');
  if (scheme !== -1) {
    const slash = s.indexOf('/', scheme + 3);
    s = slash === -1 ? '/' : s.slice(slash);
  } else if (!s.startsWith('/')) {
    // Interpolated base URL prefix like `{}/api/x` or `{}:8080/api/x` — keep from the first '/'.
    const slash = s.indexOf('/');
    if (slash > 0 && s.slice(0, slash).includes('{}')) s = s.slice(slash);
    else return null; // relative path or bare host/event name — not resolvable
  }
  return s.replace(/\/+$/, '') || '/';
}

/** First string/template argument's raw text, or null. */
function stringArg(args: Parser.SyntaxNode | null, index: number): string | null {
  if (!args) return null;
  const nodes = args.namedChildren.map((a) => (a.type === 'argument' ? a.namedChildren[0] ?? a : a));
  const a = nodes[index];
  if (!a) return null;
  return STRING_NODE_TYPES.has(a.type) ? a.text : null;
}

// String literal node types across tree-sitter grammars (ts/js, python, php, go).
const STRING_NODE_TYPES = new Set([
  'string', 'template_string', 'encapsed_string', 'interpreted_string_literal', 'raw_string_literal',
]);

function collectHttpCalls(root: Parser.SyntaxNode, language: string): HttpCallSite[] {
  const sites: HttpCallSite[] = [];
  const add = (method: string, rawUrl: string | null, row: number) => {
    if (!rawUrl) return;
    const path = extractPath(rawUrl);
    if (path) sites.push({ method: method.toUpperCase(), path, row });
  };

  const visit = (n: Parser.SyntaxNode) => {
    const row = n.startPosition.row;
    const args = n.childForFieldName('arguments');

    if (CALL_TYPES.has(n.type)) {
      const fn = n.childForFieldName('function');
      if (fn) {
        // bare fetch(url)
        if ((fn.type === 'identifier' || fn.type === 'name') && fn.text === 'fetch') {
          add('GET', stringArg(args, 0), row); // method may be in an options object; default GET
        } else {
          // member/attribute/selector call: obj.<verb>(url) or obj.request(method, url)
          const nameNode = fn.childForFieldName('property') ?? fn.childForFieldName('attribute') ?? fn.childForFieldName('field');
          const verb = nameNode?.text?.toLowerCase();
          if (verb && HTTP_METHOD_NAMES.has(verb)) add(verb, stringArg(args, 0), row);
          else if (verb === 'request') add(stripQuotes(stringArg(args, 0)) ?? 'GET', stringArg(args, 1), row);
          // Go: http.Get(url) / http.NewRequest("GET", url, ...)
          else if (fn.type === 'selector_expression') {
            const sel = fn.childForFieldName('field')?.text ?? '';
            if (HTTP_METHOD_NAMES.has(sel.toLowerCase())) add(sel, stringArg(args, 0), row);
            else if (sel === 'NewRequest') add(stripQuotes(stringArg(args, 0)) ?? 'GET', stringArg(args, 1), row);
          }
        }
      }
    } else if (PHP_METHOD_CALL_TYPES.has(n.type)) {
      const verb = n.childForFieldName('name')?.text?.toLowerCase();
      if (verb && HTTP_METHOD_NAMES.has(verb)) add(verb, stringArg(args, 0), row);
      else if (verb === 'request') add(stripQuotes(stringArg(args, 0)) ?? 'GET', stringArg(args, 1), row);
    }
    for (const child of n.children) visit(child);
  };

  visit(root);
  return sites;
}

function stripQuotes(s: string | null): string | null {
  return s ? s.replace(/^[`'"]|[`'"]$/g, '') : null;
}

function collectCallNames(root: Parser.SyntaxNode): string[] {
  const names: string[] = [];

  const visit = (n: Parser.SyntaxNode) => {
    if (CALL_TYPES.has(n.type)) {
      const fn = n.childForFieldName('function');
      if (fn) {
        // identifier/name -> direct call; member/attribute access -> use rightmost name
        const nameNode = fn.type === 'identifier' || fn.type === 'name' || fn.type === 'qualified_name'
          ? fn
          : fn.childForFieldName('property') ?? fn.childForFieldName('attribute') ?? fn.childForFieldName('field');
        if (nameNode) names.push(nameNode.text.split('\\').pop()!);
      }
    } else if (PHP_METHOD_CALL_TYPES.has(n.type)) {
      const nameNode = n.childForFieldName('name');
      if (nameNode) names.push(nameNode.text);
    }
    for (const child of n.children) visit(child);
  };

  visit(root);
  return names;
}
