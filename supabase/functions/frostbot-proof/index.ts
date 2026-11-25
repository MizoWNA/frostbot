// Frostbot warning-proof store (Supabase Edge Function) for the private `warn-proof` bucket.
//
//   POST .../frostbot-proof/upload?path=<guild>/<warn>/<file>   body = file bytes
//        Header: Authorization: Bearer <API_TOKEN>   ->  { url }  (a permanent view link)
//   GET  .../frostbot-proof/v/<path>?s=<sig>    -> 302 to a 2-minute signed URL
//
// The view link carries an HMAC of the path, so it can't be guessed, never expires, and the
// bucket itself stays private. SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.

const env = (k: string) => Deno.env.get(k) ?? '';
const API_TOKEN = env('API_TOKEN');
const SB_URL = env('SUPABASE_URL');
const SB_KEY = env('SUPABASE_SERVICE_ROLE_KEY');
const BUCKET = 'warn-proof';
const MAX = 25 * 1024 * 1024;

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const same = async (x: string, y: string) => {
  const [a, b] = await Promise.all([digest(x), digest(y)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
};
async function sign(path: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(`proof:${API_TOKEN}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(path))).slice(0, 32);
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const storage = (p: string, init: RequestInit) =>
  fetch(`${SB_URL}/storage/v1${p}`, { ...init, headers: { Authorization: `Bearer ${SB_KEY}`, apikey: SB_KEY, ...(init.headers ?? {}) } });
// Only plain path segments: guild/warn/file-name.ext
const okPath = (p: string) => /^[\w-]+\/[\w-]+\/[\w.-]{1,120}$/.test(p) && !p.includes('..');
const enc_path = (p: string) => p.split('/').map(encodeURIComponent).join('/');

Deno.serve(async (req) => {
  if (!API_TOKEN || !SB_KEY) return json(500, { error: 'not configured' });
  const url = new URL(req.url);
  const base = `${SB_URL}/functions/v1/frostbot-proof`;

  if (req.method === 'POST' && url.pathname.endsWith('/upload')) {
    if (!(await same((req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, ''), API_TOKEN))) return json(401, { error: 'unauthorized' });
    const path = url.searchParams.get('path') ?? '';
    if (!okPath(path)) return json(400, { error: 'bad path' });
    const body = await req.arrayBuffer();
    if (!body.byteLength || body.byteLength > MAX) return json(413, { error: 'empty or too big' });
    const up = await storage(`/object/${BUCKET}/${enc_path(path)}`, {
      method: 'POST',
      headers: { 'Content-Type': req.headers.get('content-type') || 'application/octet-stream', 'x-upsert': 'true' },
      body,
    });
    if (!up.ok) return json(502, { error: `storage ${up.status}: ${(await up.text()).slice(0, 200)}` });
    return json(200, { url: `${base}/v/${enc_path(path)}?s=${await sign(path)}` });
  }

  const m = url.pathname.match(/\/v\/(.+)$/);
  if (req.method === 'GET' && m) {
    const path = decodeURIComponent(m[1]);
    if (!okPath(path) || !(await same(url.searchParams.get('s') ?? '', await sign(path)))) return json(404, { error: 'not found' });
    const r = await storage(`/object/sign/${BUCKET}/${enc_path(path)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: 120 }),
    });
    if (!r.ok) return json(404, { error: 'not found' });
    const { signedURL } = await r.json();
    return new Response(null, { status: 302, headers: { Location: `${SB_URL}/storage/v1${signedURL}`, 'Cache-Control': 'no-store' } });
  }

  return json(404, { error: 'not found' });
});
