import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

const handler = createMcpHandler((server) => {
  server.tool(
    "echo",
    "Echo a message",
    { message: z.string() },
    async ({ message }) => ({
      content: [{ type: "text", text: `Echo: ${message}` }],
    })
  );

  server.tool(
    "roll_a_die",
    "Return a number 1-6",
    {},
    async () => ({
      content: [{ type: "text", text: String(1 + Math.floor(Math.random() * 6)) }],
    })
  );
});

export { handler as GET, handler as POST };
