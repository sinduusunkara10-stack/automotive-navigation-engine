import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Writes every formVisualEvidence screenshot in a saved task response (or any JSON containing
 * one) to JPEG files: `npm run manual:extract-visual-evidence -- response.json out-dir`.
 */
async function main(): Promise<void> {
  const [input, outDir = "visual-evidence"] = process.argv.slice(2);
  if (!input) throw new Error("usage: manual:extract-visual-evidence -- <response.json> [out-dir]");
  const root = JSON.parse(await readFile(input, "utf-8")) as unknown;
  await mkdir(outDir, { recursive: true });
  let count = 0;
  const visit = async (node: unknown): Promise<void> => {
    if (Array.isArray(node)) {
      for (const item of node) await visit(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (typeof record.dataBase64 === "string" && record.mimeType === "image/jpeg") {
      count += 1;
      const attempt = typeof record.submitAttempt === "number" ? `-attempt${record.submitAttempt}` : "";
      await writeFile(join(outDir, `${String(count).padStart(2, "0")}-${String(record.stage)}${attempt}.jpg`), Buffer.from(record.dataBase64, "base64"));
      return;
    }
    for (const value of Object.values(record)) await visit(value);
  };
  await visit(root);
  console.log(`wrote ${count} screenshot(s) to ${outDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
