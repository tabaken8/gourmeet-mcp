#!/usr/bin/env bash
set -euo pipefail

cd "$HOME/gourmeet-mcp"

# deps
npm i @modelcontextprotocol/sdk

# avoid route conflicts (optional but recommended)
rm -rf app/mcp app/api

# MCP endpoint (Pages Router)
mkdir -p pages/api/mcp
cat > "pages/api/mcp/[[...path]].ts" <<'EOF'
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
    async () => ({ content: [{ type: "text", text: "pong" }] })
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
EOF

# rewrite /mcp -> /api/mcp
cat > next.config.ts <<'EOF'
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [{ source: "/mcp/:path*", destination: "/api/mcp/:path*" }];
  },
};

export default nextConfig;
EOF

# build check
npm run build

# git push
git add -A
git commit -m "Add MCP Streamable HTTP endpoint and rewrite /mcp" || true
git push origin main

echo ""
echo "After Vercel deploy, test:"
echo "  curl -i https://mcp.gourmeet.jp/mcp"
echo "  curl -i -X POST https://mcp.gourmeet.jp/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}'"
