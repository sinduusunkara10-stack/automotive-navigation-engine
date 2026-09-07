// Generic, language-agnostic line/marker parsing for an objective or success-criterion
// description that expresses explicit ordered instructions -- e.g. the real request shape
// this exists for: a single semantic_page_match successCriterion whose description is the
// caller's complete multiline ordered objective ("1. Select the item.\n2. Continue.\n3. Stop
// and return the resulting URL."), rather than one successCriterion per instruction. See
// src/core/instructionProgress.ts (evidence-based completion tracking) and
// src/reasoning/promptBuilder.ts's computeInstructionProgress (how the parsed segments are
// exposed to the reasoning layer) for how this is consumed. Nothing here infers steps from
// unstructured prose, invents a CTA dictionary, or assumes any brand/site-specific wording --
// it only recognises generic line structure that is already explicit in the caller's own
// text.

// Strips a leading numbering ("1.", "1)", "(1)") or bullet ("-", "*", "•") marker from an
// already-trimmed line, leaving plain instruction text. Never strips anything from the
// interior of a line -- only ever a marker at the very start.
const LEADING_MARKER = /^(?:\(\d+\)|\d+[.)]|[-*•])\s*/;

/**
 * Splits `text` into ordered instruction segments. Handles both CRLF and LF line endings,
 * blank lines (dropped), numbered ("1.", "1)", "(1)") and bulleted ("-", "*", "•") lines
 * (marker stripped), and plain line-separated text (no marker at all). Trims every segment.
 *
 * Returns an empty array whenever fewer than two meaningful segments result -- most notably
 * a single prose paragraph with no explicit line structure -- so a caller can fall back to
 * treating the whole text as one plain, unstructured objective/instruction exactly as before
 * this parser existed (see computeInstructionProgress's "single-objective" behaviour). Never
 * returns exactly one segment: that would be indistinguishable from "no structure found".
 */
export function parseOrderedInstructions(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const segments = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(LEADING_MARKER, "").trim())
    .filter((line) => line.length > 0);
  return segments.length >= 2 ? segments : [];
}
