// A minimal stand-in for jQuery's event and data registries, enough for a page-level validator
// built on it: one native dispatcher listener per element and event type, delegated handlers by
// selector, and `return false` meaning preventDefault + stopPropagation.
(function () {
  const events = new WeakMap();
  const data = new WeakMap();
  function registry(el) {
    if (!events.has(el)) events.set(el, {});
    return events.get(el);
  }
  function jQuery(el) {
    return {
      on(type, selector, handler) {
        if (typeof selector === "function") {
          handler = selector;
          selector = undefined;
        }
        const reg = registry(el);
        if (!reg[type]) {
          reg[type] = [];
          el.addEventListener(type, function jqDispatch(e) {
            for (const h of reg[type]) {
              const target = h.selector ? e.target.closest && e.target.closest(h.selector) : el;
              if (!target) continue;
              if (h.handler.call(target, e) === false) {
                e.preventDefault();
                e.stopPropagation();
              }
            }
          });
        }
        reg[type].push({ handler, selector });
        return this;
      },
    };
  }
  jQuery.fn = { jquery: "3.0.0-fixture" };
  jQuery._data = function (el, key) {
    return key === "events" ? events.get(el) : undefined;
  };
  jQuery.data = function (el, key, value) {
    if (!data.has(el)) data.set(el, {});
    if (value !== undefined) data.get(el)[key] = value;
    return data.get(el)[key];
  };
  window.jQuery = jQuery;
})();
