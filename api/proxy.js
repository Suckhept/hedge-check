// Vercel serverless function: read-only GET proxy to public Lighter endpoints.
// Fallback only, used when the browser cannot reach an API directly.
// - GET only
// - exact host whitelist, https only
// - no auth: requests carrying an "auth" parameter are refused, and no
//   client headers are forwarded upstream.

const ALLOWED_HOSTS = new Set([
  "api.rh.lighter.xyz",
  "mainnet.zklighter.elliot.ai",
  "explorer.elliot.ai",
  "explorerapi.rh.lighter.xyz",
]);

export function check(raw) {
  let u;
  try { u = new URL(String(raw || "")); } catch (e) { return { error: "bad url" }; }
  if (u.protocol !== "https:" || !ALLOWED_HOSTS.has(u.hostname) || u.port || u.username || u.password) {
    return { error: "host not allowed" };
  }
  if (!u.pathname.startsWith("/api/")) return { error: "path not allowed" };
  for (const k of u.searchParams.keys()) if (k.toLowerCase().startsWith("auth")) return { error: "auth not allowed" };
  return { url: u.toString() };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method !== "GET") {
    res.status(405).json({ error: "GET only" });
    return;
  }
  const c = check(req.query && req.query.url);
  if (c.error) {
    res.status(400).json({ error: c.error });
    return;
  }
  try {
    const upstream = await fetch(c.url, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "public, s-maxage=10, max-age=10");
    res.send(text);
  } catch (e) {
    res.status(502).json({ error: "upstream failed" });
  }
}

