import assert from "node:assert/strict";
import test from "node:test";

import {
  INVALID_PARAMS,
  MCP_PROTOCOL_VERSION,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  dispatch
} from "./lib/mcp-transport.mjs";

function makeServer(overrides = {}) {
  return {
    name: "pam",
    version: "0.4.0-test",
    listTools: () => [
      { name: "memory_state", description: "wraps detectMemoryState", inputSchema: { type: "object" } }
    ],
    callTool: async (name, args) => {
      if (name === "memory_state") return { ok: true, args };
      if (name === "boom") throw new Error("boom");
      const err = new Error(`Unknown tool: ${name}`);
      err.code = "UNKNOWN_TOOL";
      throw err;
    },
    ...overrides
  };
}

test("dispatch handles initialize", async () => {
  const response = await dispatch(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    makeServer()
  );
  assert.equal(response.result.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.equal(response.result.serverInfo.name, "pam");
});

test("dispatch handles tools/list", async () => {
  const response = await dispatch({ jsonrpc: "2.0", id: 2, method: "tools/list" }, makeServer());
  assert.equal(response.result.tools.length, 1);
  assert.equal(response.result.tools[0].name, "memory_state");
});

test("dispatch routes tools/call to the handler", async () => {
  const response = await dispatch(
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_state", arguments: { x: 1 } } },
    makeServer()
  );
  assert.deepEqual(response.result, { ok: true, args: { x: 1 } });
});

test("dispatch returns METHOD_NOT_FOUND for unknown methods", async () => {
  const response = await dispatch({ jsonrpc: "2.0", id: 4, method: "unknown" }, makeServer());
  assert.equal(response.error.code, METHOD_NOT_FOUND);
});

test("dispatch returns INVALID_PARAMS when tools/call is malformed", async () => {
  const response = await dispatch(
    { jsonrpc: "2.0", id: 5, method: "tools/call" },
    makeServer()
  );
  assert.equal(response.error.code, INVALID_PARAMS);
});

test("dispatch reports handler errors as internal errors", async () => {
  const response = await dispatch(
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "boom", arguments: {} } },
    makeServer()
  );
  assert.equal(response.error.message, "boom");
});

test("dispatch swallows notifications (no id)", async () => {
  const response = await dispatch(
    { jsonrpc: "2.0", method: "notifications/initialized" },
    makeServer()
  );
  assert.equal(response, null);
});

test("PARSE_ERROR is exported with the JSON-RPC code", () => {
  assert.equal(PARSE_ERROR, -32700);
});
