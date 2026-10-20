// Proxy same-origin untuk anichin.moe.
//
// Kenapa ada file ini:
//  - Frontend sebelumnya mengambil HTML donghua lewat Cloudflare Worker
//    (cf.tiyanstores.workers.dev). Di sebagian operator (mis. XL Axiata)
//    seluruh *.workers.dev di-DNS-hijack ke blockpage -> fetch gagal total
//    dan halaman Donghua berakhir "Gagal Memuat".
//  - Rewrite murni di vercel.json ("/anichin/:path*") tidak bisa mempertahankan
//    trailing slash (anichin butuh "/ongoing/", bukan "/ongoing"), jadi request
//    jatuh ke catch-all SPA dan yang dikirim balik index.html aplikasi.
//
// Jadi: function ini menerima path apa adanya lewat ?path=, meneruskan UA
// browser pengunjung (anichin menolak request tanpa UA), lalu mem-pipe balik
// body + content-type aslinya.

const ORIGIN = 'https://anichin.moe';
const FALLBACK_UA =
  'Mozilla/5.0 (Linux; Android 13; SM-A035F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

export default async function handler(req, res) {
  const url = new URL(req.url, 'https://local');
  let path = url.searchParams.get('path') || '/';
  if (!path.startsWith('/')) path = '/' + path;

  const target = new URL(ORIGIN + path);

  // Path yang aman saja: tidak boleh keluar dari origin anichin.
  if (target.hostname !== 'anichin.moe') {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ ok: false, error: 'host tidak diizinkan' }));
  }

  const headers = {
    'user-agent': req.headers['user-agent'] || FALLBACK_UA,
    accept:
      req.headers['accept'] ||
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': req.headers['accept-language'] || 'id-ID,id;q=0.9,en;q=0.8',
    'accept-encoding': 'gzip, deflate, br',
  };

  try {
    const started = Date.now();
    const r = await fetch(target.toString(), { headers, redirect: 'follow' });
    const ct = r.headers.get('content-type') || 'application/octet-stream';
    const isHtml = ct.includes('text/html');

    res.statusCode = r.status;
    res.setHeader('content-type', ct);
    res.setHeader('x-proxy-via', 'vercel-anichin');
    res.setHeader(
      'cache-control',
      r.ok ? (isHtml ? 'public, max-age=60, stale-while-revalidate=300' : 'public, max-age=86400') : 'no-store'
    );

    if (!r.body) return res.end();
    // Stream supaya gambar/berkas besar tidak menumpuk di memori function.
    const { Readable } = await import('node:stream');
    Readable.fromWeb(r.body).pipe(res);
    res.on('finish', () => {
      if (process.env.PROXY_DEBUG) console.log('[anichin]', r.status, path, Date.now() - started, 'ms');
    });
  } catch (err) {
    res.statusCode = 502;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err), path }));
  }
}
