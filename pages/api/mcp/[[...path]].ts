import type { NextApiRequest, NextApiResponse } from "next";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export const config = {
  api: { bodyParser: false },
};

function createServer() {
  const server = new McpServer({ name: "gourmeet-mcp", version: "0.1.0" });

  server.registerTool(
    "ping",
    { title: "Ping", description: "Health check", inputSchema: {} as any },
async () => ({
  content: [{ type: "text" as const, text: "pong" }],
})

  );

  return server;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // CORS (important for connector creation)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, mcp-session-id, accept");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (!req.method || !["GET", "POST", "DELETE"].includes(req.method)) {
    res.status(405).send("Method Not Allowed");
    return;
  }

  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });

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
