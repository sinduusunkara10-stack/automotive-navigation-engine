// Imported from the "zod/v4" subpath (not the package's default v3 export) because
// @anthropic-ai/sdk's zodOutputFormat() is typed against zod/v4's ZodType — passing a
// v3-built schema there does not type-check (and zodOutputFormat relies on v4-only
// internals, e.g. z.toJSONSchema, at runtime).
import { z } from "zod/v4";
import type { ActionType } from "../types/actions.js";
import { CONSENT_CONTROL_INTENTS, type ConsentControlIntent } from "../types/consentControl.js";

/**
 * The exactly-one-decision structured output Claude must return. `targetElementId` is
 * only meaningful for `click` (an id from the observation's interactiveElements);
 * `navigateUrl` is only meaningful for `navigate` (validated against allowedDomains
 * before use) — these are kept as distinct, narrowly-typed fields rather than a single
 * free-form `target` string so Claude can never smuggle a selector, script, or shell
 * command through either one. `params` is similarly narrow: only the numeric knobs the
 * existing scroll/wait executors already accept.
 *
 * `consentControlIntent` is required on every decision (see types/consentControl.ts): a
 * self-reported, generic semantic classification of the chosen action, always
 * "not_consent_related" unless the action's target is itself a consent/tracking-preference
 * control. Forcing this on every decision (not just clicks the model already recognises as
 * consent-related) is what lets validateClaudeDecision.ts deterministically enforce
 * ConsentInteractionPolicy without the engine ever having to recognise a specific control
 * itself.
 */
export interface ClaudeDecisionPayload {
  action: ActionType;
  targetElementId?: string;
  navigateUrl?: string;
  reason: string;
  confidence: number;
  consentControlIntent: ConsentControlIntent;
  params?: {
    deltaY?: number;
    durationMs?: number;
  };
}

export function buildClaudeDecisionSchema(allowedActions: readonly ActionType[]): z.ZodType<ClaudeDecisionPayload> {
  const [first, ...rest] = allowedActions;
  if (!first) {
    throw new Error("buildClaudeDecisionSchema requires at least one allowed action");
  }
  const actionEnum = z.enum([first, ...rest] as [ActionType, ...ActionType[]]);

  return z
    .object({
      action: actionEnum,
      targetElementId: z.string().min(1).max(200).optional(),
      navigateUrl: z.string().min(1).max(2000).optional(),
      reason: z.string().min(1).max(400),
      confidence: z.number().min(0).max(1),
      consentControlIntent: z.enum(CONSENT_CONTROL_INTENTS),
      params: z
        .object({
          deltaY: z.number().min(-5000).max(5000).optional(),
          durationMs: z.number().min(0).max(5000).optional(),
        })
        .strict()
        .optional(),
    })
    .strict();
}
