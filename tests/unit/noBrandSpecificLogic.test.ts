import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname, "..", "..", "src");

// CLAUDE.md's non-negotiable design rule: the core navigation loop (and, by extension,
// every module this repo ships in src/) must never become domain-specific. This is a
// regression guard, not exhaustive brand-name detection -- it exists so a future change
// that reintroduces a brand/CTA/language/market-specific literal into src/ fails loudly
// instead of silently, the same way the memory-stability/task-persistence work in this
// change was required to introduce none.
const FORBIDDEN_TOKENS = ["opel", "peugeot", "citroen", "citroën", "fiat", "stellantis"];

// Word-boundary matched, not a raw substring search: "opel" as a bare substring also
// matches inside unrelated identifiers like "topEl" (document.elementFromPoint's top
// element), which would be a false positive, not a genuine brand reference.
function tokenPattern(token: string): RegExp {
  return new RegExp(`\\b${token}\\b`, "i");
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(fullPath)));
    } else if (extname(entry.name) === ".ts") {
      files.push(fullPath);
    }
  }
  return files;
}

test("src/ contains no brand-specific (Opel/Peugeot/Citroën/Fiat/Stellantis) literals", async () => {
  const files = await listFilesRecursive(srcDir);
  const offenders: string[] = [];

  for (const file of files) {
    const content = await readFile(file, "utf-8");
    for (const token of FORBIDDEN_TOKENS) {
      if (tokenPattern(token).test(content)) {
        offenders.push(`${file} contains "${token}"`);
      }
    }
  }

  assert.deepEqual(offenders, []);
});
