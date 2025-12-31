import type { NextApiRequest, NextApiResponse } from "next";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

export const config = {
  api: { bodyParser: false },
};

function getSupabaseOptional(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // pingだけでも動くように、ここではthrowしない
  if (!url || !serviceKey) return null;

  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function requireSupabase(): SupabaseClient {
  const sb = getSupabaseOptional();
  if (!sb) {
    const hasUrl = Boolean(process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL);
    const hasKey = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
    throw new Error(
      `Missing env for Supabase. url=${hasUrl ? "ok" : "missing"} service_role=${hasKey ? "ok" : "missing"}`
    );
  }
  return sb;
}

const clampLimit = (n: unknown, max = 20) => {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v) || v <= 0) return 10;
  return Math.min(Math.floor(v), max);
};

const uniq = <T,>(arr: T[]) => Array.from(new Set(arr));
const jsonText = (obj: unknown) => JSON.stringify(obj, null, 2);

type PostRow = {
  id: string;
  user_id: string;
  content: string | null;
  created_at: string | null;
  image_urls: string[] | null;
  place_name: string | null;
  place_address: string | null;
  place_id: string | null;
  image_variants: any | null;
  recommend_score: number | null;
  price_yen: number | null;
  price_range: string | null;
};

async function enrichPosts(supabase: SupabaseClient, posts: PostRow[]) {
  const userIds = uniq(posts.map((p) => p.user_id).filter(Boolean));
  const placeIds = uniq(posts.map((p) => p.place_id).filter(Boolean)) as string[];

  const profilesById: Record<string, any> = {};
  if (userIds.length > 0) {
    const { data, error } = await supabase
      .from("profiles")
      .select("id,username,display_name,avatar_url,is_public,updated_at,bio,header_image_url")
      .in("id", userIds);

    if (error) throw error;
    for (const pr of data ?? []) profilesById[(pr as any).id] = pr;
  }

  const placesById: Record<string, any> = {};
  if (placeIds.length > 0) {
    const { data, error } = await supabase
      .from("places")
      .select(
        "place_id,name,address,lat,lng,photo_url,primary_genre,genre_tags,primary_type,updated_at"
      )
      .in("place_id", placeIds);

    if (error) throw error;
    for (const pl of data ?? []) placesById[(pl as any).place_id] = pl;
  }

  return posts.map((p) => ({
    ...p,
    author: profilesById[p.user_id] ?? null,
    place: p.place_id ? placesById[p.place_id] ?? null : null,
  }));
}

function createServer() {
  const server = new McpServer({ name: "gourmeet-mcp", version: "0.1.0" });

  // -------------------------
  // ping（Zodスキーマ必須）
  // -------------------------
  server.registerTool(
    "ping",
    { title: "Ping", description: "Health check", inputSchema: z.object({}) },
    async () => ({ content: [{ type: "text" as const, text: "pong" }] })
  );

  // -------------------------
  // debug.env（値は返さない）
  // -------------------------
  server.registerTool(
    "debug.env",
    {
      title: "Debug Env",
      description: "環境変数の有無だけ返します（値は返しません）",
      inputSchema: z.object({}),
    },
    async () => {
      const present = (k: string) => Boolean(process.env[k]);
      return {
        content: [
          {
            type: "text" as const,
            text: jsonText({
              VERCEL_ENV: process.env.VERCEL_ENV ?? null,
              VERCEL_URL: process.env.VERCEL_URL ?? null,
              has_SUPABASE_URL: present("SUPABASE_URL"),
              has_NEXT_PUBLIC_SUPABASE_URL: present("NEXT_PUBLIC_SUPABASE_URL"),
              has_SUPABASE_SERVICE_ROLE_KEY: present("SUPABASE_SERVICE_ROLE_KEY"),
            }),
          },
        ],
      };
    }
  );

  // -------------------------
  // places
  // -------------------------
  server.registerTool(
    "places.get",
    {
      title: "Get Place",
      description: "places.place_id で店情報を取得します",
      inputSchema: z.object({ place_id: z.string() }),
    },
    async ({ place_id }) => {
      const supabase = requireSupabase();
      const { data, error } = await supabase
        .from("places")
        .select(
          "place_id,name,address,lat,lng,photo_url,updated_at,place_types,primary_type,types_fetched_at,primary_genre,genre_tags,genre_source,genre_confidence,genre_updated_at"
        )
        .eq("place_id", place_id)
        .maybeSingle();

      if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
      return { content: [{ type: "text" as const, text: jsonText({ place_id, data }) }] };
    }
  );

  server.registerTool(
    "places.search",
    {
      title: "Search Places",
      description: "places.name を部分一致で検索します",
      inputSchema: z.object({
        query: z.string(),
        limit: z.number().optional(),
      }),
    },
    async ({ query, limit }) => {
      const supabase = requireSupabase();
      const lim = clampLimit(limit);

      const { data, error } = await supabase
        .from("places")
        .select("place_id,name,address,lat,lng,photo_url,primary_genre,genre_tags,primary_type,updated_at")
        .ilike("name", `%${query}%`)
        .limit(lim);

      if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
      return { content: [{ type: "text" as const, text: jsonText({ query, limit: lim, data }) }] };
    }
  );

  // -------------------------
  // profiles
  // -------------------------
  server.registerTool(
    "profiles.get",
    {
      title: "Get Profile",
      description: "profiles を id または username で取得します",
      inputSchema: z
        .object({
          id: z.string().optional(),
          username: z.string().optional(),
        })
        .refine((v) => v.id || v.username, { message: "Provide id or username" }),
    },
    async ({ id, username }) => {
      const supabase = requireSupabase();

      let q = supabase
        .from("profiles")
        .select("id,display_name,avatar_url,updated_at,username,username_ci,username_updated_at,bio,is_public,header_image_url");

      q = id ? q.eq("id", id) : q.eq("username", username!);

      const { data, error } = await q.maybeSingle();
      if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
      return { content: [{ type: "text" as const, text: jsonText({ id, username, data }) }] };
    }
  );

  server.registerTool(
    "profiles.search",
    {
      title: "Search Profiles",
      description: "username / display_name を部分一致検索します（上位のみ）",
      inputSchema: z.object({
        query: z.string(),
        limit: z.number().optional(),
      }),
    },
    async ({ query, limit }) => {
      const supabase = requireSupabase();
      const lim = clampLimit(limit);

      const byUsername = await supabase
        .from("profiles")
        .select("id,username,display_name,avatar_url,is_public,updated_at")
        .ilike("username", `%${query}%`)
        .limit(lim);

      const byDisplay = await supabase
        .from("profiles")
        .select("id,username,display_name,avatar_url,is_public,updated_at")
        .ilike("display_name", `%${query}%`)
        .limit(lim);

      if (byUsername.error) {
        return { content: [{ type: "text" as const, text: `Error: ${byUsername.error.message}` }] };
      }
      if (byDisplay.error) {
        return { content: [{ type: "text" as const, text: `Error: ${byDisplay.error.message}` }] };
      }

      const merged = [...(byUsername.data ?? []), ...(byDisplay.data ?? [])];
      const uniqById = Object.values(
        merged.reduce((acc: any, row: any) => {
          acc[row.id] = row;
          return acc;
        }, {})
      ).slice(0, lim);

      return { content: [{ type: "text" as const, text: jsonText({ query, limit: lim, data: uniqById }) }] };
    }
  );

  // -------------------------
  // posts
  // -------------------------
  server.registerTool(
    "posts.recent",
    {
      title: "Recent Posts",
      description: "posts の最新投稿（author/place 付与）",
      inputSchema: z.object({ limit: z.number().optional() }),
    },
    async ({ limit }) => {
      const supabase = requireSupabase();
      const lim = clampLimit(limit);

      const { data, error } = await supabase
        .from("posts")
        .select(
          "id,user_id,content,created_at,image_urls,place_name,place_address,place_id,image_variants,recommend_score,price_yen,price_range"
        )
        .order("created_at", { ascending: false })
        .limit(lim);

      if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
      const enriched = await enrichPosts(supabase, (data ?? []) as PostRow[]);
      return { content: [{ type: "text" as const, text: jsonText({ limit: lim, data: enriched }) }] };
    }
  );

  server.registerTool(
    "posts.get",
    {
      title: "Get Post",
      description: "posts.id（uuid）で投稿（author/place 付与）",
      inputSchema: z.object({ id: z.string() }),
    },
    async ({ id }) => {
      const supabase = requireSupabase();

      const { data, error } = await supabase
        .from("posts")
        .select(
          "id,user_id,content,created_at,image_urls,place_name,place_address,place_id,image_variants,recommend_score,price_yen,price_range"
        )
        .eq("id", id)
        .maybeSingle();

      if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
      if (!data) return { content: [{ type: "text" as const, text: jsonText({ id, data: null }) }] };

      const enriched = await enrichPosts(supabase, [data as PostRow]);
      return { content: [{ type: "text" as const, text: jsonText({ id, data: enriched[0] }) }] };
    }
  );

  server.registerTool(
    "posts.by_place",
    {
      title: "Posts by Place",
      description: "place_id（text）で投稿一覧（author/place 付与）",
      inputSchema: z.object({
        place_id: z.string(),
        limit: z.number().optional(),
      }),
    },
    async ({ place_id, limit }) => {
      const supabase = requireSupabase();
      const lim = clampLimit(limit);

      const { data, error } = await supabase
        .from("posts")
        .select(
          "id,user_id,content,created_at,image_urls,place_name,place_address,place_id,image_variants,recommend_score,price_yen,price_range"
        )
        .eq("place_id", place_id)
        .order("created_at", { ascending: false })
        .limit(lim);

      if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };

      const enriched = await enrichPosts(supabase, (data ?? []) as PostRow[]);
      return { content: [{ type: "text" as const, text: jsonText({ place_id, limit: lim, data: enriched }) }] };
    }
  );

  // -------------------------
  // follows（acceptedのみ）
  // -------------------------
  server.registerTool(
    "follows.followers",
    {
      title: "Followers",
      description: "あるユーザーの followers（accepted, profile付与）",
      inputSchema: z.object({
        user_id: z.string(),
        limit: z.number().optional(),
      }),
    },
    async ({ user_id, limit }) => {
      const supabase = requireSupabase();
      const lim = clampLimit(limit);

      const { data, error } = await supabase
        .from("follows")
        .select("follower_id,followee_id,created_at,status,request_read")
        .eq("followee_id", user_id)
        .eq("status", "accepted")
        .order("created_at", { ascending: false })
        .limit(lim);

      if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };

      const followerIds = uniq((data ?? []).map((r: any) => r.follower_id));
      const profilesById: Record<string, any> = {};

      if (followerIds.length > 0) {
        const pr = await supabase
          .from("profiles")
          .select("id,username,display_name,avatar_url,is_public,updated_at")
          .in("id", followerIds);

        if (pr.error) return { content: [{ type: "text" as const, text: `Error: ${pr.error.message}` }] };
        for (const p of pr.data ?? []) profilesById[(p as any).id] = p;
      }

      const enriched = (data ?? []).map((r: any) => ({
        ...r,
        follower: profilesById[r.follower_id] ?? null,
      }));

      return { content: [{ type: "text" as const, text: jsonText({ user_id, limit: lim, data: enriched }) }] };
    }
  );

  server.registerTool(
    "follows.following",
    {
      title: "Following",
      description: "あるユーザーが follow している相手（accepted, profile付与）",
      inputSchema: z.object({
        user_id: z.string(),
        limit: z.number().optional(),
      }),
    },
    async ({ user_id, limit }) => {
      const supabase = requireSupabase();
      const lim = clampLimit(limit);

      const { data, error } = await supabase
        .from("follows")
        .select("follower_id,followee_id,created_at,status,request_read")
        .eq("follower_id", user_id)
        .eq("status", "accepted")
        .order("created_at", { ascending: false })
        .limit(lim);

      if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };

      const followeeIds = uniq((data ?? []).map((r: any) => r.followee_id));
      const profilesById: Record<string, any> = {};

      if (followeeIds.length > 0) {
        const pr = await supabase
          .from("profiles")
          .select("id,username,display_name,avatar_url,is_public,updated_at")
          .in("id", followeeIds);

        if (pr.error) return { content: [{ type: "text" as const, text: `Error: ${pr.error.message}` }] };
        for (const p of pr.data ?? []) profilesById[(p as any).id] = p;
      }

      const enriched = (data ?? []).map((r: any) => ({
        ...r,
        followee: profilesById[r.followee_id] ?? null,
      }));

      return { content: [{ type: "text" as const, text: jsonText({ user_id, limit: lim, data: enriched }) }] };
    }
  );

  // -------------------------
  // feed（体験用）
  // -------------------------
  server.registerTool(
    "feed.home",
    {
      title: "Home Feed (simple)",
      description: "user_id の following(accepted) + 自分 の投稿を新しい順で返す（author/place付与）",
      inputSchema: z.object({
        user_id: z.string(),
        limit: z.number().optional(),
      }),
    },
    async ({ user_id, limit }) => {
      const supabase = requireSupabase();
      const lim = clampLimit(limit);

      const fw = await supabase
        .from("follows")
        .select("followee_id")
        .eq("follower_id", user_id)
        .eq("status", "accepted")
        .limit(200);

      if (fw.error) return { content: [{ type: "text" as const, text: `Error: ${fw.error.message}` }] };

      const followeeIds = uniq((fw.data ?? []).map((r: any) => r.followee_id));
      const feedUserIds = uniq([user_id, ...followeeIds]).slice(0, 200);

      const { data, error } = await supabase
        .from("posts")
        .select(
          "id,user_id,content,created_at,image_urls,place_name,place_address,place_id,image_variants,recommend_score,price_yen,price_range"
        )
        .in("user_id", feedUserIds)
        .order("created_at", { ascending: false })
        .limit(lim);

      if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };

      const enriched = await enrichPosts(supabase, (data ?? []) as PostRow[]);
      return { content: [{ type: "text" as const, text: jsonText({ user_id, limit: lim, data: enriched }) }] };
    }
  );

  return server;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // CORS (connector作成・実行に重要)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, mcp-session-id, accept, authorization");
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

  const transport = new StreamableHTTPServerTransport({
    // stateless にしたいなら sessionIdGenerator: undefined を設定
    enableJsonResponse: true,
  });

  let server: McpServer | null = null;

  res.on("close", () => {
    transport.close();
    server?.close();
  });

  try {
    server = createServer(); // try内で作る（例外を拾う）
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (e) {
    console.error("[mcp] handler error:", e);
    if (!res.headersSent) res.status(500).send("Internal Server Error");
  }
}
