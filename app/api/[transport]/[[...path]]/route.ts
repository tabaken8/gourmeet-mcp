// app/api/[transport]/[[...path]]/route.ts
import { z } from "zod";
import { createMcpHandler } from "mcp-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handler = createMcpHandler((server) => {
  // 疎通確認用ツール（あとで好きに増やしてOK）
  server.tool(
    "ping",
    "health check",
    {
      message: z.string().optional(),
    },
    async ({ message }) => {
      return {
        content: [
          {
            type: "text",
            text: `pong${message ? `: ${message}` : ""}`,
          },
        ],
      };
    }
  );
});

// 重要：GET (SSE) と POST (JSON-RPC) を両方 export
export { handler as GET, handler as POST };
