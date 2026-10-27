/**
 * Test-only: re-serves a light-DOM lead-form fixture with its whole body inside one open shadow
 * root, the shape a web-component form app renders. The fixture's own inline scripts run unchanged
 * against a `document` that resolves ids and selectors inside that shadow root first, so each
 * fixture keeps its behaviour while every control the engine has to find, read, fill and submit
 * lives in shadow DOM. Never used by engine code.
 */
export const FIXTURE_DOM_MODE_ENV = "FIXTURE_DOM_MODE";
export const OPEN_SHADOW_MODE = "open-shadow";

const HOST_ID = "__fixture_shadow_host";
const TEMPLATE_ID = "__fixture_shadow_template";

export function openShadowModeEnabled(): boolean {
  return process.env[FIXTURE_DOM_MODE_ENV] === OPEN_SHADOW_MODE;
}

export function isShadowTransformable(fileName: string, html: string): boolean {
  if (!/^(lead-form-|location-gate)/.test(fileName)) return false;
  // External scripts would run against the real document, so those fixtures stay light DOM.
  return !/<script[^>]*\ssrc=/i.test(html);
}

function collectFunctionNames(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/(?:^|[\s;{}])(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) names.add(m[1]!);
  return [...names];
}

export function toOpenShadowFixture(html: string): string {
  const bodyMatch = /<body([^>]*)>([\s\S]*)<\/body>/i.exec(html);
  if (!bodyMatch) return html;
  const bodyAttrs = bodyMatch[1] ?? "";
  let markup = bodyMatch[2] ?? "";
  const scripts: string[] = [];
  markup = markup.replace(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi, (_all, _attrs: string | undefined, src: string) => {
    scripts.push(src);
    return "";
  });
  // Inline handlers would run against the real document; they are re-attached below against the
  // shadow-aware one instead.
  markup = markup.replace(/\son([a-z]+)=("[^"]*"|'[^']*')/gi, (_all, type: string, quoted: string) => ` data-fixture-on${type.toLowerCase()}=${quoted}`);
  const headMatch = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(html);
  const styles = [...(headMatch?.[1] ?? "").matchAll(/<style[^>]*>[\s\S]*?<\/style>/gi)].map((m) => m[0]).join("\n");
  const exportsSrc = collectFunctionNames(scripts.join("\n"))
    .map((n) => `if (typeof ${n} === "function") window.${n} = ${n};`)
    .join("\n");
  const bootstrap = `<script>
(function () {
  var realDocument = document;
  var host = realDocument.getElementById(${JSON.stringify(HOST_ID)});
  var root = host.attachShadow({ mode: "open" });
  root.appendChild(realDocument.getElementById(${JSON.stringify(TEMPLATE_ID)}).content.cloneNode(true));
  var shadowDocument = new Proxy(realDocument, {
    get: function (target, prop) {
      if (prop === "getElementById") return function (id) { return root.getElementById(id) || realDocument.getElementById(id); };
      if (prop === "querySelector") return function (s) { return root.querySelector(s) || realDocument.querySelector(s); };
      if (prop === "querySelectorAll") return function (s) { return Array.from(root.querySelectorAll(s)).concat(Array.from(realDocument.querySelectorAll(s))); };
      if (prop === "activeElement") return root.activeElement || realDocument.activeElement;
      var value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  Array.prototype.forEach.call(root.querySelectorAll("*"), function (el) {
    Array.prototype.forEach.call(el.attributes, function (attr) {
      if (attr.name.indexOf("data-fixture-on") !== 0) return;
      var handler = new Function("document", "event", attr.value);
      el.addEventListener(attr.name.slice("data-fixture-on".length), function (event) {
        if (handler.call(this, shadowDocument, event) === false) event.preventDefault();
      });
    });
  });
  (function (document) {
${scripts.join("\n;\n")}
;
${exportsSrc}
  }).call(window, shadowDocument);
})();
</script>`;
  const body = `<body${bodyAttrs}><div id="${HOST_ID}"></div><template id="${TEMPLATE_ID}">${styles}${markup}</template>${bootstrap}</body>`;
  return html.slice(0, bodyMatch.index) + body + html.slice(bodyMatch.index + bodyMatch[0].length);
}
