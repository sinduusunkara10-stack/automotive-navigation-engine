// Same zod/v4 subpath as claudeDecisionSchema.ts/semanticVerificationSchema.ts -- required
// by @anthropic-ai/sdk's zodOutputFormat(), which relies on v4-only internals at runtime.
import { z } from "zod/v4";

/**
 * Structured output for the Tier-3 (genuinely ambiguous) surface-adoption call -- see
 * core/surfaceRelevance.ts's SurfaceRelevanceAmbiguityResolver and
 * claudeSurfaceRelevanceAmbiguityResolver.ts. Never a free-form response, never Playwright
 * code, a URL, or a selector: this call only classifies whether a candidate surface (already
 * scoped to a compact, sanitized evidence package -- see buildSurfaceRelevanceAmbiguityPrompt)
 * continues the current journey. `reason` and `evidenceUsed` are required so the model must
 * always ground a verdict in the evidence it was actually given, mirroring
 * SemanticVerificationPayload's own required, non-empty `evidence` field.
 */
export interface SurfaceRelevanceAmbiguityPayload {
  decision: "adopt" | "reject";
  matchedMilestoneIds: string[];
  confidence: number;
  reason: string;
  evidenceUsed: string[];
}

export function buildSurfaceRelevanceAmbiguitySchema(): z.ZodType<SurfaceRelevanceAmbiguityPayload> {
  return z
    .object({
      decision: z.enum(["adopt", "reject"]),
      matchedMilestoneIds: z.array(z.string()).max(20),
      confidence: z.number().min(0).max(1),
      reason: z.string().min(1).max(300),
      evidenceUsed: z.array(z.string().max(120)).max(10),
    })
    .strict();
}
