import type { FormFieldDescriptor } from "./fillPlan.js";

/**
 * The single optional Claude call Phase 1 allows per form (see CLAUDE.md "minimise Claude
 * API calls" requirement): invoked at most once, only for required fields the deterministic
 * mapper (fieldMapper.ts) could not classify. Never asked to produce arbitrary values --
 * only to pick, for each unmapped field, the closest fixed test-data value already available
 * (see testData.ts), or "skip" when none fits. A resolver is optional; when none is wired up
 * (e.g. no reasoning credentials configured), unmapped required fields are simply left
 * unfilled and surfaced as a validation-retry case.
 */
export interface UnmappedFieldResolution {
  fieldId: string;
  value: string;
}

export interface UnmappedFieldResolver {
  resolve(fields: FormFieldDescriptor[], context: { language: string; market: string }): Promise<UnmappedFieldResolution[]>;
}
