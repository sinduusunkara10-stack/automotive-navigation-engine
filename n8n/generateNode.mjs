#!/usr/bin/env node
// Regenerates the deployable, copy-paste-ready n8n Code node JavaScript directly from
// buildAnalyticsReportingRows.ts (the source of truth), so the TypeScript implementation and its
// plain-JS n8n twin can never hand-diverge again. Usage:
//   node n8n/generateNode.mjs <output-file-path>

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, "buildAnalyticsReportingRows.ts");
const outputPath = process.argv[2];

if (!outputPath) {
  console.error("Usage: node n8n/generateNode.mjs <output-file-path>");
  process.exit(1);
}

const source = readFileSync(sourcePath, "utf8");

const { outputText, diagnostics } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2020,
    removeComments: false,
  },
  fileName: sourcePath,
  reportDiagnostics: true,
});

const hardErrors = (diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
if (hardErrors.length > 0) {
  for (const d of hardErrors) {
    console.error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  }
  process.exit(1);
}

const plainJs = outputText
  .split("\n")
  .filter((line) => !/^export\s*\{\s*\};?\s*$/.test(line.trim()))
  .map((line) => line.replace(/^export (function|const|class)\b/, "$1"))
  .join("\n")
  .trimEnd();

const header = `// n8n Code node: "Build Analytics Reporting Rows"
// GENERATED FILE -- do not hand-edit.
// Source of truth: n8n/buildAnalyticsReportingRows.ts in the automotive-navigation-engine repo.
// Regenerate with: node n8n/generateNode.mjs <output-file-path>
//
// Paste this whole file into the node body -- it already ends with the required
// "return buildAnalyticsReportingRowsItems(...)" call.

`;

const footer = `

return buildAnalyticsReportingRowsItems($input.all().map((item) => item.json));
`;

writeFileSync(outputPath, header + plainJs + footer, "utf8");
console.log(`Wrote ${outputPath}`);
