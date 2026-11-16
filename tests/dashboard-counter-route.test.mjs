import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workerSource = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");

test("dashboard counter route is read-only and permits the Dashboard to read it", () => {
  assert.match(
    workerSource,
    /url\.pathname === "\/api\/dashboard-token-usage" && request\.method === "GET"\) return dashboardUsage\(request, env\)/,
  );
  assert.match(workerSource, /access-control-allow-origin/);
  assert.match(workerSource, /https:\/\/ai-teaching-dashboard\.utah1974\.chatgpt\.site/);
  assert.doesNotMatch(
    workerSource,
    /url\.pathname === "\/api\/dashboard-token-usage" && request\.method === "POST"/,
  );
});
