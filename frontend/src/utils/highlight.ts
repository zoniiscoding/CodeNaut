/**
 * Dependency-free tokenizer for displaying indexed source safely.
 *
 * Repository content is untrusted, so this returns plain token objects that the
 * caller renders as React elements. It never produces HTML strings, so there is
 * no path to `dangerouslySetInnerHTML` and no injection surface.
 */

export type TokenKind = "plain" | "keyword" | "string" | "comment" | "number" | "function";

export interface HighlightToken {
  value: string;
  kind: TokenKind;
}

const PYTHON_KEYWORDS = new Set([
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
  "None",
  "True",
  "False",
  "self",
  "cls",
]);

// Ordered: comments and strings win over identifiers so keywords inside them stay inert.
const PATTERNS: Array<{ kind: TokenKind; pattern: RegExp }> = [
  { kind: "comment", pattern: /#[^\n]*/y },
  {
    kind: "string",
    pattern:
      /(?:[rbfu]{0,2})("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')/y,
  },
  { kind: "number", pattern: /\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?\b/y },
  { kind: "function", pattern: /\b[A-Za-z_][A-Za-z0-9_]*(?=\s*\()/y },
  { kind: "plain", pattern: /\b[A-Za-z_][A-Za-z0-9_]*\b/y },
];

const MAX_HIGHLIGHT_CHARS = 20_000;

export function tokenizePython(source: string): HighlightToken[] {
  // Very large excerpts fall back to a single plain token; highlighting them is
  // neither useful nor worth the main-thread cost.
  if (source.length > MAX_HIGHLIGHT_CHARS) {
    return [{ value: source, kind: "plain" }];
  }

  const tokens: HighlightToken[] = [];
  let index = 0;
  let pending = "";

  const flushPending = (): void => {
    if (pending) {
      tokens.push({ value: pending, kind: "plain" });
      pending = "";
    }
  };

  while (index < source.length) {
    let matched = false;
    for (const { kind, pattern } of PATTERNS) {
      pattern.lastIndex = index;
      const result = pattern.exec(source);
      if (!result || result.index !== index || result[0].length === 0) continue;

      const value = result[0];
      const resolved: TokenKind =
        kind === "plain" && PYTHON_KEYWORDS.has(value)
          ? "keyword"
          : kind === "function" && PYTHON_KEYWORDS.has(value)
            ? "keyword"
            : kind;

      if (resolved === "plain") {
        pending += value;
      } else {
        flushPending();
        tokens.push({ value, kind: resolved });
      }
      index += value.length;
      matched = true;
      break;
    }

    if (!matched) {
      pending += source[index];
      index += 1;
    }
  }

  flushPending();
  return tokens;
}
