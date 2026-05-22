const MCP_PROTOCOL_VERSION = "2024-11-05";

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

function jsonRpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function encodeFrame(message) {
  return `${JSON.stringify(message)}\n`;
}

async function dispatch(request, server) {
  if (!request || typeof request !== "object") {
    return jsonRpcError(null, INVALID_REQUEST, "Invalid Request");
  }
  if (request.jsonrpc !== "2.0") {
    return jsonRpcError(request.id ?? null, INVALID_REQUEST, "Invalid Request: jsonrpc must be '2.0'");
  }
  const { id, method, params } = request;
  const isNotification = id === undefined;

  try {
    if (method === "initialize") {
      const result = {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: server.name, version: server.version }
      };
      return isNotification ? null : jsonRpcResult(id, result);
    }
    if (method === "initialized" || method === "notifications/initialized") {
      return null;
    }
    if (method === "tools/list") {
      const tools = server.listTools();
      return isNotification ? null : jsonRpcResult(id, { tools });
    }
    if (method === "tools/call") {
      if (!params || typeof params !== "object") {
        return jsonRpcError(id, INVALID_PARAMS, "tools/call requires params");
      }
      const { name, arguments: args } = params;
      if (typeof name !== "string" || name === "") {
        return jsonRpcError(id, INVALID_PARAMS, "tools/call requires a tool name");
      }
      const callResult = await server.callTool(name, args ?? {});
      return isNotification ? null : jsonRpcResult(id, callResult);
    }
    if (method === "ping") {
      return isNotification ? null : jsonRpcResult(id, {});
    }
    if (isNotification) return null;
    return jsonRpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  } catch (error) {
    if (isNotification) return null;
    return jsonRpcError(id, INTERNAL_ERROR, error.message ?? String(error));
  }
}

function makeLineReader(stream, onLine) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      if (line.trim() !== "") {
        onLine(line);
      }
      newlineIndex = buffer.indexOf("\n");
    }
  });
  return () => {
    if (buffer.trim() !== "") {
      onLine(buffer);
      buffer = "";
    }
  };
}

async function processLine(line, server, writeFrame) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    writeFrame(jsonRpcError(null, PARSE_ERROR, "Parse error"));
    return;
  }
  const response = await dispatch(request, server);
  if (response) writeFrame(response);
}

function runStdioServer(server, options = {}) {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  let closed = false;
  const writeFrame = (frame) => {
    if (closed) return;
    stdout.write(encodeFrame(frame));
  };
  const flush = makeLineReader(stdin, (line) => {
    processLine(line, server, writeFrame).catch((error) => {
      writeFrame(jsonRpcError(null, INTERNAL_ERROR, error.message ?? String(error)));
    });
  });
  return new Promise((resolve) => {
    stdin.on("end", () => {
      flush();
      closed = true;
      resolve();
    });
    stdin.on("close", () => {
      flush();
      closed = true;
      resolve();
    });
  });
}

export {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  MCP_PROTOCOL_VERSION,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  dispatch,
  encodeFrame,
  runStdioServer
};
