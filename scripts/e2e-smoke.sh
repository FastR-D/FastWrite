#!/bin/sh
set -eu

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
QA_DATA=$(mktemp -d "${TMPDIR:-/tmp}/fastwrite-e2e.XXXXXX")
E2E_BROWSER=${FASTWRITE_E2E_BROWSER:-chrome}
E2E_PORT=${FASTWRITE_E2E_PORT:-3213}
E2E_SERVER_BIN=${FASTWRITE_E2E_SERVER_BIN:-}
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
if [ -n "$E2E_SERVER_BIN" ]; then
  FASTWRITE_DATA_DIR="$QA_DATA" FASTWRITE_PORT="$E2E_PORT" "$E2E_SERVER_BIN" >"$QA_DATA/server.log" 2>&1 &
else
  FASTWRITE_DATA_DIR="$QA_DATA" FASTWRITE_PORT="$E2E_PORT" bun apps/server/src/server.ts >"$QA_DATA/server.log" 2>&1 &
fi
SERVER_PID=$!

attempt=0
until curl --fail --silent "http://127.0.0.1:$E2E_PORT/projects" >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo "FastWrite E2E servers did not become ready" >&2
    exit 1
  fi
  sleep 0.25
done

pw open "http://127.0.0.1:$E2E_PORT/projects" --browser "$E2E_BROWSER"
run_accessibility

run_code '
async (page) => {
  await page.getByRole("button", { name: "New paper" }).click();
  await page.getByRole("textbox", { name: "Project name" }).fill("E2E Smoke Paper");
  await page.getByRole("button", { name: "Create paper" }).click();
  await page.waitForURL(/\/projects\/paper_/);
  const projectId = page.url().split("/").pop();
  const apiRoot = page.url().replace(/\/projects\/.*$/, "") + "/api/projects/" + projectId;
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
  await page.getByRole("button", { name: "Locate editor selection in PDF" }).click();
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
  await page.getByRole("button", { name: "Review", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Paper Review" });
  await dialog.getByRole("button", { name: "Compact review window" }).click();
  const compact = await dialog.boundingBox();
  await dialog.getByRole("button", { name: "Wide review window" }).click();
  const wide = await dialog.boundingBox();
  await dialog.getByRole("button", { name: "Fullscreen review window" }).click();
  const fullscreen = await dialog.boundingBox();
  if (!compact || !wide || !fullscreen || !(compact.width < wide.width && wide.width < fullscreen.width) || fullscreen.height <= wide.height) {
    throw new Error("Paper Review size controls did not produce compact, wide, and fullscreen layouts");
  }
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
}
'

run_code '
async (page) => {
  await page.locator("span[title=\"main.tex\"]").click();
  const editor = page.getByRole("textbox", { name: "Source editor for main.tex" });
  await editor.waitFor();
  const projectId = page.url().split("/").pop();
  const fileUrl = page.url().replace(/\/projects\/.*$/, "") + "/api/projects/" + projectId + "/file?path=main.tex";
  const opened = await (await page.request.get(fileUrl)).json();
  const marker = "% Saved immediately by the global FastWrite shortcut";
  const content = opened.content.replace("\\end{document}", marker + "\n\\end{document}");
  await page.evaluate(() => {
    window.__fastwriteSavePrevented = false;
    window.addEventListener("keydown", event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        window.__fastwriteSavePrevented = event.defaultPrevented;
      }
    }, { capture: true });
  });
  await editor.focus();
  await editor.press("ControlOrMeta+A");
  await page.keyboard.insertText(content);
  const agentButton = page.getByRole("button", { name: "Agent", exact: true });
  await agentButton.focus();
  if (await page.evaluate(() => document.activeElement?.textContent?.trim()) !== "Agent") {
    throw new Error("Could not move focus outside the editor before testing the global save shortcut");
  }
  await agentButton.press("ControlOrMeta+s");
  const prevented = await page.evaluate(() => window.__fastwriteSavePrevented);
  if (!prevented) throw new Error("Ctrl/Cmd-S did not prevent the browser Save Page action");
  let saved;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    saved = await (await page.request.get(fileUrl)).json();
    if (saved.content.includes(marker)) break;
    await page.waitForTimeout(50);
  }
  if (!saved?.content.includes(marker) || saved.file.version <= opened.file.version) {
    throw new Error("Global Ctrl/Cmd-S did not immediately save a new paper version through the Workspace API");
  }
  await page.getByText("Saved", { exact: true }).waitFor();
  await page.locator("span[title=\"sections/method.tex\"]").click();
  await page.getByRole("textbox", { name: "Source editor for sections/method.tex" }).waitFor();
}
'

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
  const apiRoot = page.url().replace(/\/projects\/.*$/, "") + "/api/projects/" + projectId;
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
      rationale: "Apply the selected research-domain and venue contract.",
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

  const agentTimestamp = new Date().toISOString();
  let agentPlan;
  let agentChangeSet;
  let agentRun = {
    id: "run-agent-review-e2e",
    projectId,
    type: "agent",
    status: "waiting-approval",
    objective: "Refine the paper one file at a time",
    skill: { id: "network-information-security", name: "网络与信息安全", version: "2.0.0", venue: "network-information-security" },
    steps: [],
    auditTrail: [],
    createdAt: agentTimestamp,
    updatedAt: agentTimestamp
  };
  const materializeAgentChange = change => {
    let content = change.baseContent;
    for (const hunk of [...change.hunks].sort((left, right) => right.from - left.from)) {
      if (hunk.status === "accepted") content = content.slice(0, hunk.from) + hunk.after + content.slice(hunk.to);
    }
    return content;
  };
  const completeAgentProposal = change => materializeAgentChange({ ...change, hunks: change.hunks.map(hunk => ({ ...hunk, status: "accepted" })) });
  await page.route("**/api/projects/*/agent-tasks", async route => {
    if (route.request().method() === "GET") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(agentPlan ? [agentPlan] : []) });
    await page.waitForTimeout(500);
    agentPlan = {
      id: "agent-plan-review-e2e",
      projectId,
      agentRunId: agentRun.id,
      status: "proposed",
      request: { objective: "Refine the paper one file at a time", scope: { type: "project" }, intent: "revise" },
      intent: "revise",
      steps: ["Refine main.tex", "Refine sections/method.tex"],
      affectedFiles: ["main.tex", "sections/method.tex"],
      risks: [],
      validation: ["Compile the paper"],
      createdAt: agentTimestamp,
      updatedAt: agentTimestamp
    };
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ run: agentRun, plan: agentPlan }) });
  });
  await page.route("**/api/projects/*/agent-tasks/agent-plan-review-e2e/confirm", async route => {
    agentRun = { ...agentRun, status: "running", steps: [
      { id: "agent-generate-1", label: "Process main.tex", status: "completed" },
      { id: "agent-generate-2", label: "Process sections/method.tex", status: "running" }
    ] };
    await page.waitForTimeout(900);
    const main = await (await page.request.get(apiRoot + "/file?path=main.tex")).json();
    const method = await (await page.request.get(apiRoot + "/file?path=sections%2Fmethod.tex")).json();
    const mainClaim = "\\documentclass{article}";
    const mainContribution = "\\input{sections/method}";
    const methodBoundary = "This sentence is mapped from a secondary source file.";
    if (!main.content.includes(mainClaim) || !main.content.includes(mainContribution) || !method.content.includes(methodBoundary)) {
      throw new Error("Agent hunk fixture no longer matches the current E2E paper");
    }
    agentChangeSet = {
      id: "agent-change-review-e2e",
      projectId,
      agentRunId: agentRun.id,
      status: "proposed",
      approvalMode: "explicit-finish",
      summary: "Refine the paper one file at a time",
      rationale: "Bounded per-file generation fixture.",
      changes: [
        {
          operation: "replace", path: "main.tex", from: 0, to: main.content.length, before: main.content,
          after: main.content.replace(mainClaim, "\\documentclass[11pt]{article}").replace(mainContribution, "\\input{sections/method}\n% Reviewed structure"),
          baseVersion: main.file.version, baseContent: main.content, currentVersion: main.file.version,
          hunks: [
            { id: "agent-main-hunk-1", from: main.content.indexOf(mainClaim), to: main.content.indexOf(mainClaim) + mainClaim.length, before: mainClaim, after: "\\documentclass[11pt]{article}", status: "pending" },
            { id: "agent-main-hunk-2", from: main.content.indexOf(mainContribution), to: main.content.indexOf(mainContribution) + mainContribution.length, before: mainContribution, after: "\\input{sections/method}\n% Reviewed structure", status: "pending" }
          ]
        },
        {
          operation: "replace", path: "sections/method.tex", from: 0, to: method.content.length, before: method.content,
          after: method.content.replace(methodBoundary, "This sentence is grounded in a bounded source file."),
          baseVersion: method.file.version, baseContent: method.content, currentVersion: method.file.version,
          hunks: [{ id: "agent-method-hunk-1", from: method.content.indexOf(methodBoundary), to: method.content.indexOf(methodBoundary) + methodBoundary.length, before: methodBoundary, after: "This sentence is grounded in a bounded source file.", status: "pending" }]
        }
      ],
      createdAt: agentTimestamp,
      updatedAt: agentTimestamp
    };
    agentPlan = { ...agentPlan, status: "waiting-approval", changeSetId: agentChangeSet.id };
    agentRun = { ...agentRun, status: "waiting-approval", changeSetId: agentChangeSet.id, steps: agentRun.steps.map(step => ({ ...step, status: "completed" })) };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: agentRun, plan: agentPlan, changeSet: agentChangeSet }) });
  });
  await page.route("**/api/projects/*/change-sets/agent-change-review-e2e", async route => {
    if (route.request().method() === "GET") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(agentChangeSet) });
    if (route.request().method() !== "PATCH") return route.fallback();
    const request = route.request().postDataJSON();
    for (const edit of request.hunks || []) {
      const change = agentChangeSet.changes.find(candidate => candidate.path === edit.path);
      const hunk = change?.hunks.find(candidate => candidate.id === edit.hunkId);
      if (!change || !hunk) throw new Error("Agent hunk edit targeted an unknown hunk");
      if (hunk.status === "accepted") throw new Error("Agent hunk edit unexpectedly targeted an accepted hunk");
      hunk.after = edit.after;
      change.after = completeAgentProposal(change);
    }
    agentRun = { ...agentRun, auditTrail: [...agentRun.auditTrail, { id: "audit-agent-hunk-edit", action: "hunk-edited", summary: "Edited one proposed hunk during review", paths: request.hunks.map(edit => edit.path), createdAt: new Date().toISOString() }] };
    agentChangeSet = { ...agentChangeSet, updatedAt: new Date().toISOString() };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(agentChangeSet) });
  });
  await page.route("**/api/projects/*/change-sets/agent-change-review-e2e/decide", async route => {
    const request = route.request().postDataJSON();
    const nextChanges = JSON.parse(JSON.stringify(agentChangeSet.changes));
    for (const decision of request.decisions) {
      const change = nextChanges.find(candidate => candidate.path === decision.path);
      for (const hunkId of decision.hunkIds) change.hunks.find(hunk => hunk.id === hunkId).status = decision.status;
    }
    const touchedPaths = [...new Set(request.decisions.map(decision => decision.path))];
    const openedFiles = new Map();
    const conflicts = [];
    for (const path of touchedPaths) {
      const currentChange = agentChangeSet.changes.find(change => change.path === path);
      const nextChange = nextChanges.find(change => change.path === path);
      const opened = await (await page.request.get(apiRoot + "/file?path=" + encodeURIComponent(path))).json();
      openedFiles.set(path, opened);
      const matchesExpected = opened.file.version === currentChange.currentVersion && opened.content === materializeAgentChange(currentChange);
      const overwrite = request.overwriteConflicts?.find(candidate => candidate.path === path);
      if (!matchesExpected && overwrite?.currentVersion !== opened.file.version) {
        conflicts.push({ path, currentVersion: opened.file.version, currentContent: opened.content, reviewedContent: materializeAgentChange(nextChange) });
      }
    }
    if (conflicts.length) return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "changeset_conflict_review_required", message: "The workspace changed during review.", details: { changeSetId: agentChangeSet.id, conflicts } } }) });
    for (const path of touchedPaths) {
      const nextChange = nextChanges.find(change => change.path === path);
      const opened = openedFiles.get(path);
      const reviewedContent = materializeAgentChange(nextChange);
      if (reviewedContent !== opened.content) {
        const saved = await page.request.put(apiRoot + "/file?path=" + encodeURIComponent(path), { data: { content: reviewedContent, baseVersion: opened.file.version } });
        if (!saved.ok()) throw new Error("Could not apply an Agent hunk decision fixture");
        const savedBody = await saved.json();
        nextChange.currentVersion = savedBody.file.version;
        if (nextChange.hunks.some(hunk => hunk.status === "accepted")) nextChange.appliedVersion = savedBody.file.version;
      }
    }
    agentChangeSet = { ...agentChangeSet, changes: nextChanges, status: "partially-accepted", updatedAt: new Date().toISOString() };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(agentChangeSet) });
  });
  await page.route("**/api/projects/*/change-sets/agent-change-review-e2e/finish", async route => {
    if (agentChangeSet.changes.some(change => change.hunks.some(hunk => hunk.status === "pending"))) return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { message: "Pending hunks remain" } }) });
    const accepted = agentChangeSet.changes.some(change => change.hunks.some(hunk => hunk.status === "accepted"));
    agentChangeSet = { ...agentChangeSet, status: accepted ? "accepted" : "rejected", reviewFinishedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    agentPlan = { ...agentPlan, status: accepted ? "accepted" : "cancelled", updatedAt: new Date().toISOString() };
    agentRun = { ...agentRun, status: "completed" };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(agentChangeSet) });
  });
  await page.route("**/api/projects/*/agent-runs", async route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([agentRun]) }));
  await page.route("**/api/projects/*/issue-resolutions", async route => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));

  await page.getByRole("button", { name: "Agent" }).click();
  const agentPanel = page.getByRole("region", { name: "Agent workspace" });
  await agentPanel.waitFor();
  const objective = agentPanel.getByLabel("What should Agent do?");
  const commandButtons = ["/draft", "/continue", "/revise"].map(label => agentPanel.getByRole("button", { name: label, exact: true }));
  const commandBoxes = await Promise.all(commandButtons.map(button => button.boundingBox()));
  const commandContainer = await agentPanel.locator(".agent-command-buttons").boundingBox();
  const commandWidth = commandBoxes.reduce((total, box) => total + (box?.width || 0), 0);
  if (!commandContainer || commandBoxes.some(box => !box || box.width > 115) || commandContainer.width - commandWidth < 40) throw new Error("Agent command buttons still stretch across the composer");
  await agentPanel.getByRole("button", { name: "/draft", exact: true }).click();
  await objective.fill("/draft Create an initial paper outline for a bounded endpoint defense.");
  await agentPanel.getByRole("button", { name: "/continue", exact: true }).click();
  if (!(await objective.inputValue()).startsWith("/continue Create an initial")) throw new Error("Continue command did not preserve the Agent objective");
  await agentPanel.getByRole("button", { name: "/revise", exact: true }).click();
  if (!(await objective.inputValue()).startsWith("/revise Create an initial")) throw new Error("Revise command did not preserve the Agent objective");
  await agentPanel.getByRole("button", { name: "/draft", exact: true }).click();
  await objective.fill("Refine the paper one file at a time");
  const creatingAgentPlan = agentPanel.getByRole("button", { name: "Create plan", exact: true }).click();
  await agentPanel.getByText("Planning Agent task", { exact: true }).waitFor();
  await creatingAgentPlan;
  const confirmingAgentPlan = agentPanel.getByRole("button", { name: "Confirm plan", exact: true }).click();
  await agentPanel.getByText("Process sections/method.tex", { exact: true }).waitFor();
  await confirmingAgentPlan;
  await agentPanel.getByRole("button", { name: "main.tex: 2 pending, 0 accepted, 0 rejected", exact: true }).waitFor();
  const overviewCounts = agentPanel.locator(".agent-review-overview .review-counts b");
  const overviewLabels = await overviewCounts.allTextContents();
  const overviewColors = await overviewCounts.evaluateAll(nodes => nodes.map(node => getComputedStyle(node).color));
  if (overviewLabels.join("|") !== "Pending 3|Accepted 0|Rejected 0" || new Set(overviewColors).size !== 3) {
    throw new Error("Agent review overview does not show three complete, distinctly colored status totals");
  }
  await agentPanel.getByRole("button", { name: "Reject pending & complete", exact: true }).click();
  const nextAgentObjective = agentPanel.getByLabel("What should Agent do?");
  await nextAgentObjective.waitFor();
  if (await nextAgentObjective.inputValue()) throw new Error("Reject pending & complete carried the rejected objective into the next Agent task");
  await nextAgentObjective.fill("Refine the paper one file at a time");
  await agentPanel.getByRole("button", { name: "Create plan", exact: true }).click();
  await agentPanel.getByRole("button", { name: "Confirm plan", exact: true }).click();
  await agentPanel.getByRole("button", { name: "main.tex: 2 pending, 0 accepted, 0 rejected", exact: true }).waitFor();
  if (await agentPanel.locator(".draft-diff__file .review-counts").count() !== 1) {
    throw new Error("Agent file review repeats the same Pending, Accepted, and Rejected header");
  }
  await agentPanel.getByRole("button", { name: "Reject pending file hunks", exact: true }).click();
  await agentPanel.getByRole("button", { name: "sections/method.tex: 1 pending, 0 accepted, 0 rejected", exact: true }).click();
  await agentPanel.getByRole("button", { name: "Reject pending file hunks", exact: true }).click();
  await agentPanel.getByRole("button", { name: "Complete review", exact: true }).waitFor();
  await agentPanel.getByRole("button", { name: "Leave review", exact: true }).click();
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await agentPanel.getByRole("button", { name: "Complete review", exact: true }).click();
  const composerAfterRestoredComplete = agentPanel.getByLabel("What should Agent do?");
  await composerAfterRestoredComplete.waitFor();
  if (await composerAfterRestoredComplete.inputValue()) throw new Error("Completing a restored Agent review did not open an empty next-task composer");
  await composerAfterRestoredComplete.fill("Refine the paper one file at a time");
  await agentPanel.getByRole("button", { name: "Create plan", exact: true }).click();
  await agentPanel.getByRole("button", { name: "Confirm plan", exact: true }).click();
  await agentPanel.getByRole("button", { name: "main.tex: 2 pending, 0 accepted, 0 rejected", exact: true }).waitFor();
  const fileCounts = agentPanel.locator(".draft-diff__file > header .review-counts b");
  const fileLabels = await fileCounts.allTextContents();
  const fileColors = await fileCounts.evaluateAll(nodes => nodes.map(node => getComputedStyle(node).color));
  if (fileLabels.join("|") !== "Pending 2/2|Accepted 0/2|Rejected 0/2" || new Set(fileColors).size !== 3) {
    throw new Error("Agent file review does not show three complete, distinctly colored status totals");
  }
  await agentPanel.getByRole("button", { name: "Reject", exact: true }).first().click();
  await agentPanel.getByRole("button", { name: "main.tex: 1 pending, 0 accepted, 1 rejected", exact: true }).waitFor();
  const acceptPendingFile = agentPanel.getByRole("button", { name: "Accept pending file hunks", exact: true });
  if (await acceptPendingFile.count() !== 1) {
    await page.screenshot({ path: "output/playwright/workspace-agent-review-after-reject.png", fullPage: true });
    throw new Error("Accept pending file hunks is missing after rejecting one hunk: " + await agentPanel.locator(".hunk-review").innerText());
  }
  await acceptPendingFile.click();
  await agentPanel.getByRole("button", { name: "main.tex: 0 pending, 1 accepted, 1 rejected", exact: true }).waitFor();
  await agentPanel.getByRole("button", { name: "Change to reject", exact: true }).click();
  await agentPanel.getByRole("button", { name: "main.tex: 0 pending, 0 accepted, 2 rejected", exact: true }).waitFor();
  await agentPanel.getByRole("button", { name: "Change to accept", exact: true }).first().click();
  await agentPanel.getByRole("button", { name: "main.tex: 0 pending, 1 accepted, 1 rejected", exact: true }).waitFor();
  await agentPanel.getByRole("button", { name: "sections/method.tex: 1 pending, 0 accepted, 0 rejected", exact: true }).click();
  if (await agentPanel.getByRole("button", { name: "Edit proposal", exact: true }).count()) throw new Error("Agent review still exposes whole-file proposal editing");
  await agentPanel.getByRole("button", { name: "Edit hunk", exact: true }).click();
  const hunkEditor = agentPanel.getByLabel("Edit hunk 1 for sections/method.tex");
  await hunkEditor.fill("This sentence is grounded in bounded and unmanaged evidence.");
  await agentPanel.getByRole("button", { name: "Save hunk", exact: true }).click();
  await agentPanel.getByText("unmanaged", { exact: false }).waitFor();
  await agentPanel.getByRole("button", { name: "Leave review", exact: true }).click();
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await agentPanel.getByRole("button", { name: "sections/method.tex: 1 pending, 0 accepted, 0 rejected", exact: true }).waitFor();
  for (const viewport of [{ width: 1440, height: 900, name: "1440x900" }, { width: 720, height: 800, name: "720x800" }]) {
    await page.setViewportSize(viewport);
    const reviewBox = await agentPanel.locator(".draft-diff").boundingBox();
    const overviewBox = await agentPanel.locator(".agent-review-overview").boundingBox();
    const fileHeaderBox = await agentPanel.locator(".draft-diff__file > header").boundingBox();
    if (!reviewBox || !overviewBox || !fileHeaderBox || overviewBox.x < reviewBox.x || overviewBox.x + overviewBox.width > reviewBox.x + reviewBox.width + 1 || fileHeaderBox.x + fileHeaderBox.width > reviewBox.x + reviewBox.width + 1) {
      throw new Error("Agent review statistics overflow at " + viewport.name);
    }
    await page.screenshot({ path: "output/playwright/workspace-agent-review-" + viewport.name + ".png", fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const methodBeforeConflict = await (await page.request.get(apiRoot + "/file?path=sections%2Fmethod.tex")).json();
  const externalMarker = "% External edit while Agent review is open";
  const externalSave = await page.request.put(apiRoot + "/file?path=sections%2Fmethod.tex", { data: { content: methodBeforeConflict.content + "\n" + externalMarker, baseVersion: methodBeforeConflict.file.version } });
  if (!externalSave.ok()) throw new Error("Could not create the Agent conflict fixture");
  await agentPanel.getByRole("button", { name: "Accept pending & complete", exact: true }).click();
  const conflictDialog = page.getByRole("dialog", { name: "File changed during review" });
  await conflictDialog.waitFor();
  const overwriteDiff = conflictDialog.getByLabel("Overwrite diff for sections/method.tex");
  const removedText = (await overwriteDiff.locator("del").allTextContents()).join("");
  const insertedText = (await overwriteDiff.locator("ins").allTextContents()).join("");
  const compactRemoved = removedText.replace(/\s/g, "");
  const compactInserted = insertedText.replace(/\s/g, "");
  if (!compactRemoved.includes("ExternaleditwhileAgentreviewisopen") || !compactInserted.includes("unmanagedevidence")) {
    throw new Error("Agent conflict review does not compare the current file with the reviewed hunk result: " + JSON.stringify({ removedText, insertedText }));
  }
  for (const viewport of [{ width: 1440, height: 900, name: "1440x900" }, { width: 720, height: 800, name: "720x800" }]) {
    await page.setViewportSize(viewport);
    const dialogBox = await conflictDialog.boundingBox();
    const diffBox = await overwriteDiff.boundingBox();
    const confirmBox = await conflictDialog.getByRole("button", { name: "Overwrite with reviewed result", exact: true }).boundingBox();
    if (!dialogBox || !diffBox || !confirmBox || diffBox.x < dialogBox.x || diffBox.x + diffBox.width > dialogBox.x + dialogBox.width + 1 || confirmBox.y + confirmBox.height > dialogBox.y + dialogBox.height + 1) {
      throw new Error("Agent conflict dialog overlaps or overflows at " + viewport.name);
    }
    await page.screenshot({ path: "output/playwright/workspace-agent-conflict-" + viewport.name + ".png", fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await conflictDialog.getByRole("button", { name: "Overwrite with reviewed result", exact: true }).click();
  const composerAfterAcceptedFinish = agentPanel.getByLabel("What should Agent do?");
  await composerAfterAcceptedFinish.waitFor();
  if (await composerAfterAcceptedFinish.inputValue()) throw new Error("Finishing an accepted Agent review did not open an empty next-task composer");
  const overwrittenMethod = await (await page.request.get(apiRoot + "/file?path=sections%2Fmethod.tex")).json();
  if (!overwrittenMethod.content.includes("unmanaged evidence") || overwrittenMethod.content.includes(externalMarker)) {
    throw new Error("Confirmed Agent overwrite did not apply the reviewed hunk result");
  }
  await page.screenshot({ path: "output/playwright/workspace-agent-composer.png", fullPage: true });
  await page.getByRole("button", { name: "Revise", exact: true }).click();
  await page.unroute("**/api/projects/*/agent-tasks");
  await page.unroute("**/api/projects/*/agent-tasks/agent-plan-review-e2e/confirm");
  await page.unroute("**/api/projects/*/change-sets/agent-change-review-e2e");
  await page.unroute("**/api/projects/*/change-sets/agent-change-review-e2e/decide");
  await page.unroute("**/api/projects/*/change-sets/agent-change-review-e2e/finish");
  await page.unroute("**/api/projects/*/agent-runs");
  await page.unroute("**/api/projects/*/issue-resolutions");
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
  await page.getByRole("button", { name: "Revise", exact: true }).click();
}'

run_code '
async (page) => {
  const projectId = page.url().split("/").pop();
  const apiRoot = page.url().replace(/\/projects\/.*$/, "") + "/api/projects/" + projectId;
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
    if (method === "POST" && url.endsWith("/memory/apply")) {
      memory = { ...memory, id: "memory-e2e-v2", version: 2, items: memory.items.map(item => ({ ...item, status: "confirmed", updatedAt: new Date().toISOString() })), updatedAt: new Date().toISOString() };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(memory) });
      return;
    }
    await route.fallback();
  });

  await page.getByRole("button", { name: "Memory" }).click();
  const memoryDialog = page.getByRole("dialog", { name: "Paper Memory" });
  await memoryDialog.getByRole("button", { name: "Generate Memory" }).click();
  await memoryDialog.getByText("threat-model: Trust boundary", { exact: true }).waitFor();
  await memoryDialog.getByRole("button", { name: "Apply reviewed memory" }).click();
  await memoryDialog.getByText("Reviewed memory is current", { exact: true }).waitFor();
  const browserName = page.context().browser()?.browserType().name() || "browser";
  const browserSuffix = browserName === "chromium" ? "" : "-" + browserName;
  await page.screenshot({ path: "output/playwright/workspace-memory-1440x900" + browserSuffix + ".png", fullPage: true });
  await memoryDialog.getByRole("button", { name: "Close", exact: true }).click();

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
    const after = before.replace("\\end{document}", "We exclude compromised endpoints from the trusted computing base and evaluate guarantees only within this boundary.\n\\end{document}");
    revisionChangeSet = {
      id: "revision-change-e2e", projectId, agentRunId: taskRun.id, status: "proposed", approvalMode: "explicit-finish",
      summary: "Clarify the threat-model boundary", rationale: "Resolve the selected venue Review Issue.",
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
  await page.route("**/api/projects/*/change-sets/revision-change-e2e/decide", async route => {
    const request = route.request().postDataJSON();
    for (const decision of request.decisions) for (const hunkId of decision.hunkIds) revisionChangeSet.changes.find(change => change.path === decision.path).hunks.find(hunk => hunk.id === hunkId).status = decision.status;
    revisionChangeSet = { ...revisionChangeSet, status: "partially-accepted", updatedAt: new Date().toISOString() };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(revisionChangeSet) });
  });
  await page.route("**/api/projects/*/change-sets/revision-change-e2e/finish", async route => {
    const latest = await (await page.request.get(apiRoot + "/file?path=main.tex")).json();
    const saved = await page.request.put(apiRoot + "/file?path=main.tex", { data: { content: revisionChangeSet.changes[0].after, baseVersion: latest.file.version } });
    if (!saved.ok()) throw new Error("Could not apply the finished P1 Revision fixture");
    const savedBody = await saved.json();
    revisionChangeSet = { ...revisionChangeSet, status: "accepted", reviewFinishedAt: new Date().toISOString(), changes: revisionChangeSet.changes.map(change => ({ ...change, appliedVersion: savedBody.file.version, hunks: change.hunks.map(hunk => ({ ...hunk, status: hunk.status === "pending" ? "accepted" : hunk.status })) })), updatedAt: new Date().toISOString() };
    taskPlan = { ...taskPlan, status: "accepted", acceptedProjectVersion: savedBody.projectVersion, updatedAt: new Date().toISOString() };
    taskRun = { ...taskRun, status: "completed", updatedAt: new Date().toISOString() };
    resolution = { ...resolution, status: "needs-review", acceptedProjectVersion: savedBody.projectVersion, updatedAt: new Date().toISOString() };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(revisionChangeSet) });
  });
  await page.route("**/api/projects/*/change-sets/revision-change-e2e", async route => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const edited = route.request().postDataJSON().hunks[0];
    const current = revisionChangeSet.changes.find(change => change.path === edited.path);
    const hunk = current?.hunks.find(candidate => candidate.id === edited.hunkId);
    if (!current || !hunk) throw new Error("Manual hunk edit targeted an unknown hunk");
    hunk.after = edited.after;
    current.after = edited.after;
    revisionChangeSet = { ...revisionChangeSet, updatedAt: new Date().toISOString() };
    taskRun = { ...taskRun, auditTrail: [...(taskRun.auditTrail || []), { id: "audit-edit-e2e", action: "hunk-edited", summary: "Edited 1 proposed hunk during review", paths: [edited.path], createdAt: new Date().toISOString() }] };
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
  await revisionPanel.getByRole("button", { name: "Edit hunk", exact: true }).click();
  const proposalEditor = revisionPanel.getByLabel("Edit hunk 1 for main.tex");
  await proposalEditor.fill(revisionChangeSet.changes[0].after.replace("evaluate guarantees only within this boundary", "evaluate guarantees only within this explicitly stated boundary"));
  await page.screenshot({ path: "output/playwright/workspace-revision-manual-edit-1440x900" + browserSuffix + ".png", fullPage: true });
  await revisionPanel.getByRole("button", { name: "Save hunk", exact: true }).click();
  await revisionPanel.locator(".hunk-card").waitFor();
  await revisionPanel.getByRole("button", { name: "Accept pending & complete", exact: true }).click();
  await revisionPanel.getByText("needs review", { exact: true }).waitFor();
  await revisionPanel.getByRole("button", { name: "Compile current version" }).click();
  await page.getByText("Compiled successfully", { exact: true }).waitFor({ timeout: 30000 });
  const rereview = revisionPanel.getByRole("button", { name: "Targeted re-review" });
  await rereview.waitFor();
  await rereview.click();
  await revisionPanel.getByText("resolved", { exact: true }).waitFor();
  await page.screenshot({ path: "output/playwright/workspace-revision-resolved-1440x900" + browserSuffix + ".png", fullPage: true });
  if (await revisionPanel.getByRole("button", { name: "Done", exact: true }).count()) throw new Error("Completed Agent review still exposes a Done action that conflicts with New task");
  await revisionPanel.getByRole("button", { name: "New task", exact: true }).click();

  await page.unroute("**/api/projects/*/memory**");
  await page.unroute("**/api/projects/*/reviews");
  await page.unroute("**/api/projects/*/agent-runs");
  await page.unroute("**/api/projects/*/issue-resolutions");
  await page.unroute("**/api/projects/*/agent-tasks");
  await page.unroute("**/api/projects/*/agent-tasks/revision-plan-e2e/confirm");
  await page.unroute("**/api/projects/*/change-sets/revision-change-e2e");
  await page.unroute("**/api/projects/*/change-sets/revision-change-e2e/accept");
  await page.unroute("**/api/projects/*/change-sets/revision-change-e2e/decide");
  await page.unroute("**/api/projects/*/change-sets/revision-change-e2e/finish");
  await page.unroute("**/api/projects/*/issue-resolutions/resolution-e2e/rereview");
}'

run_code '
async (page) => {
  let completionRequests = 0;
  const projectId = page.url().split("/").pop();
  const fileUrl = page.url().replace(/\/projects\/.*$/, "") + "/api/projects/" + projectId + "/file?path=main.tex";
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
  const preview = page.getByRole("status").filter({ hasText: "Writing suggestion available" });
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
  await page.setViewportSize({ width: 1280, height: 800 });
  const fixButton = page.getByRole("button", { name: "Fix with Agent" });
  await fixButton.waitFor();
  const fixBox = await fixButton.boundingBox();
  const pdfBox = await page.locator(".pdf-pane").boundingBox();
  if (!fixBox || !pdfBox || fixBox.x < pdfBox.x || fixBox.x + fixBox.width > pdfBox.x + pdfBox.width) throw new Error("Fix with Agent is clipped in the PDF failure state");
  await fixButton.click();
  await page.getByRole("region", { name: "Agent workspace" }).waitFor();
  const agentObjective = page.getByRole("textbox", { name: "What should Agent do?" });
  await agentObjective.waitFor();
  await page.waitForFunction(() =>
    (document.querySelector(".agent-task-form textarea")?.value || "").startsWith("/revise ")
  );
  const objective = await agentObjective.inputValue();
  if (!objective.startsWith("/revise ")) throw new Error("Compile repair did not select the Agent revise intent: " + JSON.stringify(objective));
  if (!objective.includes("main.tex")) throw new Error("Compile repair did not include the main document");
  if (!/Undefined control sequence|undefinedFastWriteCommand/i.test(objective)) throw new Error("Compile repair did not include the actionable compiler diagnostic");
  await page.setViewportSize({ width: 720, height: 800 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (overflow) throw new Error("Compile repair Agent caused page-level overflow at 720x800");
  const browserName = page.context().browser()?.browserType().name() || "browser";
  const browserSuffix = browserName === "chromium" ? "" : "-" + browserName;
  await page.screenshot({ path: "output/playwright/workspace-compile-repair-agent-720x800" + browserSuffix + ".png", fullPage: true });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Revise", exact: true }).click();
  await editor.focus();
  await editor.press("ControlOrMeta+A");
  await page.keyboard.insertText("\\documentclass{article}\n\\begin{document}\nCompilation repaired.\n\\end{document}");
  await page.getByText("Saved", { exact: true }).waitFor();
  await page.locator(".compile-strip--success").waitFor({ timeout: 30000 });
  if (await page.locator(".react-pdf__Page__canvas").count() < 1) throw new Error("Automatic retry after a failed compile did not produce a PDF");
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
  const origin = page.url().replace(/\/projects(?:\/.*)?$/, "");
  await page.goto(origin + "/projects");
  const projects = await (await page.request.get(origin + "/api/projects")).json();
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
  await dialog.getByLabel("Research domain").selectOption("network-information-security");
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
    venue: "network-information-security"
  };
  if (JSON.stringify(requestBody) !== JSON.stringify(expected)) {
    throw new Error("Unexpected GitHub import payload: " + JSON.stringify(requestBody));
  }
  await page.unroute("**/api/project-imports/github");
}'

echo "FastWrite browser smoke test passed"
