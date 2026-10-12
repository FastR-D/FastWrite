const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.300 (Claude Code)"); process.exit(0); }
if (!args.includes("--bare") || args[args.indexOf("--tools") + 1] !== "" || !args.includes("--strict-mcp-config")) process.exit(9);
const resumed = args.includes("--resume");
const session_id = args[args.indexOf(resumed ? "--resume" : "--session-id") + 1];
let input = "";
for await (const chunk of process.stdin) input += chunk;
const emit = value => process.stdout.write(JSON.stringify({ ...value, session_id }) + "\n");
emit({ type: "system", subtype: "init" });
if (input === "malformed") { console.log("not JSON"); setTimeout(() => {}, 10_000); }
else if (input === "failure") { emit({ type: "result", is_error: true, result: "synthetic failure" }); process.exitCode = 1; }
else {
  const text = `${resumed ? "resume" : "new"}:${input}`;
  emit({ type: "stream_event", event: { delta: { type: "text_delta", text } } });
  if (input === "wait") setInterval(() => {}, 1000);
  else {
    await new Promise(resolve => setTimeout(resolve, 20));
    emit({ type: "assistant", message: { content: [{ type: "text", text }] } });
    emit({ type: "result", is_error: false, result: text });
  }
}
