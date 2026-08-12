import { describe, expect, it } from "vitest";
import { tokenizePython } from "./highlight";

function rebuild(source: string): string {
  return tokenizePython(source)
    .map((token) => token.value)
    .join("");
}

function kindsOf(source: string, value: string): string[] {
  return tokenizePython(source)
    .filter((token) => token.value === value)
    .map((token) => token.kind);
}

describe("tokenizePython", () => {
  it("never loses or reorders source characters", () => {
    const samples = [
      "def validate(response):\n    return response.is_valid",
      "# comment only",
      "x = 'quoted # not a comment'",
      "",
      "   \n\t\n",
      'value = f"""multi\nline"""',
      "a+=1;b//=2  # trailing",
    ];
    for (const sample of samples) {
      expect(rebuild(sample)).toBe(sample);
    }
  });

  it("classifies keywords, calls, strings, comments, and numbers", () => {
    const source = "def run(x):  # note\n    return call(42, 'text')";
    expect(kindsOf(source, "def")).toEqual(["keyword"]);
    expect(kindsOf(source, "return")).toEqual(["keyword"]);
    expect(kindsOf(source, "run")).toEqual(["function"]);
    expect(kindsOf(source, "call")).toEqual(["function"]);
    expect(kindsOf(source, "42")).toEqual(["number"]);
    expect(kindsOf(source, "'text'")).toEqual(["string"]);
    expect(kindsOf(source, "# note")).toEqual(["comment"]);
  });

  it("keeps keyword-like words inert inside strings and comments", () => {
    const inString = tokenizePython("x = 'def class return'");
    expect(inString.some((token) => token.kind === "keyword")).toBe(false);

    const inComment = tokenizePython("# def class return");
    expect(inComment.every((token) => token.kind === "comment" || token.kind === "plain")).toBe(
      true,
    );
  });

  it("treats a keyword followed by a paren as a keyword, not a call", () => {
    expect(kindsOf("if (value):", "if")).toEqual(["keyword"]);
  });

  it("returns markup-bearing untrusted text as inert token values", () => {
    const hostile = "x = '<img src=x onerror=alert(1)>'";
    const tokens = tokenizePython(hostile);
    // Values stay verbatim strings; rendering is React's job, so nothing is executable.
    expect(rebuild(hostile)).toBe(hostile);
    expect(tokens.every((token) => typeof token.value === "string")).toBe(true);
  });

  it("falls back to a single plain token for oversized excerpts", () => {
    const huge = "a".repeat(20_001);
    expect(tokenizePython(huge)).toEqual([{ value: huge, kind: "plain" }]);
  });
});
