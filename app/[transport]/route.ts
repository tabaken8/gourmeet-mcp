import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

const handler = createMcpHandler(
  (server) => {
    // 動作確認用（ツールが1つでもあると切り分けしやすい）
    server.tool("ping", "health check", {}, async () => {
      return { content: [{ type: "text", text: "pong" }] };
    });

    server.tool(
      "roll_dice",
      "Rolls an N-sided die",
      { sides: z.number().int().min(2).default(6) },
      async ({ sides }) => {
        const value = 1 + Math.floor(Math.random() * sides);
        return { content: [{ type: "text", text: `You rolled a ${value}!` }] };
      }
    );
  },
  {
    // optional server options（空でもOK）
  },
  {
    // SSE を使うなら Redis が必要（Streamable HTTP だけなら無くてもOK）
    redisUrl: process.env.REDIS_URL,

    // ★重要：app/[transport]/route.ts ＝ "/<transport>" 直下なので basePath は空
    // README の「[transport] を置いた場所に合わせる」ルールに従う :contentReference[oaicite:3]{index=3}
    basePath: "",

    maxDuration: 60,
    verboseLogs: true,
  }
);

// ★重要：GET が無いと /mcp へ GET したクライアント（OpenAI側の疎通確認等）で 405 になる
export { handler as GET, handler as POST, handler as DELETE };
