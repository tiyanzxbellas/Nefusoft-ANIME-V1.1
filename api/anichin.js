// Proxy same-origin untuk anichin.moe via curl.
//
// Sejarah:
//  - Dulu HTML donghua lewat Cloudflare Worker (*.workers.dev), tapi di sebagian
//    operator (mis. XL Axiata) praktis SEMUA *.workers.dev di-DNS-hijack ->
//    halaman Donghua selalu "Gagal Memuat".
//  - Rewrite vercel.json "https://anichin.moe/:path*" tidak bisa mempertahankan
//    trailing slash (anichin butuh /ongoing/ bukan /ongoing).
//  - fetch() Node di Vercel = undici -> fingerprint TLS-nya BLOKIR oleh Cloudflare
//    anichin (HTTP 403 "Access denied"). Curl 8.21.0 yang tersedia di runtime
//    Vercel lolos (sama seperti transport curl di Aisoft2 API untuk animein).
//
// Pemakaian: /api/anichin?path=/ongoing/  (path dikirim apa adanya, trailing slash tetap)

const ORIGIN = 'https://anichin.moe';
const FALLBACK_UA =
  'Mozilla/5.0 (Linux; Android 13; SM-A035F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const MAX_BYTES = 16 * 1024 * 1024; // guard memori function

export default async function handler(req, res) {
  const url = new URL(req.url, 'https://local');
  let path = url.searchParams.get('path') || '/';
  if (!path.startsWith('/')) path = '/' + path;

  if (path.includes('://')) {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ ok: false, error: 'path tidak diizinkan' }));
  }

  const target = ORIGIN + path;
  const ua = (req.headers['user-agent'] || FALLBACK_UA).replace(/'/g, '');
  // hanya izinkan karakter path yang wajar (anti CRLF/header injection lewat query)
  if (/[\r\n]/.test(path)) {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ ok: false, error: 'path tidak diizinkan' }));
  }

  let out = Buffer.alloc(0);
  try {
    const { execFile } = await import('node:child_process');
    out = await new Promise((resolve) => {
      execFile('curl', [
        '-sS', '-L', '--max-time', '25', '--compressed',
        '--user-agent', ua,
        '--accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        '--accept-language', 'id-ID,id;q=0.9,en;q=0.8',
        '-w', '\n__CURL_STATUS__%{http_code}__CURL_CT__%{content_type}',
        '--', target,
      ], { encoding: 'buffer', maxBuffer: MAX_BYTES, timeout: 28000 }, (err, stdout) => {
        if (stdout && stdout.length) resolve(stdout);
        else resolve(Buffer.alloc(0));
      });
    });
  } catch (err) {
    res.statusCode = 502;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
  }

  // curl breathes -w di akhir; pisahkan body dari trailer __CURL_STATUS__
  const buf = out;
  const marker = Buffer.from('\n__CURL_STATUS__');
  const idx = buf.lastIndexOf(marker);
  const body = idx >= 0 ? buf.subarray(0, idx) : buf;
  const meta = idx >= 0 ? buf.subarray(idx + marker.length).toString('latin1') : '0';
  const m = meta.match(/^([\d]+)__CURL_CT__(.*)$/);
  const status = m ? parseInt(m[1], 10) : 502;
  const ctype = m && m[2] ? m[2] : 'text/html; charset=utf-8';
  const isHtml = ctype.includes('text/html');

  res.statusCode = status || 502;
  res.setHeader('content-type', ctype);
  res.setHeader('x-proxy-via', 'vercel-anichin-curl');
  if (!isHtml) res.setHeader('cache-control', 'public, max-age=86400');
  else if (status === 200) res.setHeader('cache-control', 'public, max-age=60, stale-while-revalidate=300');
  else res.setHeader('cache-control', 'no-store');
  res.setHeader('x-upstream-url', target);
  res.end(body);
}
