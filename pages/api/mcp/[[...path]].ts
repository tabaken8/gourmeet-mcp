import type { NextApiRequest, NextApiResponse } from "next";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createClient } from "@supabase/supabase-js";

export const config = {
  api: { bodyParser: false },
};

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // 体験用：サーバー限定

  if (!url) throw new Error("Missing env: SUPABASE_URL");
  if (!serviceKey) throw new Error("Missing env: SUPABASE_SERVICE_ROLE_KEY");

  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const clampLimit = (n: unknown, max = 20) => {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v) || v <= 0) return 10;
  return Math.min(Math.floor(v), max);
};

const uniq = <T,>(arr: T[]) => Array.from(new Set(arr));

function jsonText(obj: unknown) {
  return JSON.stringify(obj, null, 2);
}

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

type ProfileRow = {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
  updated_at: string | null;
  username: string | null;
  username_ci: string | null;
  username_updated_at: string | null;
  bio: string | null;
  is_public: boolean;
  header_image_url: string | null;
};

type PlaceRow = {
  place_id: string;
  name: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  photo_url: string | null;
  updated_at: string | null;
  place_types: string[] | null;
  primary_type: string | null;
  types_fetched_at: string | null;
  primary_genre: string | null;
  genre_tags: string[];
  genre_source: string | null;
  genre_confidence: number | null;
  genre_updated_at: string;
};

async function enrichPosts(
  supabase: ReturnType<typeof getSupabase>,
  posts: PostRow[]
) {
  const userIds = uniq(posts.map((p) => p.user_id).filter(Boolean));
  const placeIds = uniq(posts.map((p) => p.place_id).filter(Boolean)) as string[];

  // profiles
  const profilesById: Record<string, ProfileRow> = {};
  if (userIds.length > 0) {
    const { data, error } = await supabase
      .from("profiles")
      .select(
        "id,display_name,avatar_url,updated_at,username,username_ci,username_updated_at,bio,is_public,header_image_url"
      )
      .in("id", userIds);

    if (error) throw error;
    for (const pr of (data ?? []) as ProfileRow[]) profilesById[pr.id] = pr;
  }

  // places
  const placesById: Record<string, PlaceRow> = {};
  if (placeIds.length > 0) {
    const { data, error } = await supabase
      .from("places")
      .select(
        "place_id,name,address,lat,lng,photo_url,updated_at,place_types,primary_type,types_fetched_at,primary_genre,genre_tags,genre_source,genre_confidence,genre_updated_at"
      )
      .in("place_id", placeIds);

    if (error) throw error;
    for (const pl of (data ?? []) as PlaceRow[]) placesById[pl.place_id] = pl;
  }

  return posts.map((p) => ({
    ...p,
    author: profilesById[p.user_id] ?? null,
    place: p.place_id ? (placesById[p.place_id] ?? null) : null,
  }));
}

function createServer() {
  const server = new McpServer({ name: "gourmeet-mcp", version: "0.1.0" });
  const supabase = getSupabase();

  // ------------------------------------------------------------
  // ping
  // ------------------------------------------------------------
  server.registerTool(
    "ping",
    {
      title: "Ping",
      description: "Health check",
      inputSchema: { type: "object", properties: {}, additionalProperties: false } as any,
    },
    async () => ({ content: [{ type: "text" as const, text: "pong" }] })
  );

  // ------------------------------------------------------------
  // schema: columns (info_schema) - 便利
  // ------------------------------------------------------------
  server.registerTool(
    "db.columns",
    {
      title: "DB Columns",
      description:
        "publicスキーマのテーブルのカラム一覧を返します（places/profiles/posts/follows など）",
      inputSchema: {
        type: "object",
        properties: {
          tables: {
            type: "array",
            items: { type: "string" },
            description: "例: ['places','profiles','posts','follows']",
          },
        },
        required: ["tables"],
        additionalProperties: false,
      } as any,
    },
    async ({ tables }: { tables: string[] }) => {
      const { data, error } = await supabase
        // information_schema は service role なら読めるはず
        .from("information_schema.columns" as any)
        .select("table_name,ordinal_position,column_name,data_type,udt_name,is_nullable,column_default")
        .eq("table_schema", "public")
        .in("table_name", tables)
        .order("table_name", { ascending: true })
        .order("ordinal_position", { ascending: true });

      if (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
      }
      return { content: [{ type: "text" as const, text: jsonText({ tables, data }) }] };
    }
  );

  // ------------------------------------------------------------
  // places
  // ------------------------------------------------------------
  server.registerTool(
    "places.get",
    {
      title: "Get Place",
      description: "places.place_id で店情報を取得します",
      inputSchema: {
        type: "object",
        properties: { place_id: { type: "string" } },
        required: ["place_id"],
        additionalProperties: false,
      } as any,
    },
    async ({ place_id }: { place_id: string }) => {
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
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number", description: "最大20" },
        },
        required: ["query"],
        additionalProperties: false,
      } as any,
    },
    async ({ query, limit }: { query: string; limit?: number }) => {
      const lim = clampLimit(limit);
      const { data, error } = await supabase
        .from("places")
        .select(
          "place_id,name,address,lat,lng,photo_url,primary_genre,genre_tags,primary_type,updated_at"
        )
        .ilike("name", `%${query}%`)
        .limit(lim);

      if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
      return { content: [{ type: "text" as const, text: jsonText({ query, limit: lim, data }) }] };
    }
  );

  // ------------------------------------------------------------
  // profiles
  // ------------------------------------------------------------
  server.registerTool(
    "profiles.get",
    {
      title: "Get Profile",
      description: "profiles を id または username で取得します",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "uuid" },
          username: { type: "string" },
        },
        additionalProperties: false,
      } as any,
    },
    async ({ id, username }: { id?: string; username?: string }) => {
      if (!id && !username) {
        return { content: [{ type: "text" as const, text: "Error: provide id or username" }] };
      }

      let q = supabase
        .from("profiles")
        .select(
          "id,display_name,avatar_url,updated_at,username,username_ci,username_updated_at,bio,is_public,header_image_url"
        );

      if (id) q = q.eq("id", id);
      else q = q.eq("username", username!);

      const { data, error } = await q.maybeSingle();

      if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
      return { content: [{ type: "text" as const, text: jsonText({ id, username, data }) }] };
    }
  );

  server.registerTool(
    "profiles.search",
    {
      title: "Search Profiles",
      description: "username / display_name を軽く検索します（部分一致）",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number", description: "最大20" },
        },
        required: ["query"],
        additionalProperties: false,
      } as any,
    },
    async ({ query, limit }: { query: string; limit?: number }) => {
      const lim = clampLimit(limit);

      // OR検索したいので2回引いてマージ（Supabase JSのorもあるけど可読性優先）
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

  // ------------------------------------------------------------
  // posts
  // ------------------------------------------------------------
  server.registerTool(
    "posts.recent",
    {
      title: "Recent Posts",
      description: "posts の最新投稿を返します（author/place も付与）",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "number", description: "最大20" } },
        additionalProperties: false,
      } as any,
    },
    async ({ limit }: { limit?: number }) => {
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
      description: "posts.id（uuid）で投稿を取得（author/place も付与）",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "uuid" } },
        required: ["id"],
        additionalProperties: false,
      } as any,
    },
    async ({ id }: { id: string }) => {
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
      inputSchema: {
        type: "object",
        properties: {
          place_id: { type: "string" },
          limit: { type: "number", description: "最大20" },
        },
        required: ["place_id"],
        additionalProperties: false,
      } as any,
    },
    async ({ place_id, limit }: { place_id: string; limit?: number }) => {
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

  // ------------------------------------------------------------
  // follows
  // ------------------------------------------------------------
  server.registerTool(
    "follows.followers",
    {
      title: "Followers",
      description: "あるユーザーの followers（accepted）を返します（profile付与）",
      inputSchema: {
        type: "object",
        properties: {
          user_id: { type: "string", description: "profiles.id (uuid)" },
          limit: { type: "number", description: "最大20" },
        },
        required: ["user_id"],
        additionalProperties: false,
      } as any,
    },
    async ({ user_id, limit }: { user_id: string; limit?: number }) => {
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
      description: "あるユーザーが follow している相手（accepted）を返します（profile付与）",
      inputSchema: {
        type: "object",
        properties: {
          user_id: { type: "string", description: "profiles.id (uuid)" },
          limit: { type: "number", description: "最大20" },
        },
        required: ["user_id"],
        additionalProperties: false,
      } as any,
    },
    async ({ user_id, limit }: { user_id: string; limit?: number }) => {
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

  // ------------------------------------------------------------
  // feed (体験用): user_id の following の投稿 + 自分の投稿
  // ------------------------------------------------------------
  server.registerTool(
    "feed.home",
    {
      title: "Home Feed (simple)",
      description:
        "user_id の following(accepted) + 自分 の posts を新しい順で返す（author/place 付与）",
      inputSchema: {
        type: "object",
        properties: {
          user_id: { type: "string", description: "profiles.id (uuid)" },
          limit: { type: "number", description: "最大20" },
        },
        required: ["user_id"],
        additionalProperties: false,
      } as any,
    },
    async ({ user_id, limit }: { user_id: string; limit?: number }) => {
      const lim = clampLimit(limit);

      const fw = await supabase
        .from("follows")
        .select("followee_id")
        .eq("follower_id", user_id)
        .eq("status", "accepted")
        .limit(200); // followee多すぎ対策

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
  res.setHeader(
    "Access-Control-Allow-Headers",
    "content-type, mcp-session-id, accept, authorization"
  );
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
