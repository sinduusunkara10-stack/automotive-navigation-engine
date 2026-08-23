import type {
  ReasoningModelClient,
  ReasoningModelRequest,
  ReasoningModelResult,
} from "../../../src/reasoning/reasoningModelClient.js";
import { ReasoningModelError } from "../../../src/reasoning/reasoningModelClient.js";

export type FakeReasoningModelStep<TPayload = unknown> =
  | { kind: "result"; result: ReasoningModelResult<TPayload> }
  | { kind: "error"; error: ReasoningModelError };

/**
 * Deterministic, in-memory stand-in for the real Anthropic-backed model client (see
 * task requirement #16). Never touches the network or an API key — each call to
 * createDecision() pops the next scripted step and returns/throws it, recording every
 * request it was asked to make so tests can assert on prompt content.
 */
export class FakeReasoningModelClient implements ReasoningModelClient {
  readonly requests: ReasoningModelRequest<unknown>[] = [];
  private readonly steps: FakeReasoningModelStep[];
  private cursor = 0;

  constructor(steps: FakeReasoningModelStep[]) {
    this.steps = steps;
  }

  async createDecision<TPayload>(request: ReasoningModelRequest<TPayload>): Promise<ReasoningModelResult<TPayload>> {
    this.requests.push(request as ReasoningModelRequest<unknown>);
    const step = this.steps[this.cursor];
    this.cursor += 1;
    if (!step) {
      throw new Error("FakeReasoningModelClient: no more scripted steps");
    }
    if (step.kind === "error") {
      throw step.error;
    }
    return step.result as ReasoningModelResult<TPayload>;
  }
}

export function resultStep<TPayload>(
  parsedOutput: TPayload | null,
  overrides: Partial<Omit<ReasoningModelResult<TPayload>, "parsedOutput">> = {},
): FakeReasoningModelStep<TPayload> {
  return {
    kind: "result",
    result: {
      parsedOutput,
      stopReason: overrides.stopReason ?? (parsedOutput ? "end_turn" : "max_tokens"),
      usage: overrides.usage ?? { inputTokens: 100, outputTokens: 20 },
    },
  };
}

export function errorStep(category: string): FakeReasoningModelStep {
  return { kind: "error", error: new ReasoningModelError(category) };
}
