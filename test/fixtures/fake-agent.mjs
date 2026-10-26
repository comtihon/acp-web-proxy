#!/usr/bin/env node
// Minimal ACP agent for tests: newline-delimited JSON-RPC on stdio.
import { createInterface } from "node:readline";

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const waiting = new Map(); // our outbound request id -> resolve
let nextId = 1000;

function request(method, params) {
  const id = nextId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}

rl.on("line", async (line) => {
  const msg = JSON.parse(line);
  if (!msg.method && waiting.has(msg.id)) {
    waiting.get(msg.id)(msg);
    waiting.delete(msg.id);
    return;
  }
  switch (msg.method) {
    case "initialize":
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false }, agentInfo: { name: "fake", env: process.env.FAKE_MARK ?? null, cwd: process.cwd() } } });
      break;
    case "session/new":
      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s1", _meta: { mcpServers: (msg.params?.mcpServers ?? []).map((s) => s.name) } } });
      break;
    case "session/prompt": {
      const text = msg.params?.prompt?.[0]?.text ?? "";
      const n = Number(/chunks=(\d+)/.exec(text)?.[1] ?? 3);
      for (let i = 0; i < n; i++) {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `c${i}` } } } });
      }
      if (text.includes("ask")) {
        const res = await request("session/request_permission", { sessionId: "s1", toolCall: { toolCallId: "t1" }, options: [{ optionId: "ok", kind: "allow_once", name: "OK" }] });
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `perm:${res.result?.outcome?.optionId}` } } } });
      }
      if (text.includes("slow")) await new Promise((r) => setTimeout(r, 300));
      if (text.includes("crash")) process.exit(3);
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      break;
    }
    default:
      if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "nope" } });
  }
});
