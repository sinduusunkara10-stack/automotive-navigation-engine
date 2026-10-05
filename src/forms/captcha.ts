export interface CaptchaSignals {
  iframeSrcs: string[];
  elementAttributes: string[];
  visibleText: string;
}

const IFRAME_SRC_MARKERS = ["recaptcha", "hcaptcha", "turnstile", "funcaptcha", "arkoselabs"];
const ATTRIBUTE_MARKERS = ["g-recaptcha", "h-captcha", "cf-turnstile", "data-sitekey"];
const TEXT_MARKERS = ["verify you are human", "i'm not a robot", "prove you're not a robot", "security check"];

export function detectCaptcha(signals: CaptchaSignals): boolean {
  const text = signals.visibleText.toLowerCase();
  if (IFRAME_SRC_MARKERS.some((marker) => signals.iframeSrcs.some((src) => src.toLowerCase().includes(marker)))) {
    return true;
  }
  if (ATTRIBUTE_MARKERS.some((marker) => signals.elementAttributes.some((attr) => attr.toLowerCase().includes(marker)))) {
    return true;
  }
  return TEXT_MARKERS.some((marker) => text.includes(marker));
}
