import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Safe, string-level checks on the manual-trigger-only, spend-capped full-journey
// GitHub Actions workflow and the script it runs (task requirement #15). Deliberately
// does not parse/execute the workflow or make any network/API call — it only inspects
// the committed source text.

const __dirname = dirname(fileURLToPath(import.meta.url));
const workflowPath = join(
  __dirname,
  "..",
  "..",
  ".github",
  "workflows",
  "manual-claude-full-local-journey.yml",
);
const workflow = readFileSync(workflowPath, "utf8");

const taskPath = join(__dirname, "..", "manual", "fullJourneyTask.ts");
const taskSource = readFileSync(taskPath, "utf8");

const AUTOMATIC_TRIGGERS = ["push:", "pull_request:", "schedule:", "repository_dispatch:", "workflow_run:"];

// Matches real, populated Anthropic API keys (sk-ant-...) without flagging the
// placeholder in .env.example or the sk-ant-... examples referenced in docs/comments.
const LITERAL_ANTHROPIC_KEY_PATTERN = /sk-ant-(?!\.\.\.|placeholder)[A-Za-z0-9_-]{10,}/;

test("workflow triggers on workflow_dispatch only", () => {
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

test("workflow uses the fulljourney:claude npm script exactly once", () => {
  const matches = workflow.match(/npm run fulljourney:claude/g) ?? [];
  assert.equal(matches.length, 1);
});

test("workflow declares minimal (contents: read) permissions", () => {
  assert.match(workflow, /(^|\n)permissions:\s*\n\s*contents:\s*read/);
});

test("workflow declares a single-run concurrency group and a low timeout", () => {
  assert.match(workflow, /(^|\n)concurrency:/);
  assert.match(workflow, /cancel-in-progress:\s*false/);
  const timeoutMatch = workflow.match(/timeout-minutes:\s*(\d+)/);
  assert.ok(timeoutMatch, "expected a job-level timeout-minutes");
  assert.ok(Number(timeoutMatch![1]) <= 20, "expected a conservatively low workflow timeout");
});

test("workflow disables Claude retries (CLAUDE_MAX_RETRIES=0)", () => {
  assert.match(workflow, /CLAUDE_MAX_RETRIES:\s*"0"/);
});

test("workflow sets a small CLAUDE_MAX_OUTPUT_TOKENS suitable for structured decisions", () => {
  const match = workflow.match(/CLAUDE_MAX_OUTPUT_TOKENS:\s*"(\d+)"/);
  assert.ok(match, "expected CLAUDE_MAX_OUTPUT_TOKENS to be set");
  const value = Number(match![1]);
  assert.ok(value > 0 && value <= 512, `expected a small output-token limit, got ${value}`);
});

test("workflow supplies the secret only to the real full-journey step, not workflow-level env", () => {
  assert.doesNotMatch(workflow, /(^|\n)env:\s*\n(\s+\S.*\n)*\s*ANTHROPIC_API_KEY:/);
});

test("workflow does not echo, print, or log the secret's expanded value", () => {
  // Deliberately narrower than "mentions ANTHROPIC_API_KEY at all" -- the workflow's
  // required-secret error message names the secret by name (safe), but must never expand
  // it via $ANTHROPIC_API_KEY / ${ANTHROPIC_API_KEY} inside an echo/print statement.
  assert.doesNotMatch(workflow, /echo[^\n]*\$\{?ANTHROPIC_API_KEY\}?/);
});

test("workflow runs the automated (network-free) test suite before the real Claude step", () => {
  const testIndex = workflow.indexOf("npm test");
  const journeyIndex = workflow.indexOf("npm run fulljourney:claude");
  assert.ok(testIndex >= 0 && journeyIndex >= 0 && testIndex < journeyIndex);
});

test("the full-journey task caps the run at maxSteps: 3 (max 3 real Claude calls, no 4th)", () => {
  assert.match(taskSource, /maxSteps:\s*3\b/);
});

test("the full-journey task file contains no literal Anthropic API key", () => {
  assert.doesNotMatch(taskSource, LITERAL_ANTHROPIC_KEY_PATTERN);
});
