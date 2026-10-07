export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_TOKEN: string;
}

const RESERVED_SLUGS = new Set(["api", "admin"]);
const SLUG_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

function randomSlug(length = 6): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

function parseDevice(ua: string): string {
  if (/bot|crawler|spider|curl|wget/i.test(ua)) return "bot";
  if (/ipad|tablet/i.test(ua)) return "tablet";
  if (/mobi|android|iphone/i.test(ua)) return "mobile";
  return "desktop";
}

function parseBrowser(ua: string): string {
  if (/edg\//i.test(ua)) return "Edge";
  if (/opr\/|opera/i.test(ua)) return "Opera";
  if (/chrome|crios/i.test(ua)) return "Chrome";
  if (/firefox|fxios/i.test(ua)) return "Firefox";
  if (/safari/i.test(ua)) return "Safari";
  return "Other";
}

function referrerDomain(referer: string | null): string | null {
  if (!referer) return null;
  try {
    return new URL(referer).hostname;
  } catch {
    return null;
  }
}

function authorized(request: Request, env: Env): boolean {
  const header = request.headers.get("Authorization") ?? "";
  const expected = `Bearer ${env.ADMIN_TOKEN}`;
  if (!env.ADMIN_TOKEN || header.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= header.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

async function createLink(request: Request, env: Env, selfHost: string): Promise<Response> {
  let body: { url?: unknown; slug?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  let target: URL;
  try {
    target = new URL(String(body.url));
  } catch {
    return json({ error: "Invalid URL" }, 400);
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return json({ error: "Invalid URL" }, 400);
  }
  if (target.hostname === selfHost) {
    return json({ error: "URL points to this domain" }, 400);
  }

  const custom = body.slug !== undefined && body.slug !== "";
  let slug = custom ? String(body.slug) : randomSlug();
  if (!SLUG_RE.test(slug) || RESERVED_SLUGS.has(slug.toLowerCase())) {
    return json({ error: "Invalid slug" }, 400);
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await env.DB.prepare("INSERT INTO links (slug, url, created_at) VALUES (?, ?, ?)")
        .bind(slug, target.toString(), Date.now())
        .run();
      return json({ slug, url: target.toString(), short: `https://${selfHost}/${slug}` }, 201);
    } catch (e) {
      if (!String(e).includes("UNIQUE")) throw e;
      if (custom) return json({ error: "Slug already exists" }, 409);
      slug = randomSlug();
    }
  }
  return json({ error: "Could not generate a slug" }, 500);
}

async function listLinks(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT l.slug, l.url, l.created_at, COUNT(c.id) AS clicks
     FROM links l LEFT JOIN clicks c ON c.slug = l.slug
     GROUP BY l.slug ORDER BY l.created_at DESC`,
  ).all();
  return json(results);
}

async function deleteLink(env: Env, slug: string): Promise<Response> {
  const [, res] = await env.DB.batch([
    env.DB.prepare("DELETE FROM clicks WHERE slug = ?").bind(slug),
    env.DB.prepare("DELETE FROM links WHERE slug = ?").bind(slug),
  ]);
  if (!res.meta.changes) return json({ error: "Not found" }, 404);
  return json({ deleted: slug });
}

async function linkStats(env: Env, slug: string): Promise<Response> {
  const link = await env.DB.prepare("SELECT slug, url FROM links WHERE slug = ?").bind(slug).first();
  if (!link) return json({ error: "Not found" }, 404);

  const group = (col: string) =>
    env.DB.prepare(
      `SELECT COALESCE(${col}, 'unknown') AS label, COUNT(*) AS count
       FROM clicks WHERE slug = ? GROUP BY label ORDER BY count DESC LIMIT 20`,
    ).bind(slug);

  const [byDay, byCountry, byDevice, bySource, total] = await env.DB.batch([
    env.DB.prepare(
      `SELECT date(ts / 1000, 'unixepoch') AS day, COUNT(*) AS count
       FROM clicks WHERE slug = ? GROUP BY day ORDER BY day`,
    ).bind(slug),
    group("country"),
    group("device"),
    group("referrer"),
    env.DB.prepare("SELECT COUNT(*) AS total FROM clicks WHERE slug = ?").bind(slug),
  ]);

  return json({
    ...link,
    total: (total.results[0] as { total: number }).total,
    byDay: byDay.results,
    byCountry: byCountry.results,
    byDevice: byDevice.results,
    bySource: bySource.results,
  });
}

async function redirect(request: Request, env: Env, ctx: ExecutionContext, slug: string): Promise<Response> {
  const link = await env.DB.prepare("SELECT url FROM links WHERE slug = ?").bind(slug).first<{ url: string }>();
  if (!link) return new Response("Not found", { status: 404 });

  const ua = request.headers.get("User-Agent") ?? "";
  const cf = request.cf as { country?: string; city?: string } | undefined;
  ctx.waitUntil(
    env.DB.prepare(
      "INSERT INTO clicks (slug, ts, country, city, device, browser, referrer) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        slug,
        Date.now(),
        cf?.country ?? null,
        cf?.city ?? null,
        parseDevice(ua),
        parseBrowser(ua),
        referrerDomain(request.headers.get("Referer")),
      )
      .run(),
  );

  // 302 on purpose: a 301 gets cached by the browser and later clicks would not be counted.
  return Response.redirect(link.url, 302);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/admin" || path === "/admin/") {
      return env.ASSETS.fetch(new Request(new URL("/admin.html", url), request));
    }

    if (path.startsWith("/api/")) {
      if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401);

      const parts = path.split("/").filter(Boolean); // ["api", "links", slug?, "stats"?]
      if (parts[1] !== "links") return json({ error: "Not found" }, 404);

      if (parts.length === 2) {
        if (request.method === "POST") return createLink(request, env, url.hostname);
        if (request.method === "GET") return listLinks(env);
      } else if (parts.length === 3 && request.method === "DELETE") {
        return deleteLink(env, decodeURIComponent(parts[2]));
      } else if (parts.length === 4 && parts[3] === "stats" && request.method === "GET") {
        return linkStats(env, decodeURIComponent(parts[2]));
      }
      return json({ error: "Not found" }, 404);
    }

    if (request.method === "GET" && /^\/[^/]+$/.test(path)) {
      return redirect(request, env, ctx, decodeURIComponent(path.slice(1)));
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
