// app — serves the built Weaver frontend straight from this Supabase
// project, so the whole product lives in one place with zero extra hosting.
//
// The compiled frontend (gzip + base64, see scripts/build-lite.mjs) lives in
// the app_assets_parts table; it is fetched and decoded once per cold start.
// Vendor libraries load in the browser from esm.sh via the page's import
// map. Anything not found falls back to index.html.

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};

let files: Record<string, string> | null = null;

async function loadFiles(): Promise<Record<string, string>> {
  if (files) return files;
  const base = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!base || !key) throw new Error("missing SUPABASE_URL / service role env");
  const res = await fetch(`${base}/rest/v1/app_assets_parts?select=seq,part&order=seq.asc`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`assets query failed: HTTP ${res.status}`);
  const rows = (await res.json()) as { seq: number; part: string }[];
  if (rows.length === 0) throw new Error("app_assets_parts is empty — run supabase/functions/app/load-assets.sql");
  const packed = rows.map((r) => r.part).join("");
  const s = atob(packed);
  const bin = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bin[i] = s.charCodeAt(i);
  const unzipped = new Blob([bin]).stream().pipeThrough(new DecompressionStream("gzip"));
  files = JSON.parse(await new Response(unzipped).text()) as Record<string, string>;
  return files;
}

Deno.serve(async (req) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  let FILES: Record<string, string>;
  try {
    FILES = await loadFiles();
  } catch (e) {
    return new Response(`The app could not load its files: ${e instanceof Error ? e.message : String(e)}`, {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const url = new URL(req.url);
  let path = url.pathname
    .replace(/^\/functions\/v1\/app\/?/, "")
    .replace(/^\/app\/?/, "")
    .replace(/^\/+/, "");
  if (!path || path.includes("..")) path = "index.html";

  let body = FILES[path];
  let served = path;
  if (body === undefined) {
    body = FILES["index.html"];
    served = "index.html";
  }
  if (body === undefined) {
    return new Response("Not found", { status: 404 });
  }
  const ext = served.split(".").pop() ?? "html";
  return new Response(req.method === "HEAD" ? null : body, {
    headers: {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
