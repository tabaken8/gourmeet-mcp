// app/mcp/route.ts
import { z } from "zod";
import { createMcpHandler } from "mcp-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handler = createMcpHandler((server) => {
  server.tool(
    "ping",
    "health check",
    { message: z.string().optional() },
    async ({ message }) => ({
      content: [{ type: "text", text: `pong${message ? `: ${message}` : ""}` }],
    })
  );
});

export { handler as GET, handler as POST };
