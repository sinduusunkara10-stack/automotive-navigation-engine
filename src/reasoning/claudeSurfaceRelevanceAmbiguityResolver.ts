import type { ClaudeReasoningConfig } from "./config.js";
import { createAnthropicReasoningModelClient } from "./anthropicReasoningModelClient.js";
import type { ReasoningModelClient } from "./reasoningModelClient.js";
import { buildSurfaceRelevanceAmbiguitySchema, type SurfaceRelevanceAmbiguityPayload } from "./surfaceRelevanceAmbiguitySchema.js";
import type {
  SurfaceRelevanceAmbiguityContext,
  SurfaceRelevanceAmbiguityResolution,
  SurfaceRelevanceAmbiguityResolver,
} from "../core/surfaceRelevance.js";

/**
 * Three-tier surface-adoption corrective work (Tier 3, see core/surfaceRelevance.ts's own
 * doc comment): the real, Claude-backed SurfaceRelevanceAmbiguityResolver, called only for
 * the genuinely ambiguous middle band -- a strongly relevant or clearly irrelevant candidate
 * never reaches this class at all (see assessSurfaceRelevance's own tier gating). Reuses the
 * exact same SDK-agnostic ReasoningModelClient boundary, structured-output pattern, and
 * single-retry policy as ClaudeSemanticCriterionVerifier/ClaudeReasoningProvider (same auth,
 * same model config, no new external dependency, no separate provider architecture) -- see
 * reasoning/semanticCriterionVerifier.ts. This is guidance only: resolveAmbiguousSurfaceRelevance
 * (core/surfaceRelevance.ts) independently verifies every resolution before trusting it (a
 * confidence floor, plus a check that the rationale actually cites evidence this resolver was
 * given), and the caller (capture-modules/popupCapture.ts) never lets this override domain
 * policy, safety, personal-data, form-submission, or payment/purchase restrictions -- none of
 * those are even visible to this class. It also never marks a milestone satisfied or the
 * journey successful on its own: `matchedMilestoneIds` is advisory context for diagnostics/the
 * caller's own milestone-verification path, never a substitute for it.
 *
 * Fails by throwing (never resolves a low-confidence/fabricated verdict) on any malformed
 * output, provider error, or timeout -- resolveAmbiguousSurfaceRelevance's own try/catch
 * around resolver.resolve() already treats a thrown error as "no resolution", failing the
 * candidate closed exactly like an absent resolver would.
 */
export interface ClaudeSurfaceRelevanceAmbiguityResolverOptions {
  config: ClaudeReasoningConfig;
  modelClient?: ReasoningModelClient;
  minConfidence?: number;
}

// Mirrors ClaudeSemanticCriterionVerifier's own DEFAULT_SEMANTIC_MIN_CONFIDENCE: a surface
// adoption decision, like a required success criterion, must never turn on a low-confidence
// guess -- resolveAmbiguousSurfaceRelevance's own MIN_RELEVANCE_AMBIGUITY_CONFIDENCE (0.7)
// re-checks this independently regardless of what this class returns, so this floor is a
// defense-in-depth match, not the only gate.
const DEFAULT_MIN_CONFIDENCE = 0.7;

function buildPrompt(context: SurfaceRelevanceAmbiguityContext): { system: string; user: string } {
  const system =
    "You decide whether a just-opened browser tab/popup ('the candidate surface') genuinely " +
    "continues the user's current journey, or is unrelated (e.g. advertising, unrelated " +
    "marketing, a privacy/legal page, unrelated help/support, or simply the wrong page). The " +
    "objective and the candidate's own text may be written in different languages -- compare " +
    "real-world MEANING, not literal words. Base your answer only on the evidence given here " +
    "-- never assume or invent content that isn't present, and never rely on hostname/URL " +
    "similarity alone (a shared domain proves nothing about page content). Analytics-like " +
    "concepts, when present, may SUPPORT a decision but must never be sufficient on their own. " +
    "You are choosing whether to ADOPT this surface as the engine's next active page, not " +
    "whether any milestone is complete -- 'matchedMilestoneIds' just names which of the given " +
    "milestone ids this surface's own visible content plausibly relates to, for diagnostics; " +
    "it never itself satisfies a milestone. This decision cannot override domain/safety policy " +
    "-- that has already been checked separately and is not your concern. Never output an " +
    "action, URL, selector, or code. Give an honest confidence for how sure you are, and " +
    "always cite the specific given evidence (in evidenceUsed) that supports your decision, " +
    "even when you decide 'reject'.";

  const payload = {
    objective: context.objectiveText,
    ...(context.journeyType ? { journeyType: context.journeyType } : {}),
    ...(context.unfinishedMilestones && context.unfinishedMilestones.length > 0
      ? { unfinishedMilestones: context.unfinishedMilestones }
      : {}),
    ...(context.completedMilestones && context.completedMilestones.length > 0
      ? { completedMilestones: context.completedMilestones }
      : {}),
    ...(context.triggeringCtaAccessibleName ? { triggeringCta: context.triggeringCtaAccessibleName } : {}),
    ...(context.domainPolicyApproved !== undefined ? { domainPolicyApproved: context.domainPolicyApproved } : {}),
    candidateSurface: {
      title: context.title,
      headings: context.headings,
      interactiveElementText: context.interactiveText,
    },
    deterministicScore: context.deterministicScore,
  };

  return { system, user: JSON.stringify(payload) };
}

export class ClaudeSurfaceRelevanceAmbiguityResolver implements SurfaceRelevanceAmbiguityResolver {
  private readonly config: ClaudeReasoningConfig;
  private readonly modelClient: ReasoningModelClient;
  private readonly minConfidence: number;

  constructor(options: ClaudeSurfaceRelevanceAmbiguityResolverOptions) {
    this.config = options.config;
    this.modelClient = options.modelClient ?? createAnthropicReasoningModelClient(options.config);
    this.minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  }

  async resolve(context: SurfaceRelevanceAmbiguityContext): Promise<SurfaceRelevanceAmbiguityResolution> {
    const schema = buildSurfaceRelevanceAmbiguitySchema();
    const prompt = buildPrompt(context);
    const attempts = 1 + this.config.maxRetries;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const result = await this.modelClient.createDecision<SurfaceRelevanceAmbiguityPayload>({
        model: this.config.model,
        maxOutputTokens: this.config.maxOutputTokens,
        timeoutMs: this.config.timeoutMs,
        system: prompt.system,
        userPrompt: prompt.user,
        outputSchema: schema,
      });

      if (result.parsedOutput) {
        const payload = result.parsedOutput;
        return {
          relevant: payload.decision === "adopt" && payload.confidence >= this.minConfidence,
          rationale: payload.reason,
          confidence: payload.confidence,
        };
      }
    }

    throw new Error("surface_relevance_ambiguity_resolution_failed");
  }
}
