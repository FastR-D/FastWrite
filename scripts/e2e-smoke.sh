#!/bin/sh
set -eu

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
QA_DATA=$(mktemp -d "${TMPDIR:-/tmp}/fastwrite-e2e.XXXXXX")
E2E_BROWSER=${FASTWRITE_E2E_BROWSER:-chrome}
QA_SESSION="fastwrite-e2e-${E2E_BROWSER}-$$"
SERVER_PID=""

pw() {
  npx --yes --package @playwright/cli playwright-cli --session "$QA_SESSION" "$@"
}

run_code() {
  output=$(pw run-code "$1")
  printf '%s\n' "$output"
  case "$output" in
    *"### Error"*) return 1 ;;
  esac
}

run_accessibility() {
  run_code '
async (page) => {
  await page.addScriptTag({ path: "node_modules/axe-core/axe.min.js" });
  const result = await page.evaluate(async () => await window.axe.run(document, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] }
  }));
  const violations = result.violations.filter(item => item.impact === "critical" || item.impact === "serious");
  if (violations.length) {
    throw new Error(violations.map(item => item.id + ": " + item.nodes.map(node => node.target.join(" ")).join(", ")).join("\n"));
  }
}'
}

cleanup() {
  pw close >/dev/null 2>&1 || true
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" >/dev/null 2>&1 || true; fi
  case "$QA_DATA" in
    "${TMPDIR:-/tmp}"/fastwrite-e2e.*) chmod -R u+w "$QA_DATA" 2>/dev/null || true; rm -r -- "$QA_DATA" ;;
  esac
}
trap cleanup EXIT INT TERM

cd "$PROJECT_ROOT"
if [ "${FASTWRITE_E2E_SKIP_BUILD:-0}" != "1" ]; then bun run build >/dev/null; fi
FASTWRITE_DATA_DIR="$QA_DATA" FASTWRITE_PORT=3213 bun apps/server/src/server.ts >"$QA_DATA/server.log" 2>&1 &
SERVER_PID=$!

attempt=0
until curl --fail --silent http://127.0.0.1:3213/projects >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo "FastWrite E2E servers did not become ready" >&2
    exit 1
  fi
  sleep 0.25
done

pw open http://127.0.0.1:3213/projects --browser "$E2E_BROWSER"
run_accessibility

run_code '
async (page) => {
  await page.getByRole("button", { name: "New paper" }).click();
  await page.getByRole("textbox", { name: "Project name" }).fill("E2E Smoke Paper");
  await page.getByRole("button", { name: "Create paper" }).click();
  await page.waitForURL(/\/projects\/paper_/);
  const projectId = page.url().split("/").pop();
  const apiRoot = "http://127.0.0.1:3213/api/projects/" + projectId;
  const created = await page.request.post(apiRoot + "/files", {
    data: { path: "sections/method.tex", content: "\\section{Method}\nThis sentence is mapped from a secondary source file." }
  });
  if (!created.ok()) throw new Error("Could not create the multi-file SyncTeX fixture");
  const largeCreated = await page.request.post(apiRoot + "/files", {
    data: { path: "large-notes.md", content: "# Large notes\n" + "bounded evidence line\n".repeat(20_000) }
  });
  if (!largeCreated.ok()) throw new Error("Could not create the large-file fixture");
  const opened = await (await page.request.get(apiRoot + "/file?path=main.tex")).json();
  const main = "\\documentclass{article}\n\\begin{document}\n\\input{sections/method}\n\\end{document}";
  const saved = await page.request.put(apiRoot + "/file?path=main.tex", {
    data: { content: main, baseVersion: opened.file.version }
  });
  if (!saved.ok()) throw new Error("Could not update the multi-file SyncTeX fixture");
  await page.reload();
  await page.getByRole("textbox", { name: "Source editor for main.tex" }).waitFor();
}'

run_code '
async (page) => {
  const toolbar = page.locator(".pdf-toolbar");
  const idleBox = await toolbar.boundingBox();
  await page.getByText("Compiled successfully", { exact: true }).waitFor({ timeout: 30000 });
  await page.locator(".react-pdf__Page__canvas").first().waitFor({ timeout: 30000 });
  const successBox = await toolbar.boundingBox();
  for (const box of [successBox]) {
    if (!idleBox || !box || idleBox.width !== box.width || idleBox.height !== box.height) {
      throw new Error("PDF toolbar changed size across compile states");
    }
  }
}'

run_code '
async (page) => {
  await page.getByRole("treeitem", { name: "sections", exact: true }).click();
  await page.locator("span[title=\"sections/method.tex\"]").click();
  const methodEditor = page.getByRole("textbox", { name: "Source editor for sections/method.tex" });
  await methodEditor.waitFor();
  await methodEditor.focus();
  await methodEditor.press("ControlOrMeta+End");
  await page.waitForTimeout(100);
  await page.getByRole("button", { name: "Locate source in PDF" }).click();
  const highlight = page.locator(".synctex-highlight");
  await highlight.waitFor();
  const point = await highlight.boundingBox();
  if (!point) throw new Error("Source-to-PDF SyncTeX did not create a visible highlight");
  await page.locator("span[title=\"main.tex\"]").click();
  await page.getByRole("textbox", { name: "Source editor for main.tex" }).waitFor();
  await page.mouse.dblclick(point.x + point.width / 2, point.y + point.height / 2);
  await page.getByRole("textbox", { name: "Source editor for sections/method.tex" }).waitFor();
}'
run_accessibility

run_code '
async (page) => {
  let changeSet;
  await page.route("**/api/projects/*/revisions", async route => {
    const selection = route.request().postDataJSON().selection;
    const mixed = Array.from({ length: 20 }, (_, index) =>
      "Security claim " + (index + 1) + " uses \\texttt{trusted_" + index + "} and $Adv^{\\mathsf{cca}}$；实验边界必须与威胁模型一致。"
    ).join("\n");
    const timestamp = new Date().toISOString();
    changeSet = {
      id: "revise-e2e",
      projectId: page.url().split("/").pop(),
      agentRunId: "run-revise-e2e",
      status: "proposed",
      summary: "Skill-guided academic polish",
      rationale: "Preserve LaTeX while clarifying security claims.",
      changes: [{
        path: selection.path,
        from: selection.from,
        to: selection.to,
        before: selection.text,
        after: mixed,
        baseVersion: selection.fileVersion
      }],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ run: { id: "run-revise-e2e" }, changeSet })
    });
  });
  await page.route("**/api/projects/*/change-sets/revise-e2e/reject", async route => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...changeSet, status: "rejected", updatedAt: new Date().toISOString() })
    });
  });

  const editor = page.getByRole("textbox", { name: "Source editor for sections/method.tex" });
  await editor.focus();
  await editor.press("ControlOrMeta+A");
  await page.locator(".revise-context-strip").waitFor();
  const initialBrowserName = page.context().browser()?.browserType().name() || "browser";
  const initialBrowserSuffix = initialBrowserName === "chromium" ? "" : "-" + initialBrowserName;
  await page.screenshot({ path: "output/playwright/workspace-revise-chat-1440x900" + initialBrowserSuffix + ".png", fullPage: true });
  const shortcut = page.getByRole("button", { name: "Academic polish" });
  await shortcut.focus();
  await shortcut.press("Enter");
  const proposal = page.locator(".revise-message--assistant").filter({ has: page.getByRole("button", { name: "Accept" }) });
  await proposal.waitFor();

  for (const viewport of [
    { width: 1440, height: 900, name: "1440x900" },
    { width: 720, height: 800, name: "720x800" }
  ]) {
    await page.setViewportSize(viewport);
    const actions = await page.locator(".revision-inline-actions").boundingBox();
    const workspace = await page.locator(".ai-workspace").boundingBox();
    if (!actions || !workspace || actions.y + actions.height > workspace.y + workspace.height + 1) {
      throw new Error("Revision actions are obscured at " + viewport.name);
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    if (overflow) throw new Error("Revision diff causes horizontal page overflow at " + viewport.name);
    const browserName = page.context().browser()?.browserType().name() || "browser";
    const browserSuffix = browserName === "chromium" ? "" : "-" + browserName;
    await page.screenshot({ path: "output/playwright/workspace-revise-diff-" + viewport.name + browserSuffix + ".png", fullPage: true });
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  const reject = page.getByRole("button", { name: "Reject" });
  await reject.click();
  await page.getByRole("textbox", { name: "Revision message" }).waitFor();
  await page.unroute("**/api/projects/*/revisions");
  await page.unroute("**/api/projects/*/change-sets/revise-e2e/reject");
}'

run_code '
async (page) => {
  const projectId = page.url().split("/").pop();
  const apiRoot = "http://127.0.0.1:3213/api/projects/" + projectId;
  const timestamp = new Date().toISOString();
  const outline = [
    { path: "main.tex", title: "Abstract", purpose: "Summarize the security problem and evidence." },
    { path: "main.tex", title: "Introduction", purpose: "State the gap and contributions." },
    { path: "sections/method.tex", title: "Method", purpose: "Define the design and trust boundary." },
    { path: "main.tex", title: "Evaluation", purpose: "Plan security and performance evidence." },
    { path: "main.tex", title: "Conclusion", purpose: "Bound the claims and limitations." }
  ];
  let plan;
  let changeSet;

  await page.route("**/api/projects/*/drafts", async route => {
    if (route.request().method() === "GET") return route.fallback();
    const request = route.request().postDataJSON();
    plan = {
      id: "draft-plan-e2e",
      projectId,
      agentRunId: "run-draft-e2e",
      status: "proposed",
      request,
      outline,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ run: { id: "run-draft-e2e" }, plan })
    });
  });

  await page.route("**/api/projects/*/drafts/draft-plan-e2e/confirm", async route => {
    const main = await (await page.request.get(apiRoot + "/file?path=main.tex")).json();
    const method = await (await page.request.get(apiRoot + "/file?path=sections%2Fmethod.tex")).json();
    const generatedMain = "\\documentclass{article}\n\\begin{document}\n\\begin{abstract}A bounded security claim.\\end{abstract}\n\\section{Introduction}We state the problem and contributions.\n\\section{Method}We define the trust boundary.\n\\section{Evaluation}TODO: add measured evidence.\n\\section{Conclusion}Claims remain scoped to the threat model.\n\\end{document}";
    const generatedMethod = "\\section{Method Details}\nThe design excludes compromised endpoints from its trust boundary.";
    const changes = [
      { path: "main.tex", before: main.content, after: generatedMain, baseVersion: main.file.version },
      { path: "sections/method.tex", before: method.content, after: generatedMethod, baseVersion: method.file.version }
    ].map((change, index) => ({
      ...change,
      from: 0,
      to: change.before.length,
      hunks: [{ id: "draft-hunk-" + index, from: 0, to: change.before.length, before: change.before, after: change.after, status: "pending" }]
    }));
    changeSet = {
      id: "draft-change-e2e",
      projectId,
      agentRunId: "run-draft-e2e",
      status: "proposed",
      summary: "Generate a minimal security paper draft",
      rationale: "Apply the Security Top-4 section contract.",
      changes,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    plan = { ...plan, status: "waiting-approval", changeSetId: changeSet.id, updatedAt: new Date().toISOString() };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ run: { id: "run-draft-e2e" }, plan, changeSet })
    });
  });

  await page.route("**/api/projects/*/change-sets/draft-change-e2e/accept", async route => {
    for (const change of changeSet.changes) {
      const opened = await (await page.request.get(apiRoot + "/file?path=" + encodeURIComponent(change.path))).json();
      const saved = await page.request.put(apiRoot + "/file?path=" + encodeURIComponent(change.path), {
        data: { content: change.after, baseVersion: opened.file.version }
      });
      if (!saved.ok()) throw new Error("Could not apply the Draft E2E fixture");
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...changeSet, status: "accepted", updatedAt: new Date().toISOString() })
    });
  });

  await page.getByRole("button", { name: "Agent" }).click();
  const agentPanel = page.getByRole("region", { name: "Agent workspace" });
  await agentPanel.waitFor();
  await agentPanel.getByLabel("What should Agent do?").fill("/draft Create an initial paper outline for a bounded endpoint defense.");
  await page.screenshot({ path: "output/playwright/workspace-agent-composer.png", fullPage: true });
  await agentPanel.getByRole("button", { name: "Back to Revise" }).click();
  await page.unroute("**/api/projects/*/drafts");
  await page.unroute("**/api/projects/*/drafts/draft-plan-e2e/confirm");
  await page.unroute("**/api/projects/*/change-sets/draft-change-e2e/accept");
}'

run_code '
async (page) => {
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  const agentPanel = page.getByRole("region", { name: "Agent workspace" });
  await agentPanel.waitFor();
  await agentPanel.getByLabel("What should Agent do?").fill("Inspect cancellation behavior without creating changes");
  await agentPanel.getByRole("button", { name: "Back to Revise" }).click();
}'

run_code '
async (page) => {
  const projectId = page.url().split("/").pop();
  const apiRoot = "http://127.0.0.1:3213/api/projects/" + projectId;
  const project = await (await page.request.get(apiRoot)).json();
  const opened = await (await page.request.get(apiRoot + "/file?path=main.tex")).json();
  const timestamp = new Date().toISOString();
  let memory = null;
  let report = null;
  let reviewRunning = false;
  let taskRun = null;
  let taskPlan = null;
  let resolution = null;
  let revisionChangeSet = null;

  await page.route("**/api/projects/*/memory**", async route => {
    const url = route.request().url();
    const method = route.request().method();
    if (method === "GET" && url.endsWith("/memory")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(memory) });
      return;
    }
    if (method === "POST" && url.endsWith("/memory/extract")) {
      memory = {
        id: "memory-e2e-v1", projectId, version: 1, projectVersion: project.version,
        items: [{
          id: "memory-item-e2e", category: "threat-model", label: "Trust boundary",
          content: "Compromised endpoints are outside the trusted computing base.", status: "suggested",
          sources: [{ path: "sections/method.tex", line: 2, section: "Method Details", excerpt: "The design excludes compromised endpoints from its trust boundary.", fileVersion: opened.file.version }],
          createdAt: timestamp, updatedAt: timestamp
        }],
        createdAt: timestamp, updatedAt: timestamp
      };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(memory) });
      return;
    }
    if (method === "PATCH" && url.includes("/memory/items/")) {
      memory = { ...memory, id: "memory-e2e-v2", version: 2, items: memory.items.map(item => ({ ...item, status: "confirmed", updatedAt: new Date().toISOString() })), updatedAt: new Date().toISOString() };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(memory) });
      return;
    }
    await route.fallback();
  });

  await page.getByRole("button", { name: "Memory" }).click();
  const memoryDialog = page.getByRole("dialog", { name: "Paper Memory" });
  await memoryDialog.getByRole("button", { name: "Generate Memory" }).click();
  await memoryDialog.getByLabel("Label for Trust boundary").waitFor();
  await memoryDialog.getByRole("button", { name: "Confirm" }).click();
  await memoryDialog.getByText("confirmed", { exact: true }).waitFor();
  const browserName = page.context().browser()?.browserType().name() || "browser";
  const browserSuffix = browserName === "chromium" ? "" : "-" + browserName;
  await page.screenshot({ path: "output/playwright/workspace-memory-1440x900" + browserSuffix + ".png", fullPage: true });
  await memoryDialog.locator(".memory-sources button").click();
  await page.getByRole("textbox", { name: "Source editor for sections/method.tex" }).waitFor();

  await page.route("**/api/projects/*/reviews", async route => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(report ? [report] : []) });
      return;
    }
    reviewRunning = true;
    await page.waitForTimeout(1400);
    const issue = {
      id: "issue-e2e", reportId: "review-e2e", category: "threat-model", severity: "major", priority: 200,
      title: "Threat-model boundary needs explicit evidence",
      rationale: "The claim is not tied to an explicit attacker capability boundary.",
      impact: "Readers cannot determine which security guarantee is supported.",
      suggestion: "State excluded endpoint compromise and connect it to the evaluation.",
      evidence: [{ path: "main.tex", section: "Method", line: 4, excerpt: "We define the trust boundary.", inferred: false }],
      status: "open", source: "agent", createdAt: timestamp, updatedAt: timestamp,
      history: [{ id: "history-e2e", action: "created", reason: "Created by Security Review Agent", actor: "agent", createdAt: timestamp }]
    };
    report = {
      id: "review-e2e", projectId, agentRunId: "review-run-e2e", snapshotId: "snapshot-e2e",
      overallAssessment: "Promising design with a correctable threat-model gap.", recommendation: "borderline",
      strengths: ["Clear deployment objective"], weaknesses: ["Trust assumptions need stronger evidence"],
      nextSteps: ["Resolve the threat-model issue and re-run the focused review"], issues: [issue], createdAt: timestamp
    };
    const reviewRun = { id: "review-run-e2e", projectId, type: "review", status: "completed", objective: "Review paper", skill: project.skill, createdAt: timestamp, updatedAt: timestamp };
    const snapshot = { id: "snapshot-e2e", projectId, projectVersion: project.version, mainDocument: "main.tex", skill: project.skill, files: [{ path: "main.tex", version: opened.file.version, digest: "e2e" }], memoryVersion: 2, sourceOnly: false, createdAt: timestamp };
    reviewRunning = false;
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ run: reviewRun, snapshot, report }) });
  });

  await page.route("**/api/projects/*/agent-runs", async route => {
    const progressRun = { id: "review-run-e2e", projectId, type: "review", status: "running", objective: "Review paper", skill: project.skill, createdAt: timestamp, updatedAt: timestamp, steps: [{ id: "snapshot", label: "Freeze paper snapshot", status: "completed" }, { id: "evidence", label: "Collect section evidence", status: "running" }, { id: "synthesis", label: "Synthesize and deduplicate issues", status: "pending" }] };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(reviewRunning ? [progressRun] : taskRun ? [taskRun] : []) });
  });
  await page.route("**/api/projects/*/issue-resolutions", async route => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(resolution ? [resolution] : []) });
  });
  await page.route("**/api/projects/*/agent-tasks", async route => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(taskPlan ? [taskPlan] : []) });
      return;
    }
    const request = route.request().postDataJSON();
    if (JSON.stringify(request.issueIds) !== JSON.stringify(["issue-e2e"])) throw new Error("Revision was not linked to the Review Issue");
    taskRun = { id: "revision-run-e2e", projectId, type: "agent", status: "waiting-approval", objective: request.objective, skill: project.skill, memoryVersion: 2, createdAt: timestamp, updatedAt: timestamp, auditTrail: [{ id: "audit-e2e", action: "context-read", summary: "Read 1 source file", paths: ["main.tex"], createdAt: timestamp }] };
    taskPlan = { id: "revision-plan-e2e", projectId, agentRunId: taskRun.id, status: "proposed", request, steps: ["Clarify the attacker boundary", "Connect the claim to evaluation evidence"], affectedFiles: ["main.tex"], risks: ["Do not overclaim endpoint compromise resistance"], validation: ["Compile with browser WASM", "Run targeted re-review"], createdAt: timestamp, updatedAt: timestamp };
    resolution = { id: "resolution-e2e", projectId, issueIds: ["issue-e2e"], reviewSnapshotIds: ["snapshot-e2e"], agentRunId: taskRun.id, baseProjectVersion: project.version, memoryVersion: 2, skill: project.skill, status: "planned", createdAt: timestamp, updatedAt: timestamp };
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ run: taskRun, plan: taskPlan, resolution }) });
  });
  await page.route("**/api/projects/*/agent-tasks/revision-plan-e2e/confirm", async route => {
    const before = (await (await page.request.get(apiRoot + "/file?path=main.tex")).json()).content;
    const after = before.replace("We define the trust boundary.", "We exclude compromised endpoints from the trusted computing base and evaluate guarantees only within this boundary.");
    revisionChangeSet = {
      id: "revision-change-e2e", projectId, agentRunId: taskRun.id, status: "proposed",
      summary: "Clarify the threat-model boundary", rationale: "Resolve the selected Security Top-4 Review Issue.",
      changes: [{ path: "main.tex", from: 0, to: before.length, before, after, baseVersion: (await (await page.request.get(apiRoot + "/file?path=main.tex")).json()).file.version,
        hunks: [{ id: "revision-hunk-e2e", from: 0, to: before.length, before, after, status: "pending", rationale: "Make the claim match the explicit attacker model.", evidence: [{ issueId: "issue-e2e", issueTitle: "Threat-model boundary needs explicit evidence", path: "main.tex", line: 4, excerpt: "We define the trust boundary.", inferred: false }] }]
      }], createdAt: timestamp, updatedAt: timestamp
    };
    taskPlan = { ...taskPlan, status: "waiting-approval", changeSetId: revisionChangeSet.id, updatedAt: new Date().toISOString() };
    resolution = { ...resolution, status: "in-revision", changeSetId: revisionChangeSet.id, updatedAt: new Date().toISOString() };
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ run: taskRun, plan: taskPlan, changeSet: revisionChangeSet, resolution }) });
  });
  await page.route("**/api/projects/*/change-sets/revision-change-e2e/accept", async route => {
    const latest = await (await page.request.get(apiRoot + "/file?path=main.tex")).json();
    const saved = await page.request.put(apiRoot + "/file?path=main.tex", { data: { content: revisionChangeSet.changes[0].after, baseVersion: latest.file.version } });
    if (!saved.ok()) throw new Error("Could not apply the P1 Revision fixture");
    const savedBody = await saved.json();
    revisionChangeSet = { ...revisionChangeSet, status: "accepted", changes: revisionChangeSet.changes.map(change => ({ ...change, appliedVersion: savedBody.file.version, hunks: change.hunks.map(hunk => ({ ...hunk, status: "accepted" })) })), updatedAt: new Date().toISOString() };
    taskPlan = { ...taskPlan, status: "accepted", acceptedProjectVersion: savedBody.projectVersion, updatedAt: new Date().toISOString() };
    taskRun = { ...taskRun, status: "completed", updatedAt: new Date().toISOString() };
    resolution = { ...resolution, status: "needs-review", acceptedProjectVersion: savedBody.projectVersion, updatedAt: new Date().toISOString() };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(revisionChangeSet) });
  });
  await page.route("**/api/projects/*/change-sets/revision-change-e2e", async route => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const edited = route.request().postDataJSON().changes[0];
    const current = revisionChangeSet.changes.find(change => change.path === edited.path);
    if (!current) throw new Error("Manual proposal edit targeted an unknown file");
    revisionChangeSet = { ...revisionChangeSet, changes: revisionChangeSet.changes.map(change => change.path !== edited.path ? change : { ...change, after: edited.after, hunks: [{ id: "revision-hunk-edited-e2e", from: 0, to: change.before.length, before: change.before, after: edited.after, status: "pending" }] }), updatedAt: new Date().toISOString() };
    taskRun = { ...taskRun, auditTrail: [...(taskRun.auditTrail || []), { id: "audit-edit-e2e", action: "proposal-edited", summary: "Edited 1 proposed file before approval", paths: [edited.path], createdAt: new Date().toISOString() }] };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(revisionChangeSet) });
  });
  await page.route("**/api/projects/*/issue-resolutions/resolution-e2e/rereview", async route => {
    resolution = { ...resolution, status: "resolved", compileRecordId: "compile-e2e", rereviewAssessment: "The revised text now states the attacker boundary and introduces no obvious regression.", issueAssessments: [{ issueId: "issue-e2e", resolved: true, assessment: "Explicitly bounded and compilable." }], regressions: [], updatedAt: new Date().toISOString() };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(resolution) });
  });

  await page.getByRole("button", { name: "Review", exact: true }).click();
  const reviewDialog = page.getByRole("dialog", { name: "Paper Review" });
  await reviewDialog.getByRole("button", { name: "Review paper" }).click();
  await reviewDialog.locator(".review-run-progress li").filter({ hasText: "Collect section evidence" }).waitFor();
  await reviewDialog.getByText("Threat-model boundary needs explicit evidence", { exact: true }).waitFor();
  await page.screenshot({ path: "output/playwright/workspace-review-1440x900" + browserSuffix + ".png", fullPage: true });
  await reviewDialog.getByRole("article").getByRole("button", { name: "Revise locally", exact: true }).click();
  const localRevision = page.getByRole("textbox", { name: "Revision message" });
  await reviewDialog.waitFor({ state: "hidden" });
  await page.waitForFunction(() => (document.querySelector("textarea[aria-label=\"Revision message\"]")?.value || "").includes("Threat-model boundary needs explicit evidence"));
  await localRevision.focus();
  if (await page.locator(".source-editor .fastwrite-monaco-selection").count() < 1) throw new Error("Review evidence did not remain selected while Revise had focus");
  await page.getByRole("button", { name: "Review", exact: true }).click();
  const reopenedReview = page.getByRole("dialog", { name: "Paper Review" });
  await reopenedReview.getByRole("article").getByRole("button", { name: "Fix with Agent", exact: true }).click();

  const revisionPanel = page.getByRole("region", { name: "Agent workspace" });
  await revisionPanel.waitFor();
  await revisionPanel.getByRole("button", { name: "Create plan" }).click();
  await revisionPanel.getByText("Clarify the attacker boundary", { exact: true }).waitFor();
  await revisionPanel.getByRole("button", { name: "Confirm plan" }).click();
  const hunkEvidence = revisionPanel.locator(".hunk-evidence");
  await hunkEvidence.waitFor();
  if (!(await hunkEvidence.textContent()).includes("Make the claim match the explicit attacker model.")) throw new Error("Revision Diff omitted its Issue rationale");
  await page.screenshot({ path: "output/playwright/workspace-revision-evidence-1440x900" + browserSuffix + ".png", fullPage: true });
  await revisionPanel.getByRole("button", { name: "Edit proposal" }).click();
  const proposalEditor = revisionPanel.getByLabel("Editable proposal for main.tex");
  await proposalEditor.fill(revisionChangeSet.changes[0].after.replace("evaluate guarantees only within this boundary", "evaluate guarantees only within this explicitly stated boundary"));
  await page.screenshot({ path: "output/playwright/workspace-revision-manual-edit-1440x900" + browserSuffix + ".png", fullPage: true });
  await revisionPanel.getByRole("button", { name: "Save proposal" }).click();
  await revisionPanel.locator(".hunk-card").waitFor();
  await revisionPanel.getByRole("button", { name: "Accept changes" }).click();
  await revisionPanel.getByText("needs review", { exact: true }).waitFor();
  await revisionPanel.getByRole("button", { name: "Compile current version" }).click();
  await page.getByText("Compiled successfully", { exact: true }).waitFor({ timeout: 30000 });
  const rereview = revisionPanel.getByRole("button", { name: "Targeted re-review" });
  await rereview.waitFor();
  await rereview.click();
  await revisionPanel.getByText("resolved", { exact: true }).waitFor();
  await page.screenshot({ path: "output/playwright/workspace-revision-resolved-1440x900" + browserSuffix + ".png", fullPage: true });
  await revisionPanel.getByRole("button", { name: "Done" }).click();

  await page.unroute("**/api/projects/*/memory**");
  await page.unroute("**/api/projects/*/reviews");
  await page.unroute("**/api/projects/*/agent-runs");
  await page.unroute("**/api/projects/*/issue-resolutions");
  await page.unroute("**/api/projects/*/agent-tasks");
  await page.unroute("**/api/projects/*/agent-tasks/revision-plan-e2e/confirm");
  await page.unroute("**/api/projects/*/change-sets/revision-change-e2e");
  await page.unroute("**/api/projects/*/change-sets/revision-change-e2e/accept");
  await page.unroute("**/api/projects/*/issue-resolutions/resolution-e2e/rereview");
}'

run_code '
async (page) => {
  let completionRequests = 0;
  const projectId = page.url().split("/").pop();
  const fileUrl = "http://127.0.0.1:3213/api/projects/" + projectId + "/file?path=main.tex";
  await page.route("**/api/projects/*/completions", async route => {
    completionRequests += 1;
    const request = route.request().postDataJSON();
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ ...request, suggestion: " This claim is scoped to the stated attacker model." }) });
  });
  await page.locator("span[title=\"main.tex\"]").click();
  const editor = page.getByRole("textbox", { name: "Source editor for main.tex" });
  await editor.waitFor();
  const current = (await (await page.request.get(fileUrl)).json()).content;
  const typingStarted = Date.now();
  await editor.focus();
  await editor.press("ControlOrMeta+A");
  await page.keyboard.insertText(current.replace("\\end{document}", "A final security claim.\n\\end{document}"));
  const typingLatency = Date.now() - typingStarted;
  if (typingLatency > 500) throw new Error("Completion integration blocked normal editor input for " + typingLatency + "ms");
  await page.waitForTimeout(350);
  if (completionRequests !== 0) throw new Error("Completion request ignored the input debounce window");
  const preview = page.getByRole("status", { name: "Writing completion preview" });
  await preview.waitFor({ timeout: 5000 });
  const browserName = page.context().browser()?.browserType().name() || "browser";
  const browserSuffix = browserName === "chromium" ? "" : "-" + browserName;
  await page.screenshot({ path: "output/playwright/workspace-completion-1440x900" + browserSuffix + ".png", fullPage: true });
  await editor.press("Tab");
  await page.getByText("Undo completion", { exact: true }).waitFor();
  await page.getByText("Saved", { exact: true }).waitFor();
  let acceptedContent = "";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    acceptedContent = (await (await page.request.get(fileUrl)).json()).content;
    if (acceptedContent.includes("This claim is scoped to the stated attacker model.")) break;
    await page.waitForTimeout(100);
  }
  if (!acceptedContent.includes("This claim is scoped to the stated attacker model.")) throw new Error("Accepted completion was not saved through the Workspace API");
  const metrics = await page.evaluate(() => JSON.parse(localStorage.getItem("fastwrite.completion.metrics.v1") || "{}"));
  if (!metrics.suggested || !metrics.accepted || Object.values(metrics).some(value => typeof value !== "number")) throw new Error("Completion metrics were not privacy-safe counters");

  const toggle = page.getByRole("checkbox", { name: "Complete" });
  await page.locator(".completion-switch").click();
  if (await toggle.isChecked()) throw new Error("Completion toggle did not switch off");
  const beforeDisabledEdit = completionRequests;
  const disabledValue = acceptedContent;
  await editor.focus();
  await editor.press("ControlOrMeta+A");
  await page.keyboard.insertText(disabledValue.replace("\\end{document}", "No background completion should run.\n\\end{document}"));
  await page.waitForTimeout(1800);
  if (completionRequests !== beforeDisabledEdit) throw new Error("Disabled completion still made a background request");
  await page.unroute("**/api/projects/*/completions");
}'

run_code '
async (page) => {
  const openStarted = Date.now();
  await page.locator("span[title=\"large-notes.md\"]").click();
  const editor = page.getByRole("textbox", { name: "Source editor for large-notes.md" });
  await editor.waitFor({ timeout: 5000 });
  if (Date.now() - openStarted > 2500) throw new Error("Large file blocked the workspace while opening");
  await editor.focus();
  await editor.press("ControlOrMeta+End");
  const editStarted = Date.now();
  await editor.pressSequentially("x");
  if (Date.now() - editStarted > 500) throw new Error("Large file blocked normal editor input");
}
'

run_code '
async (page) => {
  await page.locator("span[title=\"main.tex\"]").click();
  const editor = page.getByRole("textbox", { name: "Source editor for main.tex" });
  await editor.waitFor();
  await editor.focus();
  await editor.press("ControlOrMeta+A");
  await page.keyboard.insertText("\\documentclass{article}\n\\begin{document}\n\\undefinedFastWriteCommand\n\\end{document}");
  const diagnostics = page.locator(".pdf-diagnostics");
  await diagnostics.waitFor({ timeout: 30000 });
  const errorIcon = page.locator(".compile-status-icon--error");
  await errorIcon.waitFor();
  if (await errorIcon.getAttribute("aria-label") !== "Compilation error") throw new Error("Compilation failure does not expose an unambiguous error icon");
  if (!await diagnostics.getByText(/LaTeX diagnostics|Compilation log/).isVisible()) {
    throw new Error("Compilation failure did not expose diagnostics or its log");
  }
  if (await page.locator(".react-pdf__Page__canvas").count() < 1) {
    throw new Error("Previous PDF disappeared after a failed compile");
  }
  const toolbarBox = await page.locator(".pdf-toolbar").boundingBox();
  if (!toolbarBox || toolbarBox.height !== 35) throw new Error("PDF toolbar changed size in the failure state");
  for (const viewport of [
    { width: 1440, height: 900, name: "1440x900" },
    { width: 1280, height: 800, name: "1280x800" },
    { width: 720, height: 800, name: "720x800" }
  ]) {
    await page.setViewportSize(viewport);
    const browserName = page.context().browser()?.browserType().name() || "browser";
    const browserSuffix = browserName === "chromium" ? "" : "-" + browserName;
    await page.screenshot({ path: "output/playwright/workspace-pdf-error-" + viewport.name + browserSuffix + ".png", fullPage: true });
  }
}'
run_accessibility

run_code '
async (page) => {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1280, height: 800 },
    { width: 720, height: 800 }
  ]) {
    await page.setViewportSize(viewport);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    if (overflow) throw new Error("Page-level horizontal overflow at " + viewport.width + "x" + viewport.height);
  }
}'

run_code '
async (page) => {
  const errors = [];
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.reload();
  await page.waitForLoadState("networkidle");
  if (errors.length) throw new Error(errors.join("\n"));
}'

run_code '
async (page) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("http://127.0.0.1:3213/projects");
  const projects = await (await page.request.get("http://127.0.0.1:3213/api/projects")).json();
  const imported = {
    ...projects[0],
    name: "Imported Security Paper",
    source: {
      type: "github",
      repository: "https://github.com/example/security-paper",
      ref: "camera-ready",
      commit: "0123456789abcdef0123456789abcdef01234567"
    }
  };
  let requestBody;
  await page.route("**/api/project-imports/github", async route => {
    requestBody = route.request().postDataJSON();
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(imported) });
  });
  await page.getByRole("main").getByRole("button", { name: "Import paper", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Import a paper" });
  await dialog.getByRole("tab", { name: "GitHub repository" }).click();
  await dialog.getByLabel("Repository URL").fill("https://github.com/example/security-paper");
  await dialog.getByLabel(/Branch, tag or commit/).fill("camera-ready");
  await dialog.getByLabel(/Project name/).fill("Imported Security Paper");
  await dialog.getByLabel(/Main document/).fill("paper.tex");
  await dialog.getByLabel("Writing profile").selectOption("security-top4");
  await page.waitForTimeout(350);
  await page.addScriptTag({ path: "node_modules/axe-core/axe.min.js" });
  const accessibility = await page.evaluate(async () => await window.axe.run(document, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] }
  }));
  const violations = accessibility.violations.filter(item => item.impact === "critical" || item.impact === "serious");
  if (violations.length) {
    throw new Error(violations.map(item => item.id + ": " + item.nodes.map(node => node.target.join(" ")).join(", ")).join("\n"));
  }
  await dialog.getByRole("button", { name: "Import paper", exact: true }).click();
  await page.waitForURL(new RegExp("/projects/" + imported.id + "$"));
  await page.getByRole("textbox", { name: "Source editor for main.tex" }).waitFor();
  const expected = {
    repository: "https://github.com/example/security-paper",
    ref: "camera-ready",
    name: "Imported Security Paper",
    mainDocument: "paper.tex",
    venue: "security-top4"
  };
  if (JSON.stringify(requestBody) !== JSON.stringify(expected)) {
    throw new Error("Unexpected GitHub import payload: " + JSON.stringify(requestBody));
  }
  await page.unroute("**/api/project-imports/github");
}'

echo "FastWrite browser smoke test passed"
