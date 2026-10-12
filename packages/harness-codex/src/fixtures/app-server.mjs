import { createInterface } from "node:readline";

// A local JSON-RPC peer: no Codex installation, credentials or model calls.
const scenario = process.env.CODEX_TEST_SCENARIO;
let nextThread = 0;
let nextTurn = 0;
let initialized = false;
const turns = [];
const write = (messages) => process.stdout.write(messages.map(JSON.stringify).join("\n") + "\n");
const reply = (request, result) => ({ id: request.id, result });
const notification = (method, params) => ({ method, params });
const delta = (run, text) => notification("item/agentMessage/delta", { threadId: run.threadId, turnId: run.turnId, itemId: "message", delta: text });
const completed = (run, status = "completed") => notification("turn/completed", {
  threadId: run.threadId,
  turn: { id: run.turnId, status, items: [], error: status === "failed" ? { message: "A failed" } : null },
});

createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    if (scenario === "initialization") setTimeout(() => write([reply(request, {})]), 30);
    else write([reply(request, {})]);
  } else if (request.method === "initialized") {
    initialized = true;
  } else if (request.method === "thread/start") {
    if (scenario === "initialization" && !initialized) {
      write([{ id: request.id, error: { message: "Not initialized" } }]);
    } else write([reply(request, { thread: { id: `thread-${++nextThread}` } })]);
  } else if (request.method === "turn/start") {
    const run = { threadId: request.params.threadId, turnId: `turn-${++nextTurn}` };
    const response = reply(request, { turn: { id: run.turnId, status: "inProgress" } });
    if (scenario === "missing-turn") {
      write([reply(request, {})]);
      return;
    }
    if (scenario === "rpc-error") {
      write([{ id: request.id, error: { message: "Start rejected" } }]);
      return;
    }
    if (scenario === "exit") {
      write([response]);
      setTimeout(() => process.exit(0), 30);
      return;
    }
    if (scenario === "reuse") {
      const stale = { ...run, turnId: `turn-${nextTurn - 1}` };
      write([
        delta(stale, "STALE"), completed(stale),
        notification("item/agentMessage/delta", { threadId: run.threadId, delta: "NO_TURN" }),
        notification("item/agentMessage/delta", { turnId: run.turnId, delta: "NO_THREAD" }),
        notification("turn/completed", { threadId: run.threadId }),
        notification("turn/completed", { turn: { id: run.turnId } }),
        delta({ ...run, threadId: "foreign-thread" }, "FOREIGN"),
        delta(run, `TEXT-${nextTurn}`), completed(run), response,
      ]);
      return;
    }
    turns.push(run);
    if (scenario === "cancel" || scenario === "cancel-early" || scenario === "dispose") {
      const ready = () => write([response, delta(run, `READY-${turns.length}`)]);
      if (scenario === "cancel-early") setTimeout(ready, 30);
      else ready();
      return;
    }
    if (turns.length === 1) {
      write([response]);
      return;
    }
    const [a, b] = turns;
    // B's events deliberately precede its start response, in the same chunk.
    write([
      delta(a, "A1"), delta(b, "B1"),
      notification("item/toolCall", { ...a, name: "tool-A", input: { owner: "A" }, approvalId: "approval-A" }),
      notification("item/toolCall", { ...b, name: "tool-B", input: { owner: "B" }, approvalId: "approval-B" }),
      notification("error", { ...b, willRetry: true, error: { message: "Retrying B" } }),
      scenario === "error"
        ? notification("error", { ...a, willRetry: false, error: { message: "A failed" } })
        : completed(a, scenario === "failure" ? "failed" : scenario === "interrupted" ? "interrupted" : "completed"),
      delta(a, "AFTER_TERMINAL"),
      response,
    ]);
    // A has finished; B must remain subscribed for later output.
    setTimeout(() => write([
      delta(b, "B2"),
      notification("item/completed", { ...b, item: { type: "agentMessage", id: "final", text: "B3" } }),
      completed(b),
    ]), 30);
  } else if (request.method === "turn/interrupt") {
    const run = turns.find((turn) => turn.threadId === request.params.threadId && turn.turnId === request.params.turnId);
    if (!run) write([{ id: request.id, error: { message: "Wrong turn interrupted" } }]);
    else {
      const other = turns.find((turn) => turn !== run);
      write([reply(request, {}), completed(run, "interrupted"), ...(other ? [delta(other, "SURVIVED"), completed(other)] : [])]);
    }
  }
});
