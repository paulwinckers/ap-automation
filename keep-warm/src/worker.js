/**
 * Darios keep-warm Worker.
 *
 * A Cloudflare Cron Trigger (every 5 min, see wrangler.toml) hits the FastAPI
 * backend's /health endpoint so the Railway container never idles to sleep.
 * Without this, the first request to any page after an idle period waits ~8s
 * for the container to cold-start.
 *
 * It also answers normal HTTP requests so you can manually confirm it's alive:
 *   https://darios-keepwarm.<your-subdomain>.workers.dev
 */

const DEFAULT_URL = "https://ap-automation-production.up.railway.app/health";

async function ping(env) {
  const url = (env && env.HEALTH_URL) || DEFAULT_URL;
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": "darios-keepwarm/1.0" },
      // Never serve a cached response — we want to actually reach the origin.
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    const ms = Date.now() - started;
    console.log(`keep-warm ${url} -> ${res.status} in ${ms}ms`);
    return { ok: res.ok, status: res.status, ms, url };
  } catch (err) {
    const ms = Date.now() - started;
    console.log(`keep-warm ${url} -> ERROR after ${ms}ms: ${err}`);
    return { ok: false, status: 0, ms, url, error: String(err) };
  }
}

export default {
  // Runs on the cron schedule.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(ping(env));
  },

  // Manual check in a browser / curl.
  async fetch(request, env) {
    const r = await ping(env);
    return new Response(JSON.stringify(r, null, 2), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
};
