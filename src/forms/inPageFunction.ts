import type { Locator } from "playwright";

type InstalledFunctions = Record<string, ((el: Element, arg: unknown) => unknown) | undefined>;

/**
 * Runs a function given as string source against a locator's element. Source strings are used for
 * in-page helpers because tsx/esbuild wraps nested named bindings of a compiled callback in a
 * __name(...) helper that does not exist in the page. The source is installed through the frame's
 * own evaluate (unaffected by a page's CSP, unlike an in-page eval), then called by a plain arrow.
 */
export async function callInPageFunction<T>(target: Locator, key: string, source: string, arg: unknown): Promise<T> {
  const handle = await target.elementHandle({ timeout: 5_000 });
  if (!handle) throw new Error("in-page function target not found");
  try {
    const frame = await handle.ownerFrame();
    if (!frame) throw new Error("in-page function target has no frame");
    await frame.evaluate(`window[${JSON.stringify(key)}] = ${source}; true`);
    return (await handle.evaluate((el: Element, a: { key: string; arg: unknown }) => (window as unknown as InstalledFunctions)[a.key]?.(el, a.arg), { key, arg })) as T;
  } finally {
    await handle.dispose().catch(() => {});
  }
}
