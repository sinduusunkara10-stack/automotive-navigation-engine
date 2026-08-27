// Same zod/v4 subpath as claudeDecisionSchema.ts -- required by @anthropic-ai/sdk's
// zodOutputFormat(), which relies on v4-only internals at runtime.
import { z } from "zod/v4";

/**
 * Structured output for SemanticCriterionVerifier: a narrowly-scoped, language-agnostic
 * judgement of whether the given page evidence describes having reached the state
 * described by the objective/criterion text -- never a free-form response, never
 * Playwright code, never a URL or selector. `evidence` is required (min length 1) for
 * both a satisfied and an unsatisfied verdict, so the model must always ground its
 * answer in the given text rather than asserting a bare boolean (see task requirement:
 * "prevent a single unsupported assertion from satisfying the criterion").
 */
export interface SemanticVerificationPayload {
  satisfied: boolean;
  confidence: number;
  evidence: string;
}

export function buildSemanticVerificationSchema(): z.ZodType<SemanticVerificationPayload> {
  return z
    .object({
      satisfied: z.boolean(),
      confidence: z.number().min(0).max(1),
      evidence: z.string().min(1).max(300),
    })
    .strict();
}
