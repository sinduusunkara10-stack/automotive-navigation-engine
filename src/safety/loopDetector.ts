export function isLoopDetected(visitedStates: string[]): boolean {
  const n = visitedStates.length;
  if (n < 4) {
    return false;
  }
  const a = visitedStates[n - 4];
  const b = visitedStates[n - 3];
  const c = visitedStates[n - 2];
  const d = visitedStates[n - 1];
  return a !== undefined && b !== undefined && a === c && b === d && a !== b;
}
