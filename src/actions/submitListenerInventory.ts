import type { CDPSession, Page } from "playwright";
import { DEEP_QUERY_ALL_SOURCE } from "../observation/openShadowDom.js";
import { categoriseScript, PROBE_FORM_ATTR, PROBE_SUBMIT_ATTR, type ScriptCategory, type ScriptLibrary } from "./submitCancellationProbe.js";

/**
 * Which listeners could have cancelled the Submit, read through the Chrome DevTools Protocol after
 * the attempt is over: DOMDebugger.getEventListeners on the form, the Submit control, their
 * nearest ancestors, body, document and window, plus each jQuery handler's own function location
 * (jQuery attaches one dispatcher per element and type, so the native listener alone only says
 * "jQuery"). Only the event type, phase, flags, function name and the script's origin + path with
 * line and column are kept -- never a function body. Nothing is dispatched or called on the page
 * except reading jQuery's own event registry.
 */

export const LISTENER_TYPES = ["submit", "click", "mousedown", "mouseup", "pointerdown", "pointerup", "keydown", "focusout", "blur", "change", "input", "invalid"] as const;
const MAX_LISTENERS = 40;
const INVENTORY_TIMEOUT_MS = 5_000;
const OBJECT_GROUP = "navEngineListenerInventory";
/** The submit probe names its own listeners with this prefix so they are never reported as the page's. */
const ENGINE_LISTENER_PREFIX = "navEngineProbe";

export type ListenerTarget = "form" | "submit_control" | "form_ancestor" | "body" | "document" | "window";

export interface SubmitListenerRecord {
  target: ListenerTarget;
  type: string;
  phase: "capture" | "bubble";
  passive: boolean;
  once: boolean;
  layer: "native" | "jquery_direct" | "jquery_delegated";
  functionName: string;
  scriptPattern: string;
  scriptCategory: ScriptCategory;
  library: ScriptLibrary;
  line: number | null;
  column: number | null;
}

export interface SubmitListenerInventory {
  available: boolean;
  unavailableReason: string | null;
  listeners: SubmitListenerRecord[];
  omittedCount: number;
}

interface CdpEventListener {
  type: string;
  useCapture: boolean;
  passive: boolean;
  once: boolean;
  scriptId: string;
  lineNumber: number;
  columnNumber: number;
  handler?: { objectId?: string };
}

const DEEP_FORM = `(${DEEP_QUERY_ALL_SOURCE})(document, "form[${PROBE_FORM_ATTR}]")[0]`;
const TARGET_EXPRESSIONS: [ListenerTarget, string][] = [
  ["form", `(${DEEP_FORM} || null)`],
  ["submit_control", `((${DEEP_QUERY_ALL_SOURCE})(document, "[${PROBE_SUBMIT_ATTR}]")[0] || null)`],
  ["form_ancestor", `(() => { const f = ${DEEP_FORM}; return f && f.parentElement && f.parentElement !== document.body ? f.parentElement : null; })()`],
  ["form_ancestor", `(() => { const f = ${DEEP_FORM}; const a = f && f.parentElement; return a && a.parentElement && a.parentElement !== document.body && a !== document.body ? a.parentElement : null; })()`],
  ["form_ancestor", `(() => { const f = ${DEEP_FORM}; const r = f && f.getRootNode(); return r && r !== document ? r : null; })()`],
  ["body", "document.body"],
  ["document", "document"],
  ["window", "window"],
];

const JQUERY_HANDLERS_FN = `function (types) {
  const jq = window.jQuery;
  let ev = null;
  try {
    ev = jq && jq._data ? jq._data(this, "events") : null;
  } catch (e) {}
  const out = [];
  if (!ev) return out;
  for (const type of types) for (const h of ev[type] || []) if (typeof h.handler === "function") out.push(h.handler);
  return out;
}`;

const JQUERY_META_FN = `function (types) {
  const jq = window.jQuery;
  let ev = null;
  try {
    ev = jq && jq._data ? jq._data(this, "events") : null;
  } catch (e) {}
  const out = [];
  if (!ev) return out;
  for (const type of types) for (const h of ev[type] || []) if (typeof h.handler === "function") out.push({ type, delegated: Boolean(h.selector) });
  return out;
}`;

async function functionNameOf(session: CDPSession, objectId: string | undefined): Promise<string> {
  if (!objectId) return "unknown";
  const r = (await session
    .send("Runtime.callFunctionOn", { objectId, functionDeclaration: "function () { return typeof this.name === 'string' ? this.name : ''; }", returnByValue: true })
    .catch(() => null)) as { result?: { value?: unknown } } | null;
  const name = typeof r?.result?.value === "string" ? r.result.value : "";
  return name.replace(/[^\w$.<> ]/g, "").slice(0, 40) || "anonymous";
}

async function functionLocationOf(session: CDPSession, objectId: string): Promise<{ scriptId: string; lineNumber: number; columnNumber: number } | null> {
  const props = (await session.send("Runtime.getProperties", { objectId, ownProperties: true }).catch(() => null)) as {
    internalProperties?: { name: string; value?: { value?: { scriptId: string; lineNumber: number; columnNumber: number } } }[];
  } | null;
  return props?.internalProperties?.find((p) => p.name === "[[FunctionLocation]]")?.value?.value ?? null;
}

async function collect(page: Page, session: CDPSession, scripts: Map<string, string>): Promise<{ listeners: SubmitListenerRecord[]; omitted: number }> {
  const pageUrl = page.url();
  const out: SubmitListenerRecord[] = [];
  let omitted = 0;
  const push = (r: SubmitListenerRecord) => {
    if (out.length >= MAX_LISTENERS) omitted += 1;
    else out.push(r);
  };
  const types = new Set<string>(LISTENER_TYPES);
  for (const [target, expression] of TARGET_EXPRESSIONS) {
    const evaluated = (await session.send("Runtime.evaluate", { expression, objectGroup: OBJECT_GROUP }).catch(() => null)) as { result?: { objectId?: string; subtype?: string } } | null;
    const objectId = evaluated?.result?.objectId;
    if (!objectId || evaluated?.result?.subtype === "null") continue;
    const listed = (await session.send("DOMDebugger.getEventListeners", { objectId, depth: 0 }).catch(() => null)) as { listeners?: CdpEventListener[] } | null;
    let jqueryDispatcherSeen = false;
    for (const l of listed?.listeners ?? []) {
      if (!types.has(l.type)) continue;
      const functionName = await functionNameOf(session, l.handler?.objectId);
      if (functionName.startsWith(ENGINE_LISTENER_PREFIX)) continue;
      const script = categoriseScript(scripts.get(l.scriptId) ?? "", pageUrl);
      if (script.library === "jquery") jqueryDispatcherSeen = true;
      push({
        target,
        type: l.type,
        phase: l.useCapture ? "capture" : "bubble",
        passive: l.passive,
        once: l.once,
        layer: "native",
        functionName,
        ...script,
        line: l.lineNumber,
        column: l.columnNumber,
      });
    }
    if (!jqueryDispatcherSeen) continue;
    const meta = (await session
      .send("Runtime.callFunctionOn", { objectId, functionDeclaration: JQUERY_META_FN, arguments: [{ value: [...types] }], returnByValue: true })
      .catch(() => null)) as { result?: { value?: { type: string; delegated: boolean }[] } } | null;
    const fns = (await session
      .send("Runtime.callFunctionOn", { objectId, functionDeclaration: JQUERY_HANDLERS_FN, arguments: [{ value: [...types] }], objectGroup: OBJECT_GROUP })
      .catch(() => null)) as { result?: { objectId?: string } } | null;
    const entries = meta?.result?.value ?? [];
    if (!fns?.result?.objectId || entries.length === 0) continue;
    const items = (await session.send("Runtime.getProperties", { objectId: fns.result.objectId, ownProperties: true }).catch(() => null)) as {
      result?: { name: string; value?: { objectId?: string } }[];
    } | null;
    for (const item of items?.result ?? []) {
      const index = Number(item.name);
      if (!Number.isInteger(index) || !entries[index] || !item.value?.objectId) continue;
      const location = await functionLocationOf(session, item.value.objectId);
      const script = categoriseScript(location ? (scripts.get(location.scriptId) ?? "") : "", pageUrl);
      push({
        target,
        type: entries[index]!.type,
        phase: "bubble",
        passive: false,
        once: false,
        layer: entries[index]!.delegated ? "jquery_delegated" : "jquery_direct",
        functionName: await functionNameOf(session, item.value.objectId),
        ...script,
        line: location?.lineNumber ?? null,
        column: location?.columnNumber ?? null,
      });
    }
  }
  return { listeners: out, omitted };
}

export async function inventorySubmitListeners(page: Page): Promise<SubmitListenerInventory> {
  let session: CDPSession | null = null;
  try {
    session = await page.context().newCDPSession(page);
  } catch {
    return { available: false, unavailableReason: "the browser does not expose the DevTools protocol", listeners: [], omittedCount: 0 };
  }
  const s = session;
  const scripts = new Map<string, string>();
  s.on("Debugger.scriptParsed", (e: { scriptId: string; url: string }) => scripts.set(e.scriptId, e.url));
  let timer: NodeJS.Timeout | undefined;
  try {
    const work = (async () => {
      await s.send("Debugger.enable");
      const { listeners, omitted } = await collect(page, s, scripts);
      return { available: true, unavailableReason: null, listeners, omittedCount: omitted } satisfies SubmitListenerInventory;
    })().catch(
      // Settles even after the timeout below has won the race, so a late failure on the detached session is never an unhandled rejection.
      (): SubmitListenerInventory => ({ available: false, unavailableReason: "the DevTools protocol refused the listener query", listeners: [], omittedCount: 0 }),
    );
    const timeout = new Promise<SubmitListenerInventory>((resolve) => {
      timer = setTimeout(() => resolve({ available: false, unavailableReason: "the listener inventory did not finish in time", listeners: [], omittedCount: 0 }), INVENTORY_TIMEOUT_MS);
    });
    return await Promise.race([work, timeout]);
  } catch {
    return { available: false, unavailableReason: "the DevTools protocol refused the listener query", listeners: [], omittedCount: 0 };
  } finally {
    if (timer) clearTimeout(timer);
    await s.send("Runtime.releaseObjectGroup", { objectGroup: OBJECT_GROUP }).catch(() => {});
    await s.send("Debugger.disable").catch(() => {});
    await s.detach().catch(() => {});
  }
}
