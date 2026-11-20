// Proxy same-origin untuk anichin.moe (halaman Donghua).
//
// Kenapa file ini ada:
//  1. Frontend tidak bisa fetch anichin.moe langsung dari browser (WordPress
//     tidak mengirim header CORS), dan *.workers.dev di-DNS-hijack sebagian
//     operator (mis. XL Axiata -> blockpage.xlaxiata.id) sehingga fetch ke
//     worker dari browser gagal total. Function ini membuat browser hanya
//     bicara ke origin sendiri (/api/anichin).
//  2. Rewrite vercel.json ("https://anichin.moe/:path*") tidak bisa
//     mempertahankan trailing slash, padahal anichin butuh "/ongoing/"
//     (tanpa slash = 403). Function ini menerima path mentah lewat ?path=
//     sehingga slash utuh.
//  3. Cloudflare anichin menantang request ber-UA non-browser. Dengan UA
//     browser + header Sec-Fetch hasilnya 200.
//
// Perbaikan penting dibanding versi sebelumnya:
//  - TIDAK lagi memakai `curl` lewat child_process. Binary curl tidak
//    dijamin ada di runtime serverless Vercel; kalau tidak ada, semua jalur
//    (termasuk fallback worker yang juga lewat curl) gagal sekaligus dan
//    halaman kosong. Sekarang semua memakai native fetch (Node 18+).
//  - Setiap percobaan dibatasi timeout (AbortController) dan SELURUH handler
//    dibungkus try/catch. Versi lama memanggil fetch tanpa try/catch dan tanpa
//    timeout: satu fetch yang throw/hang membuat function crash/timeout di
//    Vercel (batas Hobby 10 detik) -> frontend menerima halaman error ->
//    "Gagal Memuat Donghua". Sekarang kegagalan selalu menghasilkan JSON
//    502 yang rapi, dan frontend bisa lanjut ke proxy publik berikutnya.
//  - Fallback worker juga dicoba lewat native fetch (bukan curl), jadi tetap
//    berfungsi walau curl tidak terpasang.
//
// Pemakaian: /api/anichin?path=/ongoing/   (tambahkan &diag=1 untuk diagnosa)

export const config = { maxDuration: 10 };

const ORIGIN = 'https://anichin.moe';
const WORKER = 'https://cf.tiyanstores.workers.dev/?url=';
const BROWSER_UA =
  'Mozilla/5.0 (Linux; Android 13; SM-A035F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const DIRECT_TIMEOUT_MS = 6000;
const WORKER_TIMEOUT_MS = 3500;

const fetchWithTimeout = async (url, ua, timeoutMs) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent': ua,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
      },
    });
    const ab = await resp.arrayBuffer();
    return {
      status: resp.status,
      ctype: resp.headers.get('content-type') || 'text/html; charset=utf-8',
      body: Buffer.from(ab),
      err: '',
    };
  } catch (e) {
    return {
      status: 0,
      ctype: 'text/html; charset=utf-8',
      body: Buffer.alloc(0),
      err: String((e && e.message) || e).slice(0, 200),
    };
  } finally {
    clearTimeout(timer);
  }
};

const looksBlocked = (r) => {
  if (!r || !r.body || r.body.length === 0) return true;
  if (r.status === 0 || r.status >= 400) return true;
  const head = r.body.subarray(0, 400).toString('utf8');
  return /Just a moment|Access denied|Attention Required|cf-browser-verification/i.test(head);
};

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, 'https://local');
    let path = url.searchParams.get('path') || '/';
    if (!path.startsWith('/')) path = '/' + path;
    if (path.includes('://') || /[\r\n]/.test(path)) {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json');
      res.setHeader('access-control-allow-origin', '*');
      return res.end(JSON.stringify({ ok: false, error: 'path tidak diizinkan' }));
    }

    const target = ORIGIN + path;
    const clientUa = (req.headers && req.headers['user-agent']) || '';
    const ua = /Mozilla\/5\.0|Chrome\/|Safari\//i.test(clientUa) ? clientUa : BROWSER_UA;

    // 1) Langsung ke anichin.moe.
    const direct = await fetchWithTimeout(target, ua, DIRECT_TIMEOUT_MS);
    let picked = direct;
    let transport = 'direct';

    // 2) Kalau langsung diblokir/ditantang Cloudflare, coba lewat worker
    //    (dipanggil dari server, jadi blokir DNS operator tidak berpengaruh).
    if (looksBlocked(picked)) {
      const viaWorker = await fetchWithTimeout(WORKER + encodeURIComponent(target), ua, WORKER_TIMEOUT_MS);
      if (!looksBlocked(viaWorker) || picked.body.length === 0) {
        picked = viaWorker;
        transport = 'worker';
      }
    }

    if (url.searchParams.get('diag') === '1') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.setHeader('access-control-allow-origin', '*');
      return res.end(
        JSON.stringify(
          {
            target,
            transport,
            direct: { status: direct.status, bytes: direct.body.length, err: direct.err },
            worker_used: transport === 'worker',
            picked: { status: picked.status, bytes: picked.body.length, ctype: picked.ctype },
            node: process.version,
          },
          null,
          1
        )
      );
    }

    if (looksBlocked(picked)) {
      res.statusCode = 502;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.setHeader('access-control-allow-origin', '*');
      return res.end(
        JSON.stringify({ ok: false, target, transport, upstream_status: picked.status, err: picked.err })
      );
    }

    const isHtml = picked.ctype.includes('text/html');
    res.statusCode = picked.status || 502;
    res.setHeader('content-type', picked.ctype);
    res.setHeader('x-proxy-via', 'vercel-anichin');
    res.setHeader('x-proxy-transport', transport);
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('cache-control', isHtml ? 'public, max-age=60, stale-while-revalidate=300' : 'public, max-age=86400');
    return res.end(picked.body);
  } catch (e) {
    // Jangan pernah crash tanpa respons: frontend mengandalkan JSON error
    // untuk lanjut ke proxy fallback berikutnya.
    try {
      res.statusCode = 502;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.setHeader('access-control-allow-origin', '*');
      res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e).slice(0, 200) }));
    } catch {}
  }
}
