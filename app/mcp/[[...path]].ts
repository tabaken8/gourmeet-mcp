// pages/api/mcp/[[...path]].ts
import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

function createMcpServer() {
  const server = new McpServer({ name: "gourmeet-mcp", version: "0.1.0" });

  // 動作確認用（まずはこれで疎通を取る）
  server.registerTool(
    "ping",
    {
      title: "Ping",
      description: "Health check",
      inputSchema: {}, // zod objectにしたいなら z.object({}) でもOK
    },
    async () => ({ content: [{ type: "text", text: "pong" }] })
  );

  // TODO: ここに本命のツールを追加していく
  return server;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // ---- CORS（ChatGPT側の検証で大事）----
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type, mcp-session-id");
    res.status(204).end();
    return;
  }

  // ---- ChatGPTが叩きがちな未使用パスは 404 を返しておく（502回避）----
  const path = Array.isArray(req.query.path) ? req.query.path : [];
  if (path[0] === "oauth" || path[0] === ".well-known") {
    res.status(404).send("Not Found");
    return;
  }

  // ---- MCPは GET/POST/DELETE を受ける ----
  const allowed = new Set(["GET", "POST", "DELETE"]);
  if (!req.method || !allowed.has(req.method)) {
    res.status(405).send("Method Not Allowed");
    return;
  }

  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).send("Internal Server Error");
  }
}
