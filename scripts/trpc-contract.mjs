/** Compare web references with the composed router without invoking procedures.
 * Pinned tRPC metadata: https://github.com/trpc/trpc/blob/v11.19.0/packages/server/src/unstable-core-do-not-import/router.ts
 */
import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript-governance";

const transportMethods = new Set(["query", "mutate", "subscribe"]);
const clientFactories = new Set(["createTRPCClient", "createTRPCProxyClient"]);
const isAccess = (node) => ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);
const isWrapper = (node) => node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
  || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node));
function unwrap(node) { while (isWrapper(node)) node = node.expression; return node; }
function outerWrapper(node) { while (isWrapper(node.parent) && node.parent.expression === node) node = node.parent; return node; }
function constDeclaration(declaration) {
  return ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)
    && ts.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & ts.NodeFlags.Const) !== 0;
}
function localConstDeclaration(declaration) {
  if (!constDeclaration(declaration)) return false;
  const statement = declaration.parent.parent;
  return !ts.isVariableStatement(statement) || !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}
function getterBody(declaration) {
  const value = declaration?.initializer && unwrap(declaration.initializer);
  if (!value || !(ts.isArrowFunction(value) || ts.isFunctionExpression(value)) || value.parameters.length) return null;
  if (!ts.isBlock(value.body)) return value.body;
  return value.body.statements.length === 1 && ts.isReturnStatement(value.body.statements[0])
    ? value.body.statements[0].expression : null;
}
function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    if (entry.isSymbolicLink()) throw new Error(`TRPC_CONTRACT_SOURCE_SYMLINK: ${file}`);
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [file] : [];
  });
}

function clientReferences(parsed, checker, sourceRoot) {
  const locationOf = (node) => {
    const { line, character } = parsed.getLineAndCharacterOfPosition(node.getStart(parsed));
    return { file: relative(sourceRoot, parsed.fileName), line: line + 1, column: character + 1 };
  };
  const fail = (code, node) => {
    const location = locationOf(node);
    throw new Error(`${code}: ${location.file}:${location.line}`);
  };
  const declarationOf = (identifier) => checker.getSymbolAtLocation(identifier)?.valueDeclaration;
  function clientFactory(input, seen = new Set()) {
    const node = unwrap(input);
    if (!ts.isIdentifier(node)) return false;
    const symbol = checker.getSymbolAtLocation(node);
    if (!symbol) return clientFactories.has(node.text); // Standalone contract fixtures.
    if (symbol.declarations?.some((decl) => ts.isImportSpecifier(decl)
      && clientFactories.has((decl.propertyName ?? decl.name).text)
      && ts.isStringLiteral(decl.parent.parent.parent.moduleSpecifier)
      && decl.parent.parent.parent.moduleSpecifier.text === "@trpc/client")) return true;
    const declaration = declarationOf(node);
    if (!declaration || !constDeclaration(declaration) || !declaration.initializer || seen.has(declaration)) return false;
    return clientFactory(declaration.initializer, new Set(seen).add(declaration));
  }
  function rootIdentifier(node, declaration) {
    const symbol = checker.getSymbolAtLocation(node);
    if (!symbol) return node.text === "trpc"; // Standalone contract fixtures.
    if (symbol.declarations?.some((decl) => ts.isImportSpecifier(decl)
      && (decl.propertyName ?? decl.name).text === "trpc")) return true;
    const init = declaration?.initializer && unwrap(declaration.initializer);
    if (!init || !ts.isCallExpression(init) || !clientFactory(init.expression)) return false;
    if (!constDeclaration(declaration)) fail("TRPC_CONTRACT_MUTABLE_ALIAS", node);
    return true;
  }
  function accessPath(input, seen = new Set()) {
    const node = unwrap(input);
    if (ts.isIdentifier(node)) {
      const declaration = declarationOf(node);
      if (rootIdentifier(node, declaration)) return { parts: [], dynamic: false };
      if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer || seen.has(declaration)) return null;
      const nextSeen = new Set(seen).add(declaration);
      const value = accessPath(declaration.initializer, nextSeen);
      if (value && !constDeclaration(declaration)) fail("TRPC_CONTRACT_MUTABLE_ALIAS", node);
      return value;
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (!ts.isIdentifier(callee)) return null;
      const declaration = declarationOf(callee);
      const body = getterBody(declaration);
      if (!body || seen.has(declaration)) return null;
      const value = accessPath(body, new Set(seen).add(declaration));
      if (value && (!constDeclaration(declaration) || node.arguments.length)) fail("TRPC_CONTRACT_UNSUPPORTED_GETTER", node);
      return value;
    }
    if (!isAccess(node)) return null;
    const base = accessPath(node.expression, seen);
    if (!base) return null;
    if (ts.isPropertyAccessExpression(node)) return { ...base, parts: [...base.parts, node.name.text] };
    const key = node.argumentExpression;
    return key && (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key))
      ? { ...base, parts: [...base.parts, key.text] } : { ...base, dynamic: true };
  }
  function aliasOrigin(node) {
    let outer = outerWrapper(node);
    if (ts.isVariableDeclaration(outer.parent) && outer.parent.initializer === outer) return localConstDeclaration(outer.parent);
    let fn = outer.parent;
    if (ts.isReturnStatement(fn) && fn.expression === outer && ts.isBlock(fn.parent)
      && fn.parent.statements.length === 1) fn = fn.parent.parent;
    if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && fn.parameters.length === 0) {
      outer = outerWrapper(fn);
      return ts.isVariableDeclaration(outer.parent) && outer.parent.initializer === outer && localConstDeclaration(outer.parent);
    }
    return false;
  }
  const references = [];
  const visit = (node) => {
    if (isAccess(node) || ts.isCallExpression(node)) {
      const outer = outerWrapper(node);
      const nested = outer.parent && isAccess(outer.parent) && outer.parent.expression === outer;
      const found = !nested && accessPath(node);
      if (found) {
        if (found.dynamic) fail("TRPC_CONTRACT_DYNAMIC_ACCESS", node);
        const segments = [...found.parts];
        const kind = transportMethods.has(segments.at(-1)) ? "procedure" : "namespace";
        if (kind === "procedure") segments.pop();
        if (!segments.length) fail("TRPC_CONTRACT_EMPTY_PATH", node);
        if (kind === "namespace" && !aliasOrigin(node)) fail("TRPC_CONTRACT_UNRESOLVED_ESCAPE", node);
        references.push({ path: segments.join("."), kind, ...locationOf(node) });
      }
    }
    // A namespace passed, returned or stored elsewhere cannot be certified by
    // checking its prefix. Supported aliases remain local consts or const getters.
    if (ts.isIdentifier(node)) {
      const outer = outerWrapper(node);
      const parent = outer.parent;
      const expressionUse = parent && !ts.isTypeNode(parent)
        && !ts.isImportSpecifier(parent) && !ts.isImportClause(parent)
        && !(ts.isVariableDeclaration(parent) && parent.name === outer)
        && !(isAccess(parent) && (parent.expression === outer || (ts.isPropertyAccessExpression(parent) && parent.name === outer)))
        && !(ts.isCallExpression(parent) && parent.expression === outer);
      if (expressionUse) {
        const body = getterBody(declarationOf(node));
        if (body && accessPath(body)) fail("TRPC_CONTRACT_UNRESOLVED_ESCAPE", node);
        if (accessPath(node) && !aliasOrigin(node)) fail("TRPC_CONTRACT_UNRESOLVED_ESCAPE", node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return references;
}

/** Actual flattened mount table is the authority; missing threshold stays zero. */
export function auditTrpcContract({ router, sourceRoot }) {
  const def = router?._def;
  if (!def || def.router !== true || !def.procedures || typeof def.procedures !== "object"
    || Array.isArray(def.procedures) || Object.values(def.procedures).some((procedure) => typeof procedure !== "function")) {
    throw new Error("TRPC_CONTRACT_ROUTER_METADATA_INVALID");
  }
  if (def.lazy && Object.keys(def.lazy).length) throw new Error("TRPC_CONTRACT_LAZY_ROUTERS_UNRESOLVED");
  const mountedPaths = Object.keys(def.procedures).sort();
  const mounted = new Set(mountedPaths);
  const files = sourceFiles(resolve(sourceRoot));
  // Binding symbols prevents identically named aliases in nested scopes from
  // being confused. noResolve/noLib keeps this a local syntax and binding scan.
  const program = ts.createProgram(files, { noResolve: true, noLib: true, jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.Latest, skipLibCheck: true });
  const checker = program.getTypeChecker();
  const references = files.flatMap((file) => {
    const parsed = program.getSourceFile(file);
    if (!parsed) throw new Error(`TRPC_CONTRACT_SOURCE_UNREADABLE: ${file}`);
    if (parsed.parseDiagnostics.length) throw new Error(`TRPC_CONTRACT_SOURCE_PARSE_FAILED: ${relative(sourceRoot, file)}: ${
      ts.flattenDiagnosticMessageText(parsed.parseDiagnostics[0].messageText, " ")}`);
    return clientReferences(parsed, checker, resolve(sourceRoot));
  }).sort((a, b) => a.path.localeCompare(b.path) || a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
  const missing = references.filter(({ path, kind }) => !mounted.has(path)
    && (kind === "procedure" || !mountedPaths.some((mountedPath) => mountedPath.startsWith(`${path}.`))));
  return { files, references, mountedPaths, missing };
}
