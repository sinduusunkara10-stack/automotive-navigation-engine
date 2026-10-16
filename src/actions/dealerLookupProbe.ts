import type { ElementHandle, Frame, Locator } from "playwright";

/**
 * In-page instrumentation for one dealer-lookup resolution, installed into the form's own frame.
 * Authored as a plain source string (evaluated through Playwright, which is not subject to the
 * page's CSP) rather than as a TypeScript callback: it needs several helper functions, and
 * tsx/esbuild wraps any named nested binding in a `__name(...)` call that does not exist once
 * Playwright serialises a callback into the browser.
 *
 * Everything it reports back is a boolean, a count, a length, or an enumerated purpose label --
 * never a field value, a hidden-input value, a result's text, or any other page text.
 *
 * Responsibilities:
 *  - a bounded MutationObserver record (added subtrees and visibility/ARIA attribute changes), so
 *    result discovery does not depend only on "a new element was inserted inside the widget";
 *  - an implicit-submission guard for the lead form (submit events, and clicks on the form's own
 *    submit-capable controls other than the one control the engine is deliberately clicking) --
 *    Enter in a text field, a type-less <button> trigger, or a <button> result can otherwise
 *    submit the whole lead form;
 *  - a geolocation-request counter, so a textless "locate me" control is identified from what it
 *    actually does rather than guessed from its icon;
 *  - keyed (not positional) hidden-input state, so an inserted hidden input never invalidates the
 *    empty-to-populated comparison of every other hidden input;
 *  - page-wide, field-anchored result discovery: ARIA-linked containers, portals, hidden containers
 *    becoming visible, and plain div/span/li items, gated by proximity to the field or an ARIA link.
 */
const DEALER_PROBE_SOURCE = String.raw`(() => {
  const w = window;
  if (w.__navEngineDealerProbe && w.__navEngineDealerProbe.version === 2) return true;
  const ITEM_SELECTOR = 'li, a, button, [role="option"], [role="radio"], input[type="radio"], [role="button"], [role="link"], [role="menuitem"], [onclick], [tabindex], [data-value]';
  const AUTH_SELECTOR = '[role="radio"], input[type="radio"], [role="option"]';
  const ACTIVATED_ATTR = 'data-nav-engine-dealer-already-activated';
  const BASE_ATTR = 'data-nav-engine-dealer-probe-baseline';
  const HIDDEN_KEY_ATTR = 'data-nav-engine-hidden-key';
  const CLEAR_WORDS = ['clear', 'close', 'reset', 'remove', 'delete', 'cancel', 'effacer', 'fermer', 'supprimer', 'annuler', 'loschen', 'schliessen', 'zurucksetzen', 'wissen', 'sluiten', 'cancella', 'chiudi', 'borrar', 'cerrar', 'limpar', 'fechar', 'wyczysc', 'zamknij', 'usun'];
  const NO_RESULT_WORDS = ['no result', 'no match', 'not found', 'no dealer', 'nothing found', 'aucun', 'aucune', 'pas de resultat', 'introuvable', 'keine ergebnisse', 'kein ergebnis', 'nicht gefunden', 'geen resultaten', 'niet gevonden', 'nessun', 'nessuna', 'non trovato', 'ningun', 'sin resultados', 'no se encontr', 'brak wynikow', 'nie znaleziono', 'nenhum', 'sem resultados'];
  const HIDDEN_UNRELATED = ['token', 'csrf', 'xsrf', 'nonce', 'captcha', 'recaptcha', 'utm', 'gclid', 'fbclid', 'msclkid', 'session', 'timestamp', 'honeypot', 'referrer', 'referer', 'tracking', 'analytics', 'fingerprint', 'consent'];
  const HIDDEN_DEALER = ['dealer', 'retailer', 'store', 'shop', 'outlet', 'pdv', 'pos', 'concession', 'haendler', 'handler', 'distributor', 'garage', 'showroom', 'site', 'agent', 'partner'];
  const HIDDEN_LOCATION = ['location', 'city', 'town', 'zip', 'postcode', 'postal', 'plz', 'cp', 'lat', 'lng', 'lon', 'latitude', 'longitude', 'geo', 'place', 'commune', 'ville', 'locality', 'insee', 'ort'];
  const SHORT_TOKEN = 4;

  function norm(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }
  function tokensOf(s) {
    return String(s || '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  }
  function tokenMatch(tokens, words) {
    for (const t of tokens) {
      for (const word of words) {
        if (word.length < SHORT_TOKEN ? t === word : t.indexOf(word) !== -1) return true;
      }
    }
    return false;
  }
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) !== 0;
  }
  function comboOf(field) {
    return field.closest('[role="combobox"]') || field;
  }
  function hiddenPurpose(el) {
    const tokens = tokensOf((el.getAttribute('name') || '') + ' ' + (el.getAttribute('id') || ''));
    if (tokenMatch(tokens, HIDDEN_UNRELATED)) return 'unrelated';
    if (tokenMatch(tokens, HIDDEN_DEALER)) return 'dealer_identifier';
    if (tokenMatch(tokens, HIDDEN_LOCATION)) return 'location_identifier';
    return 'unclassified';
  }
  function isNavigationalAnchor(el) {
    const a = el.closest('a[href]');
    if (!a) return false;
    const href = (a.getAttribute('href') || '').trim();
    if (href === '' || href.charAt(0) === '#' || href.toLowerCase().indexOf('javascript:') === 0) return false;
    try {
      const u = new URL(href, location.href);
      return u.pathname !== location.pathname || u.origin !== location.origin;
    } catch (e) {
      return true;
    }
  }

  const probe = {
    version: 2,
    seq: 0,
    hiddenSeq: 0,
    mutationCount: 0,
    records: [],
    geo: 0,
    blockedSubmitEvents: 0,
    blockedSubmitClicks: 0,
    observer: null,
    form: null,
    allowed: null,
    onSubmit: null,
    onClick: null,
    geoOriginal: null,
    push(el, added) {
      this.records.push({ el: el, added: added, seq: this.seq });
      if (this.records.length > 400) this.records.shift();
    },
    start(form) {
      this.stop();
      this.form = form;
      this.mutationCount = 0;
      this.records = [];
      this.seq = 0;
      this.geo = 0;
      this.blockedSubmitEvents = 0;
      this.blockedSubmitClicks = 0;
      const self = this;
      this.observer = new MutationObserver(function (list) {
        for (const m of list) {
          self.mutationCount += 1;
          self.seq += 1;
          if (m.type === 'childList') {
            m.addedNodes.forEach(function (n) { if (n.nodeType === 1) self.push(n, true); });
          } else if (m.target && m.target.nodeType === 1) {
            self.push(m.target, false);
          }
        }
      });
      this.observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'aria-hidden', 'aria-expanded', 'open'] });
      if (navigator.geolocation && !this.geoOriginal) {
        const g = navigator.geolocation;
        this.geoOriginal = { get: g.getCurrentPosition, watch: g.watchPosition };
        try {
          g.getCurrentPosition = function () { self.geo += 1; return self.geoOriginal.get.apply(g, arguments); };
          g.watchPosition = function () { self.geo += 1; return self.geoOriginal.watch.apply(g, arguments); };
        } catch (e) {}
      }
      this.onSubmit = function (e) {
        if (e.target === self.form) {
          e.preventDefault();
          e.stopImmediatePropagation();
          self.blockedSubmitEvents += 1;
        }
      };
      this.onClick = function (e) {
        const t = e.target;
        if (!(t instanceof Element)) return;
        const ctl = t.closest('button, input[type="submit"], input[type="image"]');
        if (!ctl || ctl.form !== self.form) return;
        if (ctl.tagName === 'BUTTON' && (ctl.getAttribute('type') || 'submit').toLowerCase() !== 'submit') return;
        if (self.allowed && (self.allowed === ctl || self.allowed.contains(ctl) || ctl.contains(self.allowed))) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        self.blockedSubmitClicks += 1;
      };
      window.addEventListener('submit', this.onSubmit, true);
      window.addEventListener('click', this.onClick, true);
      return true;
    },
    stop() {
      if (this.observer) this.observer.disconnect();
      this.observer = null;
      if (this.onSubmit) window.removeEventListener('submit', this.onSubmit, true);
      if (this.onClick) window.removeEventListener('click', this.onClick, true);
      this.onSubmit = null;
      this.onClick = null;
      this.allowed = null;
      if (this.geoOriginal && navigator.geolocation) {
        try {
          delete navigator.geolocation.getCurrentPosition;
          delete navigator.geolocation.watchPosition;
        } catch (e) {}
      }
      this.geoOriginal = null;
      return true;
    },
    allow(el) {
      this.allowed = el || null;
      return true;
    },
    markStage() {
      document.querySelectorAll(ITEM_SELECTOR).forEach(function (el) {
        if (isVisible(el)) el.setAttribute(BASE_ATTR, '1');
      });
      return this.seq;
    },
    hiddenState(form) {
      const self = this;
      return Array.from(form.querySelectorAll('input[type="hidden"]')).map(function (el) {
        let key = el.getAttribute(HIDDEN_KEY_ATTR);
        if (!key) {
          key = 'h' + self.hiddenSeq;
          self.hiddenSeq += 1;
          el.setAttribute(HIDDEN_KEY_ATTR, key);
        }
        return { key: key, nonEmpty: String(el.value || '').trim().length > 0, purpose: hiddenPurpose(el) };
      });
    },
    snapshot(field, scope, typed) {
      const combo = comboOf(field);
      const expandedAttr = combo.getAttribute('aria-expanded') || field.getAttribute('aria-expanded');
      const adId = field.getAttribute('aria-activedescendant') || combo.getAttribute('aria-activedescendant');
      const value = String(field.value || '');
      const surfaces = Array.from(document.querySelectorAll('[role="alert"], [role="status"], [aria-live="assertive"], [aria-live="polite"]')).filter(isVisible);
      let surfaceTextLength = 0;
      let noResults = false;
      surfaces.forEach(function (s) {
        const text = norm(s.textContent).trim();
        surfaceTextLength += text.length;
        if (NO_RESULT_WORDS.some(function (word) { return text.indexOf(word) !== -1; })) noResults = true;
      });
      const scopeText = norm(scope ? scope.textContent : '').trim();
      if (NO_RESULT_WORDS.some(function (word) { return scopeText.indexOf(word) !== -1; })) noResults = true;
      const busy = combo.getAttribute('aria-busy') === 'true' || field.getAttribute('aria-busy') === 'true' || Boolean(scope && Array.from(scope.querySelectorAll('[aria-busy="true"], [role="progressbar"]')).some(isVisible));
      return {
        fieldValueRetained: typed === null ? null : norm(value).replace(/\s+/g, '') === norm(typed).replace(/\s+/g, ''),
        fieldNonEmpty: value.trim().length > 0,
        focusInField: document.activeElement === field,
        fieldAriaExpanded: expandedAttr === null ? null : expandedAttr === 'true',
        fieldActiveDescendantPresent: Boolean(adId && document.getElementById(adId)),
        scopeTextLength: scopeText.length,
        surfaceCount: surfaces.length,
        surfaceTextLength: surfaceTextLength,
        noResultsMessageObserved: noResults,
        busy: busy,
        mutationCount: this.mutationCount,
        geolocationRequests: this.geo,
        blockedSubmitEvents: this.blockedSubmitEvents,
        blockedSubmitClicks: this.blockedSubmitClicks,
        fieldAriaInvalid: field.getAttribute('aria-invalid') === 'true',
        fieldHasNativeValidationMessage: String(field.validationMessage || '').length > 0,
      };
    },
    findResult(field, sinceSeq) {
      const fieldRect = field.getBoundingClientRect();
      const combo = comboOf(field);
      const linkedRoots = [];
      [field, combo].forEach(function (el) {
        ['aria-controls', 'aria-owns'].forEach(function (attr) {
          String(el.getAttribute(attr) || '').split(/\s+/).filter(Boolean).forEach(function (id) {
            const target = document.getElementById(id);
            if (target) linkedRoots.push(target);
          });
        });
        const adId = el.getAttribute('aria-activedescendant');
        const active = adId ? document.getElementById(adId) : null;
        if (active) linkedRoots.push(active.closest('[role="listbox"]') || active.parentElement || active);
      });
      const roots = [];
      const seen = new Set();
      linkedRoots.forEach(function (r) { if (r && !seen.has(r)) { seen.add(r); roots.push({ el: r, linked: true, added: true }); } });
      this.records.forEach(function (rec) {
        if (rec.seq <= sinceSeq || seen.has(rec.el)) return;
        seen.add(rec.el);
        roots.push({ el: rec.el, linked: false, added: rec.added });
      });
      function near(el) {
        const r = el.getBoundingClientRect();
        const dy = r.top > fieldRect.bottom ? r.top - fieldRect.bottom : fieldRect.top > r.bottom ? fieldRect.top - r.bottom : 0;
        const dx = r.left > fieldRect.right ? r.left - fieldRect.right : fieldRect.left > r.right ? fieldRect.left - r.right : 0;
        return dy <= 450 && dx <= 450;
      }
      const candidates = [];
      const considered = new Set();
      for (const root of roots) {
        const el = root.el;
        if (!el.isConnected || el === field || el.contains(field)) continue;
        if (el.closest('[role="alert"], [role="status"]')) continue;
        const items = [el].concat(Array.from(el.querySelectorAll(ITEM_SELECTOR + ', div, span')).slice(0, 200));
        for (const item of items) {
          if (considered.has(item)) continue;
          considered.add(item);
          if (item.hasAttribute(ACTIVATED_ATTR) || item.hasAttribute(BASE_ATTR)) continue;
          if (item.matches('input, select, textarea') && !item.matches('input[type="radio"]')) continue;
          if (item.querySelector('input:not([type="radio"]):not([type="hidden"]), select, textarea')) continue;
          if (!isVisible(item)) continue;
          const authoritative = item.matches(AUTH_SELECTOR);
          const semanticClickable = item.matches(ITEM_SELECTOR);
          const plain = !semanticClickable;
          if (plain && !(root.added || root.linked)) continue;
          if (plain && getComputedStyle(item).cursor !== 'pointer') continue;
          if (isNavigationalAnchor(item)) continue;
          if (item.closest('[role="alert"], [role="status"]')) continue;
          const text = norm(item.getAttribute('aria-label') || item.textContent).trim();
          if (!authoritative && text.length === 0) continue;
          if (!authoritative && (text.length <= 1 || CLEAR_WORDS.some(function (word) { return text === word || text.indexOf(word + ' ') === 0; }))) continue;
          if (!root.linked && !near(item)) continue;
          const parent = item.parentElement;
          const repeated = Boolean(parent && Array.from(parent.children).filter(function (c) { return c.tagName === item.tagName; }).length >= 2);
          candidates.push({ item: item, authoritative: authoritative, repeated: repeated, linked: root.linked });
        }
      }
      if (candidates.length === 0) return null;
      candidates.sort(function (a, b) {
        if (a.authoritative !== b.authoritative) return a.authoritative ? -1 : 1;
        if (a.repeated !== b.repeated) return a.repeated ? -1 : 1;
        if (a.linked !== b.linked) return a.linked ? -1 : 1;
        return a.item.compareDocumentPosition(b.item) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });
      const best = candidates[0];
      best.item.setAttribute('data-nav-engine-dealer-probe-kind', best.authoritative ? 'authoritative' : 'generic');
      best.item.setAttribute('data-nav-engine-dealer-probe-linked', best.linked ? '1' : '0');
      return best.item;
    },
  };
  w.__navEngineDealerProbe = probe;
  return true;
})()`;

export interface ProbeSnapshot {
  fieldValueRetained: boolean | null;
  fieldNonEmpty: boolean;
  focusInField: boolean;
  fieldAriaExpanded: boolean | null;
  fieldActiveDescendantPresent: boolean;
  scopeTextLength: number;
  surfaceCount: number;
  surfaceTextLength: number;
  noResultsMessageObserved: boolean;
  busy: boolean;
  mutationCount: number;
  geolocationRequests: number;
  blockedSubmitEvents: number;
  blockedSubmitClicks: number;
  fieldAriaInvalid: boolean;
  fieldHasNativeValidationMessage: boolean;
}

export type HiddenFieldPurpose = "dealer_identifier" | "location_identifier" | "unclassified" | "unrelated";

export interface HiddenFieldState {
  key: string;
  nonEmpty: boolean;
  purpose: HiddenFieldPurpose;
}

const EMPTY_SNAPSHOT: ProbeSnapshot = {
  fieldValueRetained: null,
  fieldNonEmpty: false,
  focusInField: false,
  fieldAriaExpanded: null,
  fieldActiveDescendantPresent: false,
  scopeTextLength: 0,
  surfaceCount: 0,
  surfaceTextLength: 0,
  noResultsMessageObserved: false,
  busy: false,
  mutationCount: 0,
  geolocationRequests: 0,
  blockedSubmitEvents: 0,
  blockedSubmitClicks: 0,
  fieldAriaInvalid: false,
  fieldHasNativeValidationMessage: false,
};

interface ProbeSnapshotArgs {
  scope: Element | null;
  typed: string | null;
}

type ProbeWindow = Window & {
  __navEngineDealerProbe?: {
    start(form: Element): boolean;
    stop(): boolean;
    allow(el: Element | null): boolean;
    markStage(): number;
    hiddenState(form: Element): HiddenFieldState[];
    snapshot(field: Element, scope: Element | null, typed: string | null): ProbeSnapshot;
    findResult(field: Element, sinceSeq: number): Element | null;
  };
};

/**
 * Thin typed handle over the in-page probe. Every method fails soft (a frame navigation or a
 * detached element never throws into the lookup state machine) and every value it returns is
 * already sanitised in the page.
 */
export interface DealerLookupProbe {
  available: boolean;
  markStage(): Promise<number>;
  hiddenState(): Promise<HiddenFieldState[]>;
  snapshot(typed: string | null): Promise<ProbeSnapshot>;
  findResult(sinceSeq: number): Promise<ElementHandle<HTMLElement | SVGElement> | null>;
  allow(handle: ElementHandle<HTMLElement | SVGElement> | null): Promise<void>;
  stop(): Promise<void>;
}

export async function startDealerLookupProbe(form: Locator, field: Locator, scope: Locator): Promise<DealerLookupProbe> {
  const formHandle = await form.elementHandle({ timeout: 1000 }).catch(() => null);
  const frame: Frame | null = formHandle ? await formHandle.ownerFrame().catch(() => null) : null;
  const installed = frame ? await frame.evaluate(DEALER_PROBE_SOURCE).then(() => true).catch(() => false) : false;
  const started = installed ? await form.evaluate((el: Element) => (window as ProbeWindow).__navEngineDealerProbe?.start(el) ?? false).catch(() => false) : false;
  const scopeHandle = await scope.elementHandle({ timeout: 500 }).catch(() => null);

  return {
    available: started,
    async markStage() {
      if (!started) return 0;
      return form.evaluate(() => (window as ProbeWindow).__navEngineDealerProbe?.markStage() ?? 0).catch(() => 0);
    },
    async hiddenState() {
      if (!started) {
        return form
          .evaluate((el: Element) =>
            Array.from(el.querySelectorAll('input[type="hidden"]')).map((input, i) => ({
              key: `p${i}`,
              nonEmpty: (input as HTMLInputElement).value.trim().length > 0,
              purpose: "unclassified" as const,
            })),
          )
          .catch(() => []);
      }
      return form.evaluate((el: Element) => (window as ProbeWindow).__navEngineDealerProbe?.hiddenState(el) ?? []).catch(() => []);
    },
    async snapshot(typed: string | null) {
      if (!started) return { ...EMPTY_SNAPSHOT };
      const args = { scope: scopeHandle, typed } as unknown as ProbeSnapshotArgs;
      const evaluator = field as unknown as { evaluate(fn: (el: Element, a: ProbeSnapshotArgs) => ProbeSnapshot | null, arg: ProbeSnapshotArgs): Promise<ProbeSnapshot | null> };
      const result = (await evaluator
        .evaluate((el: Element, a: ProbeSnapshotArgs) => (window as ProbeWindow).__navEngineDealerProbe?.snapshot(el, a.scope, a.typed) ?? null, args)
        .catch(() => null)) as ProbeSnapshot | null;
      return result ?? { ...EMPTY_SNAPSHOT };
    },
    async findResult(sinceSeq: number) {
      if (!started) return null;
      const handle = await field
        .evaluateHandle((el: Element, seq: number) => (window as ProbeWindow).__navEngineDealerProbe?.findResult(el, seq) ?? null, sinceSeq)
        .catch(() => null);
      const element = handle?.asElement() ?? null;
      return element as ElementHandle<HTMLElement | SVGElement> | null;
    },
    async allow(handle) {
      if (!started) return;
      if (handle) {
        await handle.evaluate((target: Element) => void (window as ProbeWindow).__navEngineDealerProbe?.allow(target)).catch(() => {});
      } else {
        await form.evaluate(() => void (window as ProbeWindow).__navEngineDealerProbe?.allow(null)).catch(() => {});
      }
    },
    async stop() {
      if (!started) return;
      await form.evaluate(() => (window as ProbeWindow).__navEngineDealerProbe?.stop()).catch(() => {});
    },
  };
}

/** True only when the same keyed hidden input went from empty to populated, or a hidden input
 * inserted since `before` arrived already populated and is semantically a dealer/location
 * identifier. A field whose name/id marks it as unrelated plumbing (a token, a captcha, a tracking
 * parameter) never counts, whichever way it changes. */
export function detectHiddenCommit(before: HiddenFieldState[], after: HiddenFieldState[]): { committed: boolean; purposes: HiddenFieldPurpose[] } {
  const beforeByKey = new Map(before.map((h) => [h.key, h]));
  const purposes: HiddenFieldPurpose[] = [];
  after.forEach((h) => {
    if (!h.nonEmpty || h.purpose === "unrelated") return;
    const previous = beforeByKey.get(h.key);
    if (previous ? !previous.nonEmpty : h.purpose === "dealer_identifier" || h.purpose === "location_identifier") purposes.push(h.purpose);
  });
  return { committed: purposes.length > 0, purposes: [...new Set(purposes)] };
}
