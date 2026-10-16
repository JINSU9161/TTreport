/**
 * ttreport Worker
 *
 * Serves index.html from the (private) GitHub repo at https://ttreport.connectnai.com.
 * The file is fetched through the GitHub Contents API (raw media type), cached at the
 * edge, and sent to the browser with our own set of headers. Nothing from GitHub's
 * response headers or error bodies is passed through to the client.
 */

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdn.sheetjs.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self' https://obfmbmkmiimzohztpghl.supabase.co",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "X-Robots-Tag": "noindex, nofollow",
  "Strict-Transport-Security": "max-age=31536000",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

const HTML_PATHS = new Set(["/", "/index.html"]);
const GITHUB_TIMEOUT_MS = 8000;
// How long the edge keeps a copy around as a fallback for GitHub outages.
// Freshness itself is controlled by CACHE_TTL via the X-Fetched-At header.
const STALE_KEEP_SECONDS = 7 * 24 * 60 * 60;

const UNAVAILABLE_HTML = `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>일시적으로 사용할 수 없음</title></head>
<body style="font-family:sans-serif;padding:2rem;color:#1E293B">
<h1 style="font-size:1.25rem">잠시 후 다시 시도해 주세요</h1>
<p>페이지를 불러오지 못했습니다. 잠시 후 새로고침해 주세요.</p>
</body></html>`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;

    if (url.pathname === "/healthz") {
      if (method !== "GET" && method !== "HEAD") return methodNotAllowed();
      return textResponse("ok", 200, method);
    }

    if (!HTML_PATHS.has(url.pathname)) {
      if (method !== "GET" && method !== "HEAD") return methodNotAllowed();
      return textResponse("Not Found", 404, method);
    }

    if (method !== "GET" && method !== "HEAD") return methodNotAllowed();

    try {
      return await serveIndex(request, env, ctx, url);
    } catch (err) {
      console.error("unhandled error", err && err.message);
      return unavailable(method);
    }
  },
};

async function serveIndex(request, env, ctx, url) {
  const method = request.method;
  const ttl = parseTtl(env.CACHE_TTL);
  const cache = caches.default;
  // Synthetic cache key on our own hostname. The path is not reachable from outside
  // (any request to it falls through to the 404 branch above).
  const cacheKey = new Request(
    `${url.origin}/__ttreport_cache/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(
      env.GITHUB_REPO
    )}/${encodeURIComponent(env.GITHUB_BRANCH)}/index.html`,
    { method: "GET" }
  );

  const cached = await cache.match(cacheKey);
  if (cached) {
    const fetchedAt = Number(cached.headers.get("X-Fetched-At")) || 0;
    if (Date.now() - fetchedAt < ttl * 1000) {
      return htmlResponse(request, await cached.text(), cached.headers.get("X-Upstream-ETag"), "HIT");
    }
  }

  const upstream = await fetchFromGitHub(env, cached ? cached.headers.get("X-Upstream-ETag") : null);

  if (upstream.ok) {
    const etag = upstream.etag;
    ctx.waitUntil(cache.put(cacheKey, cacheEntry(upstream.body, etag)));
    return htmlResponse(request, upstream.body, etag, "MISS");
  }

  if (upstream.notModified && cached) {
    const body = await cached.text();
    const etag = cached.headers.get("X-Upstream-ETag");
    ctx.waitUntil(cache.put(cacheKey, cacheEntry(body, etag)));
    return htmlResponse(request, body, etag, "REVALIDATED");
  }

  if (cached) {
    return htmlResponse(request, await cached.text(), cached.headers.get("X-Upstream-ETag"), "STALE");
  }

  return unavailable(method);
}

async function fetchFromGitHub(env, previousEtag) {
  const apiUrl =
    `https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER)}/` +
    `${encodeURIComponent(env.GITHUB_REPO)}/contents/index.html?ref=${encodeURIComponent(env.GITHUB_BRANCH)}`;

  const headers = {
    Accept: "application/vnd.github.raw",
    "User-Agent": "ttreport-worker",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  if (previousEtag) headers["If-None-Match"] = previousEtag;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS);
  try {
    const res = await fetch(apiUrl, { headers, signal: controller.signal });
    if (res.status === 304) return { ok: false, notModified: true };
    if (!res.ok) {
      // Log only the status (no body, no headers) so nothing sensitive ends up in logs.
      console.error("github fetch failed", res.status);
      return { ok: false };
    }
    const body = await res.text();
    if (!body) return { ok: false };
    return { ok: true, body, etag: res.headers.get("ETag") };
  } catch (err) {
    console.error("github fetch error", err && err.name);
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

function cacheEntry(body, etag) {
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": `public, max-age=${STALE_KEEP_SECONDS}`,
    "X-Fetched-At": String(Date.now()),
  });
  if (etag) headers.set("X-Upstream-ETag", etag);
  return new Response(body, { headers });
}

function htmlResponse(request, body, etag, cacheStatus) {
  const headers = new Headers(SECURITY_HEADERS);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-cache");
  headers.set("X-Cache", cacheStatus);
  if (etag) headers.set("ETag", etag);

  const ifNoneMatch = request.headers.get("If-None-Match");
  if (etag && ifNoneMatch && ifNoneMatch === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : body, { status: 200, headers });
}

function textResponse(text, status, method) {
  const headers = new Headers(SECURITY_HEADERS);
  headers.set("Content-Type", "text/plain; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(method === "HEAD" ? null : text, { status, headers });
}

function methodNotAllowed() {
  const headers = new Headers(SECURITY_HEADERS);
  headers.set("Content-Type", "text/plain; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("Allow", "GET, HEAD");
  return new Response("Method Not Allowed", { status: 405, headers });
}

function unavailable(method) {
  const headers = new Headers(SECURITY_HEADERS);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("Retry-After", "60");
  return new Response(method === "HEAD" ? null : UNAVAILABLE_HTML, { status: 503, headers });
}

function parseTtl(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : 300;
}
