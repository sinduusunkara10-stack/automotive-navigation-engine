import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Safe, string-level checks on the manual-trigger-only GitHub Actions smoke test workflow
// (see task requirement #13). Deliberately does not parse/execute the workflow or make any
// network/API call — it only inspects the committed YAML text.

const __dirname = dirname(fileURLToPath(import.meta.url));
const workflowPath = join(__dirname, "..", "..", ".github", "workflows", "manual-claude-smoke-test.yml");
const workflow = readFileSync(workflowPath, "utf8");

const AUTOMATIC_TRIGGERS = ["push:", "pull_request:", "schedule:", "repository_dispatch:", "workflow_run:"];

// Matches real, populated Anthropic API keys (sk-ant-...) without flagging the
// placeholder in .env.example or the sk-ant-... examples referenced in docs/comments.
const LITERAL_ANTHROPIC_KEY_PATTERN = /sk-ant-(?!\.\.\.|placeholder)[A-Za-z0-9_-]{10,}/;

test("workflow triggers on workflow_dispatch", () => {
  assert.match(workflow, /(^|\n)on:\s*\n\s*workflow_dispatch:/);
});

test("workflow contains no automatic trigger", () => {
  for (const trigger of AUTOMATIC_TRIGGERS) {
    assert.doesNotMatch(
      workflow,
      new RegExp(`(^|\\n)\\s*${trigger}`),
      `workflow must not declare automatic trigger "${trigger}"`,
    );
  }
});

test("workflow references the ANTHROPIC_API_KEY secret via the standard secrets context", () => {
  assert.match(workflow, /\$\{\{\s*secrets\.ANTHROPIC_API_KEY\s*\}\}/);
});

test("workflow contains no literal Anthropic API key", () => {
  assert.doesNotMatch(workflow, LITERAL_ANTHROPIC_KEY_PATTERN);
});

test("workflow uses the smoke:claude npm script exactly once", () => {
  const matches = workflow.match(/npm run smoke:claude/g) ?? [];
  assert.equal(matches.length, 1);
});

test("workflow declares minimal (contents: read) permissions", () => {
  assert.match(workflow, /(^|\n)permissions:\s*\n\s*contents:\s*read/);
});

test("workflow declares a concurrency group and a timeout", () => {
  assert.match(workflow, /(^|\n)concurrency:/);
  assert.match(workflow, /timeout-minutes:\s*\d+/);
});
