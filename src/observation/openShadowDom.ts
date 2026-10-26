/**
 * In-page helpers, as string source, for code that must see controls rendered inside open shadow
 * roots (web-component form apps). `document.querySelectorAll`, `document.getElementById` and
 * `document.body.innerText` stop at every shadow boundary, while Playwright's CSS locators pierce
 * open roots -- so in-page scans and the locators that act on their results must agree. Closed
 * roots are unreachable by design and stay out of scope. Each source is a plain `function`
 * expression to embed in another string source (see forms/inPageFunction.ts for why compiled
 * callbacks cannot carry nested helpers).
 */
export const MAX_OPEN_SHADOW_ROOTS = 200;

/** `(scope) => ShadowRoot[]`: open shadow roots under `scope` (a document, shadow root or element, its own root included), breadth-first, bounded. */
export const OPEN_SHADOW_ROOTS_SOURCE = `function (scope) {
  var roots = [];
  var pending = [];
  if (scope && scope.shadowRoot) pending.push(scope.shadowRoot);
  Array.prototype.forEach.call(scope.querySelectorAll("*"), function (n) { if (n.shadowRoot) pending.push(n.shadowRoot); });
  while (pending.length > 0 && roots.length < ${MAX_OPEN_SHADOW_ROOTS}) {
    var root = pending.shift();
    roots.push(root);
    Array.prototype.forEach.call(root.querySelectorAll("*"), function (n) { if (n.shadowRoot) pending.push(n.shadowRoot); });
  }
  return roots;
}`;

/** `(scope, selector) => Element[]`: matches in `scope` followed by matches inside every open shadow root under it. */
export const DEEP_QUERY_ALL_SOURCE = `function (scope, selector) {
  var out = Array.from(scope.querySelectorAll(selector));
  (${OPEN_SHADOW_ROOTS_SOURCE})(scope).forEach(function (root) { out.push.apply(out, Array.from(root.querySelectorAll(selector))); });
  return out;
}`;

/** `(node, id) => Element | null`: an id reference (label[for], aria-labelledby, aria-describedby) resolves in the referencing node's own tree first, then the document. */
export const TREE_ELEMENT_BY_ID_SOURCE = `function (node, id) {
  var root = node && node.getRootNode ? node.getRootNode() : document;
  return (root && root !== document && root.getElementById ? root.getElementById(id) : null) || document.getElementById(id);
}`;

/** `() => string`: the document's rendered text plus the rendered text of every open shadow root, which `body.innerText` omits. */
export const DEEP_VISIBLE_TEXT_SOURCE = `function () {
  var parts = [document.body ? document.body.innerText || "" : ""];
  (${OPEN_SHADOW_ROOTS_SOURCE})(document).forEach(function (root) {
    Array.prototype.forEach.call(root.children, function (child) {
      if (/^(STYLE|SCRIPT|TEMPLATE|LINK)$/.test(child.tagName)) return;
      parts.push(child.innerText || "");
    });
  });
  return parts.join("\\n");
}`;
