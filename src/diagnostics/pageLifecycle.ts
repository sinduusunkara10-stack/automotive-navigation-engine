import type { BrowserContext, Page } from "playwright";
import type {
  ActionTraceRecord,
  OpenPageSummary,
  PageLifecycleEvent,
  PageStateSnapshot,
} from "../types/failureDiagnostics.js";
import { appendBoundedPreservingEnds } from "../core/boundedArray.js";

export const MAX_PAGE_LIFECYCLE_EVENTS = 100;
export const MAX_ACTION_TRACE_RECORDS = 50;
const KEEP_FIRST_EVENTS = 20;
const KEEP_FIRST_TRACE_RECORDS = 10;
const MAX_OPEN_PAGES_LISTED = 10;

// Module-level and keyed by the Page object itself, so the engine's own close sites need no
// access to RunState: a close listener reads this to tell "the engine closed it" apart from
// "the site, Chromium or anything else closed it".
const engineCloseReasons = new WeakMap<object, string>();

/** Call immediately before the engine itself closes a Page, so its close event is recorded as closedBy "engine". */
export function markEngineClose(page: object, reason: string): void {
  engineCloseReasons.set(page, reason);
}

function safeUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return "";
  }
}

/**
 * Diagnostics-only, bounded record of every Page/context/browser lifecycle event and every
 * surface stack change during one run. Purely observational: it only adds Playwright event
 * listeners and never calls anything that could change page state. Read only when a run
 * throws (see core/engine.ts) -- never written into a successful TaskResponse.
 */
export class PageLifecycleLog {
  private events: PageLifecycleEvent[] = [];
  private trace: ActionTraceRecord[] = [];
  private readonly ids = new WeakMap<object, string>();
  private readonly trackedPages = new WeakSet<object>();
  private counter = 0;
  private mainPage: Page | undefined;

  pageId(page: object): string {
    let id = this.ids.get(page);
    if (!id) {
      this.counter += 1;
      id = `page-${this.counter}`;
      this.ids.set(page, id);
    }
    return id;
  }

  record(event: Omit<PageLifecycleEvent, "at">): void {
    this.events = appendBoundedPreservingEnds(
      this.events,
      { at: new Date().toISOString(), ...event },
      MAX_PAGE_LIFECYCLE_EVENTS,
      KEEP_FIRST_EVENTS,
    );
  }

  recordAction(record: ActionTraceRecord): void {
    this.trace = appendBoundedPreservingEnds(this.trace, record, MAX_ACTION_TRACE_RECORDS, KEEP_FIRST_TRACE_RECORDS);
  }

  getEvents(): PageLifecycleEvent[] {
    return [...this.events];
  }

  getActionTrace(): ActionTraceRecord[] {
    return [...this.trace];
  }

  private trackPage(page: Page): () => void {
    if (this.trackedPages.has(page)) {
      return () => {};
    }
    this.trackedPages.add(page);
    const onClose = () => {
      const reason = engineCloseReasons.get(page);
      this.record({
        kind: "page_closed",
        pageId: this.pageId(page),
        url: safeUrl(page),
        closedBy: reason ? "engine" : "external",
        ...(reason ? { closeReason: reason } : {}),
      });
    };
    const onCrash = () => {
      this.record({ kind: "page_crashed", pageId: this.pageId(page), url: safeUrl(page), closedBy: "external" });
    };
    page.on("close", onClose);
    page.on("crash", onCrash);
    return () => {
      page.off("close", onClose);
      page.off("crash", onCrash);
    };
  }

  /**
   * Starts observing the run's originally tracked page, every page later created in its
   * browser context (popups/new tabs included), the context itself and its browser. Returns
   * a detach function that removes every listener this added.
   */
  attach(mainPage: Page): () => void {
    this.mainPage = mainPage;
    this.pageId(mainPage);
    const detachers: (() => void)[] = [this.trackPage(mainPage)];

    let context: BrowserContext | undefined;
    try {
      context = mainPage.context();
    } catch {
      context = undefined;
    }
    if (context) {
      const ctx = context;
      const onPage = (newPage: Page) => {
        const event: PageLifecycleEvent = {
          at: new Date().toISOString(),
          kind: "page_created",
          pageId: this.pageId(newPage),
          url: safeUrl(newPage),
        };
        this.events = appendBoundedPreservingEnds(this.events, event, MAX_PAGE_LIFECYCLE_EVENTS, KEEP_FIRST_EVENTS);
        detachers.push(this.trackPage(newPage));
        void newPage
          .opener()
          .then((opener) => {
            if (opener) {
              event.openerPageId = this.pageId(opener);
            }
          })
          .catch(() => {});
      };
      const onContextClose = () => {
        this.record({ kind: "context_closed", closedBy: "external" });
      };
      ctx.on("page", onPage);
      ctx.on("close", onContextClose);
      detachers.push(() => {
        ctx.off("page", onPage);
        ctx.off("close", onContextClose);
      });

      const browser = ctx.browser();
      if (browser) {
        const onDisconnected = () => {
          this.record({ kind: "browser_disconnected", closedBy: "external" });
        };
        browser.on("disconnected", onDisconnected);
        detachers.push(() => browser.off("disconnected", onDisconnected));
      }
    }

    return () => {
      for (const detach of detachers) {
        detach();
      }
    };
  }

  /** Text-only snapshot of which surface/Page is active and which Pages are open right now. */
  snapshot(params: { activeSurface: string; activePage: Page | undefined }): PageStateSnapshot {
    const active = params.activePage ?? this.mainPage;
    let openPages: OpenPageSummary[] = [];
    try {
      const pages = active ? active.context().pages() : [];
      openPages = pages.slice(0, MAX_OPEN_PAGES_LISTED).map((p) => ({ id: this.pageId(p), url: safeUrl(p) }));
    } catch {
      openPages = [];
    }
    return {
      at: new Date().toISOString(),
      activeSurface: params.activeSurface,
      activePageId: active ? this.pageId(active) : "",
      activePageUrl: active ? safeUrl(active) : "",
      activePageClosed: active ? active.isClosed() : true,
      openPages,
    };
  }
}
