import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { TaskRequest } from "../types/task-request.js";
import type { TaskResponse } from "../types/task-response.js";

// ajv and ajv-formats ship CJS builds whose ESM default-import types don't resolve
// cleanly under NodeNext interop; loading them via createRequire sidesteps that
// (same approach as tests/integration/local-poc.test.ts).
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js");
const addFormats = require("ajv-formats");

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemasDir = join(__dirname, "..", "..", "schemas");

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

const taskRequestSchema = JSON.parse(readFileSync(join(schemasDir, "task-request.schema.json"), "utf-8"));
const taskResponseSchema = JSON.parse(readFileSync(join(schemasDir, "task-response.schema.json"), "utf-8"));

const validateTaskRequestSchema = ajv.compile(taskRequestSchema);
const validateTaskResponseSchema = ajv.compile(taskResponseSchema);

export interface ValidationResult<T> {
  valid: boolean;
  value?: T;
  errors?: string[];
}

function formatErrors(errors: Array<{ instancePath?: string; message?: string }> | null | undefined): string[] {
  return (errors ?? []).map((err) => `${err.instancePath || "(root)"} ${err.message ?? "is invalid"}`);
}

export function validateTaskRequest(body: unknown): ValidationResult<TaskRequest> {
  if (validateTaskRequestSchema(body)) {
    return { valid: true, value: body as TaskRequest };
  }
  return { valid: false, errors: formatErrors(validateTaskRequestSchema.errors) };
}

export function validateTaskResponse(body: unknown): ValidationResult<TaskResponse> {
  if (validateTaskResponseSchema(body)) {
    return { valid: true, value: body as TaskResponse };
  }
  return { valid: false, errors: formatErrors(validateTaskResponseSchema.errors) };
}
