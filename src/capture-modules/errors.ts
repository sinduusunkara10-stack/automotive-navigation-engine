import type { ConsoleMessage, Page, Request, Response } from "playwright";
import type { ActionType } from "../types/actions.js";
import type { Captures, ErrorCapture, ErrorCategory, ErrorSeverity } from "../types/task-response.js";

// Bumped from 500: the stale-target-recovery diagnostic (core/loop.ts) wraps the click
// executor's own already-detailed diagnostics string (actions/click.ts's
// formatClickDiagnostics) with a short recovery-progress prefix, and the combination can
// exceed 500 chars while still being exactly the bounded, non-sensitive text this cap
// exists to bound -- never raw HTML, cookies, or a stack trace.
const MAX_MESSAGE_LENGTH = 800;

// Deliberately built only from Error#message / ConsoleMessage#text() / short generated
// strings, never Error#stack, so diagnostics never carry Node/Playwright stack frames
// with local filesystem paths. Also never reads request/response headers or bodies.
function sanitizeMessage(message: string): string {
  const collapsed = message.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_MESSAGE_LENGTH ? `${collapsed.slice(0, MAX_MESSAGE_LENGTH)}…` : collapsed;
}

function safePageUrl(page: Page): string | undefined {
  try {
    return page.url();
  } catch {
    return undefined;
  }
}

export function recordDiagnosticError(
  captures: Captures,
  params: {
    stepIndex?: number;
    category: ErrorCategory;
    severity: ErrorSeverity;
    pageUrl?: string;
    actionType?: ActionType;
    targetElementId?: string;
    message: string;
    recoverable: boolean;
    stoppedRun: boolean;
  },
): void {
  const entry: ErrorCapture = {
    timestamp: new Date().toISOString(),
    ...(params.stepIndex !== undefined ? { stepIndex: params.stepIndex } : {}),
    category: params.category,
    severity: params.severity,
    ...(params.pageUrl ? { pageUrl: params.pageUrl } : {}),
    ...(params.actionType ? { actionType: params.actionType } : {}),
    ...(params.targetElementId ? { targetElementId: params.targetElementId } : {}),
    message: sanitizeMessage(params.message),
    recoverable: params.recoverable,
    stoppedRun: params.stoppedRun,
  };
  captures.errors = [...(captures.errors ?? []), entry];
}

/**
 * Classifies a failed (non-stop) action into a diagnostic category, without any
 * knowledge of the domain/site — only the action type, whether its target was
 * observed on the page, and the executor's own error text.
 */
export function classifyActionFailure(params: {
  actionType: ActionType;
  targetKnownMissing: boolean;
  errorMessage?: string;
}): ErrorCategory {
  if (params.actionType === "navigate") {
    return "navigation_failure";
  }
  if (params.actionType === "click" && params.targetKnownMissing) {
    return "target_element_missing";
  }
  if (params.errorMessage && /timeout/i.test(params.errorMessage)) {
    return "action_timeout";
  }
  return "action_execution_failure";
}

/**
 * Attached before the first navigation (see core/engine.ts) so page JS errors,
 * console errors, and failed network requests firing during initial page load are
 * not missed.
 */
export function attachErrorCapture(page: Page, captures: Captures, getStepIndex: () => number): () => void {
  const onPageError = (error: Error) => {
    recordDiagnosticError(captures, {
      stepIndex: getStepIndex(),
      category: "page_js_error",
      severity: "error",
      pageUrl: safePageUrl(page),
      message: error.message || String(error),
      recoverable: true,
      stoppedRun: false,
    });
  };

  const onConsole = (msg: ConsoleMessage) => {
    if (msg.type() !== "error") {
      return;
    }
    recordDiagnosticError(captures, {
      stepIndex: getStepIndex(),
      category: "console_error",
      severity: "warning",
      pageUrl: safePageUrl(page),
      message: msg.text(),
      recoverable: true,
      stoppedRun: false,
    });
  };

  const onRequestFailed = (request: Request) => {
    const failure = request.failure();
    recordDiagnosticError(captures, {
      stepIndex: getStepIndex(),
      category: "network_request_failed",
      severity: "warning",
      pageUrl: safePageUrl(page),
      message: `${request.method()} ${request.url()} failed${failure?.errorText ? `: ${failure.errorText}` : ""}`,
      recoverable: true,
      stoppedRun: false,
    });
  };

  const onResponse = (response: Response) => {
    if (response.status() < 400) {
      return;
    }
    recordDiagnosticError(captures, {
      stepIndex: getStepIndex(),
      category: "network_request_failed",
      severity: "warning",
      pageUrl: safePageUrl(page),
      message: `${response.request().method()} ${response.url()} returned HTTP ${response.status()}`,
      recoverable: true,
      stoppedRun: false,
    });
  };

  page.on("pageerror", onPageError);
  page.on("console", onConsole);
  page.on("requestfailed", onRequestFailed);
  page.on("response", onResponse);

  return () => {
    page.off("pageerror", onPageError);
    page.off("console", onConsole);
    page.off("requestfailed", onRequestFailed);
    page.off("response", onResponse);
  };
}
