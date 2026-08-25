export { analyzeHost, isSameRegistrableDomain } from "./registrableDomain.js";
export { assessUrlSafety, isSafeUrl } from "./hostSafety.js";
export type { HostRejectionReason, HostSafetyResult } from "./hostSafety.js";
export { objectiveRelevanceScore, rankByObjectiveRelevance } from "./relevance.js";
export { gatherPageSignals } from "./pageSignals.js";
export type { CandidateAnchor, AnchorEvidenceType, PageSignals } from "./pageSignals.js";
export { computeDomainDiscovery, runDomainDiscovery } from "./domainDiscovery.js";
export type {
  DomainDiscoveryInput,
  DomainDiscoveryResult,
  RunDomainDiscoveryParams,
  RunDomainDiscoveryOutcome,
  TrustedDomainEntry,
  ExternalCandidateEntry,
  RejectedCandidateEntry,
  TrustReason,
  CandidateEvidenceType,
} from "./domainDiscovery.js";
