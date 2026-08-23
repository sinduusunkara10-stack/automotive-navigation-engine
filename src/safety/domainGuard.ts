export function isAllowedHost(hostname: string, allowedDomains: string[]): boolean {
  return allowedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

export function checkNavigationAllowed(url: string, allowedDomains: string[]): boolean {
  try {
    const { hostname } = new URL(url);
    return isAllowedHost(hostname, allowedDomains);
  } catch {
    return false;
  }
}
