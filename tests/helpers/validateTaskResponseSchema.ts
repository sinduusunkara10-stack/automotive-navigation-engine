import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// ajv and ajv-formats ship CJS builds whose ESM default-import types don't resolve
// cleanly under NodeNext interop; loading them via createRequire sidesteps that (same
// approach as tests/integration/local-poc.test.ts and
// tests/integration/reasoningProviderDiagnostics.test.ts).
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js");
const addFormats = require("ajv-formats");

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(__dirname, "..", "..", "schemas", "task-response.schema.json");

export interface TaskResponseSchemaValidation {
  valid: boolean;
  errorsText: string;
}

export async function validateAgainstTaskResponseSchema(response: unknown): Promise<TaskResponseSchemaValidation> {
  const schema = JSON.parse(await readFile(schemaPath, "utf-8")) as Record<string, unknown>;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const valid = validate(response) as boolean;
  return { valid, errorsText: valid ? "" : ajv.errorsText(validate.errors) };
}
