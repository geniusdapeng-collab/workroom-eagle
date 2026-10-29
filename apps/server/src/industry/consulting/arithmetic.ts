/**
 * Bounded arithmetic contradiction checks, not a financial opinion engine.
 * Grammar: decimal quantities, known units, + - * / %, parentheses. No eval,
 * identifiers, functions, exponentiation, implicit multiplication or network I/O.
 */
type Dimension = Record<string, number>;
interface Quantity { value: number; dimension: Dimension }
type Calculation = { status: "checked"; quantity: Quantity }
  | { status: "unsupported" | "invalid"; reason: string };
export interface ArithmeticCheck { path: string; expression: string; status: "checked" | "unsupported" | "invalid" | "mismatch"; reason?: string; actual?: number; expected?: number }
export interface ArithmeticReport {
  schemaVersion: "eagle.arithmetic-review/v1"; checkedCount: number; unsupportedCount: number;
  checks: ArithmeticCheck[]; issues: ArithmeticCheck[];
  disclosure: string;
}
const UNITS: Record<string, { factor: number; dimension: string | null }> = {
  元: { factor: 1, dimension: "currency" }, 万元: { factor: 10000, dimension: "currency" }, 亿元: { factor: 100000000, dimension: "currency" },
  天: { factor: 1, dimension: "time" }, 日: { factor: 1, dimension: "time" }, 小时: { factor: 1 / 24, dimension: "time" },
  人天: { factor: 1, dimension: "labor" },
  // A percentage-point difference is a difference between two dimensionless
  // percentages: 8% - 3% = 5 percentage points = 0.05.
  个百分点: { factor: 0.01, dimension: null }, 百分点: { factor: 0.01, dimension: null },
};
const normalize = (text: string) => text.replace(/[−–]/g, "-").replace(/×/g, "*").replace(/÷/g, "/").replace(/（/g, "(").replace(/）/g, ")").replace(/％/g, "%");
const dimensions = (value: Dimension) => JSON.stringify(Object.entries(value).filter(([, n]) => n !== 0).sort(([a], [b]) => a.localeCompare(b)));
function combine(a: Dimension, b: Dimension, sign: number): Dimension {
  const out = { ...a };
  for (const [key, value] of Object.entries(b)) out[key] = (out[key] ?? 0) + sign * value;
  return out;
}
class ParseFailure extends Error { constructor(readonly status: "unsupported" | "invalid", readonly reason: string) { super(reason); } }
const bad = (status: "unsupported" | "invalid", reason: string): never => { throw new ParseFailure(status, reason); };

/** Result explicitly distinguishes an unsupported formula from a checked one. */
export function evaluateNumericExpression(source: string): Calculation {
  const text = normalize(source).trim();
  if (!text || text.length > 512) return { status: "unsupported", reason: "EXPRESSION_LENGTH" };
  const tokens: Array<{ kind: "quantity"; value: number; dimension: Dimension } | { kind: string }> = [];
  try {
    let at = 0;
    while (at < text.length) {
      if (/\s/u.test(text[at]!)) { at++; continue; }
      if (tokens.length >= 128) bad("unsupported", "TOKEN_LIMIT");
      const rest = text.slice(at);
      const number = /^(?:(?:\d{1,3}(?:,\d{3})+)|(?:\d+))(?:\.\d+)?|^\.\d+/.exec(rest);
      if (number) {
        const value = Number(number[0].replace(/,/g, ""));
        if (!Number.isFinite(value) || Math.abs(value) > 1e15) bad("unsupported", "NUMBER_RANGE");
        at += number[0].length;
        const suffix = /^(万元|亿元|人天|小时|个百分点|百分点|元|天|日|%)/.exec(text.slice(at));
        const unit = suffix ? UNITS[suffix[0]] : undefined;
        const factor = suffix?.[0] === "%" ? 0.01 : unit?.factor ?? 1;
        tokens.push({ kind: "quantity", value: value * factor, dimension: unit?.dimension ? { [unit.dimension]: 1 } : {} });
        if (suffix) at += suffix[0].length;
        continue;
      }
      const unit = /^(万元|亿元|人天|小时|个百分点|百分点|元|天|日)/.exec(rest);
      if (unit) {
        const definition = UNITS[unit[0]]!;
        tokens.push({ kind: "quantity", value: definition.factor, dimension: definition.dimension ? { [definition.dimension]: 1 } : {} });
        at += unit[0].length; continue;
      }
      if ("+-*/()".includes(text[at]!)) { tokens.push({ kind: text[at]! }); at++; continue; }
      bad("unsupported", "UNKNOWN_SYMBOL_OR_UNIT");
    }
    let cursor = 0;
    const finite = (q: Quantity): Quantity => {
      if (!Number.isFinite(q.value) || Math.abs(q.value) > 1e18) bad("invalid", "NONFINITE_OR_OVERFLOW");
      if (Object.values(q.dimension).some((n) => Math.abs(n) > 4)) bad("unsupported", "UNIT_POWER");
      return q;
    };
    const primary = (depth: number): Quantity => {
      if (depth > 16) bad("unsupported", "PARENTHESIS_DEPTH");
      const token = tokens[cursor++];
      if (!token) return bad("unsupported", "MISSING_OPERAND");
      if (token.kind === "+" || token.kind === "-") { const q = primary(depth + 1); return { ...q, value: token.kind === "-" ? -q.value : q.value }; }
      if (token.kind === "(") {
        const q = expression(depth + 1);
        if (tokens[cursor++]?.kind !== ")") bad("unsupported", "UNBALANCED_PARENTHESES");
        return q;
      }
      if (token.kind !== "quantity" || !("value" in token) || !("dimension" in token)) return bad("unsupported", "EXPECTED_QUANTITY");
      return { value: token.value as number, dimension: token.dimension as Dimension };
    };
    const term = (depth: number): Quantity => {
      let left = primary(depth);
      while (["*", "/"].includes(tokens[cursor]?.kind ?? "")) {
        const op = tokens[cursor++]!.kind; const right = primary(depth);
        if (op === "/" && right.value === 0) bad("invalid", "DIVISION_BY_ZERO");
        left = finite({ value: op === "*" ? left.value * right.value : left.value / right.value,
          dimension: combine(left.dimension, right.dimension, op === "*" ? 1 : -1) });
      }
      return left;
    };
    const expression = (depth: number): Quantity => {
      let left = term(depth);
      while (["+", "-"].includes(tokens[cursor]?.kind ?? "")) {
        const op = tokens[cursor++]!.kind; const right = term(depth);
        if (dimensions(left.dimension) !== dimensions(right.dimension)) bad("invalid", "INCOMPATIBLE_UNITS");
        left = finite({ value: op === "+" ? left.value + right.value : left.value - right.value, dimension: left.dimension });
      }
      return left;
    };
    const quantity = expression(0);
    if (cursor !== tokens.length) bad("unsupported", "TRAILING_OR_IMPLICIT_EXPRESSION");
    return { status: "checked", quantity: finite(quantity) };
  } catch (error) {
    if (error instanceof ParseFailure) return { status: error.status, reason: error.reason };
    throw error;
  }
}

function roundingTolerance(text: string, value: number): number {
  const literal = /^[-+]?(\d+(?:\.\d+)?|\.\d+)\s*(万元|亿元|人天|小时|个百分点|百分点|元|天|日|%)?$/.exec(text.trim());
  if (!literal) return Math.max(1e-9, Math.abs(value) * 1e-10);
  const places = literal[1]!.split(".")[1]?.length ?? 0;
  const scale = literal[2] === "%" ? 0.01 : UNITS[literal[2] ?? ""]?.factor ?? 1;
  return 0.5 * 10 ** -places * scale + Math.max(1e-9, Math.abs(value) * 1e-12);
}
function compare(path: string, left: string, right: string): ArithmeticCheck {
  const a = evaluateNumericExpression(left); const b = evaluateNumericExpression(right);
  const expression = `${left}=${right}`;
  if (a.status !== "checked" || b.status !== "checked") {
    const invalid = [a, b].find((x) => x.status === "invalid");
    const failed = invalid ?? [a, b].find((x) => x.status !== "checked")!;
    return { path, expression, status: invalid ? "invalid" : "unsupported", reason: "reason" in failed ? failed.reason : "UNSUPPORTED" };
  }
  // A prose price may omit its denominator (3000元×12人天=3.6万元).
  // Do not invent that denominator or falsely certify/reject such a claim.
  if (dimensions(a.quantity.dimension) !== dimensions(b.quantity.dimension)) return { path, expression, status: "unsupported", reason: "UNIT_CONTEXT_REQUIRES_REVIEW" };
  const tolerance = roundingTolerance(right, b.quantity.value);
  return { path, expression, status: Math.abs(a.quantity.value - b.quantity.value) <= tolerance ? "checked" : "mismatch", expected: a.quantity.value, actual: b.quantity.value };
}

export function inspectArithmeticText(text: string, path = "text"): ArithmeticCheck[] {
  const normalized = normalize(text); const checks: ArithmeticCheck[] = [];
  // Complete numeric runs only. Labels inside a formula (e.g. 收入1200-成本900)
  // cannot be reconstructed safely and remain outside this numeric grammar.
  for (const match of normalized.matchAll(/[0-9.,+\-*/()%=\s元万亿天日小时人个百分点]+/gu)) {
    const expression = match[0].trim();
    if (!expression.includes("=") || !/\d/u.test(expression)) continue;
    const start = (match.index ?? 0) + match[0].indexOf(expression);
    const before = normalized[start - 1] ?? "";
    const sides = expression.split("=").map((side) => side.trim());
    if (sides.some((side) => !side) || /[A-Za-z_^.]/u.test(before)) continue;
    // Do not reinterpret the final operand in a Chinese-labelled expression
    // as an independent assertion (e.g. 成本900=300 in 毛利=收入1200-成本900=300).
    if (/\p{L}/u.test(before) && !/[+\-*/]/u.test(sides[0]!)) continue;
    for (let i = 0; i + 1 < sides.length; i++) checks.push(compare(path, sides[i]!, sides[i + 1]!));
  }
  // Also check a displayed percentage immediately followed by its numeric
  // derivation: the actual captured defect was 75%((1200-900)/1200).
  for (const match of normalized.matchAll(/([-+]?\d+(?:\.\d+)?)%\s*\(/gu)) {
    const open = (match.index ?? 0) + match[0].lastIndexOf("(");
    let level = 1; let end = open + 1;
    for (; end < normalized.length && level; end++) {
      if (normalized[end] === "(") level++;
      else if (normalized[end] === ")") level--;
    }
    if (level) { checks.push({ path, expression: match[0], status: "unsupported", reason: "UNBALANCED_PARENTHESES" }); continue; }
    const formula = normalized.slice(open + 1, end - 1).trim();
    if (formula.includes("=")) continue; // Explicit equation is handled above.
    // A percentage followed by a delta annotation such as "8%（+5个百分点）"
    // is not a derivation. Require an infix operator after any leading sign
    // before interpreting the parenthesized material as a calculation.
    if (!/[+\-*/]/u.test(formula.replace(/^[+-]/u, ""))) {
      // Pure prose in parentheses is not a derivation, but record the
      // unverifiable percentage context instead of silently certifying it.
      if (!/\d|[%％]|元|万亿|天|小时|人/u.test(formula)) {
        checks.push({ path, expression: match[0], status: "unsupported", reason: "UNSUPPORTED_DERIVATION_CONTEXT" });
      }
      continue;
    }
    checks.push(compare(path, formula, `${match[1]}%`));
  }
  return checks;
}

export function inspectArtifactArithmetic(artifact: {
  summary: string; findings: Array<{ claim: string }>; recommendations: Array<{ action: string; verification: string }>;
}): ArithmeticReport {
  const fields = [{ path: "summary", text: artifact.summary },
    ...artifact.findings.map((item, index) => ({ path: `findings[${index}].claim`, text: item.claim })),
    ...artifact.recommendations.flatMap((item, index) => [{ path: `recommendations[${index}].action`, text: item.action }, { path: `recommendations[${index}].verification`, text: item.verification }])];
  const checks = fields.flatMap(({ path, text }) => inspectArithmeticText(text, path));
  return { schemaVersion: "eagle.arithmetic-review/v1", checkedCount: checks.filter((item) => item.status === "checked").length,
    unsupportedCount: checks.filter((item) => item.status === "unsupported").length, checks,
    issues: checks.filter((item) => item.status === "mismatch" || item.status === "invalid"),
    disclosure: "Only recognized explicit numeric equations and percentage-with-formula claims are checked. Unknown formulas, omitted units, source accuracy, business assumptions, financial semantics and prose-only calculations require human review. Source quotations and counter-evidence are preserved as data, not silently rewritten or certified." };
}
