// Helper proxy + scraper untuk halaman Donghua (anichin.moe).
//
// Kenapa file ini ada:
// Halaman Donghua tidak memakai JSON API seperti halaman Anime/Manga, melainkan
// mengikis (scrape) HTML dari anichin.moe (WordPress). WordPress tidak mengirim
// header CORS, jadi browser tidak bisa fetch langsung — harus lewat proxy.
//
// Dulu hanya ada 2 jalur: (1) same-origin /api/anichin (serverless Vercel) dan
// (2) Cloudflare Worker cf.tiyanstores.workers.dev. Keduanya rapuh:
//   - *.workers.dev di-DNS-hijack sebagian operator (mis. XL Axiata ->
//     blockpage.xlaxiata.id), jadi jalur (2) gagal total di jaringan itu.
//   - Jalur (1) tergantung function Vercel yang mengambil anichin dari IP
//     datacenter; kalau Cloudflare menantang IP itu / function timeout,
//     jalur (1) ikut gagal. Hasilnya halaman kosong -> "Gagal Memuat Donghua".
//
// Sekarang ada rantai fallback berurutan (proxyCandidates): same-origin dulu,
// lalu proxy CORS publik yang IP-nya berbeda (allorigins, codetabs, corsproxy),
// baru worker, terakhir direct. Selama SATU saja yang berhasil, halaman tetap
// tampil. Semua percobaan dibatasi timeout agar tidak menggantung selamanya.

export const API_BASE = 'https://anichin.moe';

const WORKER = 'https://cf.tiyanstores.workers.dev/?url=';

// Anichin rotated its domain: anichin.cafe is dead (NXDOMAIN, delegation dropped).
// Main site is anichin.moe (anichin.care is only the official landing page).
export const absUrl = (url) => {
  if (!url) return '';
  if (/^(https?:)?\/\//i.test(url) || url.startsWith('data:') || url.startsWith('blob:')) return url;
  return `${API_BASE}${url.startsWith('/') ? '' : '/'}${url}`;
};

const ANICHIN_HOSTS = /(^|\.)anichin\.(moe|care|cafe)$/i;

export const anichinPath = (url) => {
  const abs = absUrl(url);
  if (!abs) return '';
  try {
    const u = new URL(abs);
    if (!ANICHIN_HOSTS.test(u.hostname)) return null;
    return `/api/anichin?path=${encodeURIComponent(u.pathname + u.search)}`;
  } catch {
    return null;
  }
};

export const getApiUrl = (url) => {
  const same = anichinPath(url);
  if (same) return same;
  return `${WORKER}${encodeURIComponent(absUrl(url))}`;
};

export const getProxyUrl = (url) => {
  const abs = absUrl(url);
  if (!abs) return '';
  const same = anichinPath(abs);
  if (same) return same;
  // Host lain (embed/streaming pihak ketiga) tetap lewat worker.
  return `${WORKER}${encodeURIComponent(abs)}`;
};

// Daftar kandidat proxy untuk mengambil HTML, dari yang paling diandalkan ke
// yang paling terakhir. Urutan penting: same-origin (tanpa CORS, tanpa blokir
// DNS operator) -> proxy publik non-workers.dev -> worker (sering diblokir
// operator) -> direct (hanya berhasil kalau situs mengirim CORS).
export const proxyCandidates = (url) => {
  const abs = absUrl(url);
  if (!abs) return [];
  const list = [];
  const same = anichinPath(abs);
  if (same) list.push(same);
  list.push(`https://api.allorigins.win/raw?url=${encodeURIComponent(abs)}`);
  list.push(`https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(abs)}`);
  list.push(`https://corsproxy.io/?url=${encodeURIComponent(abs)}`);
  list.push(`${WORKER}${encodeURIComponent(abs)}`);
  list.push(abs);
  return list;
};

// Cek apakah respons terlihat seperti HTML asli dari anichin.moe (bukan
// index.html SPA dari catch-all, bukan JSON error 502 dari proxy, bukan
// halaman challenge Cloudflare / blockpage operator).
//
// Validator lama hanya menerima 'bsx' / 'swiper-slide', padahal halaman
// detail & episode anichin tidak selalu punya penanda itu (isinya
// .eplister / .entry-title). Akibatnya HTML yang sebenarnya valid ditolak
// lalu ditimpa hasil fallback yang lebih buruk. Sekarang semua penanda
// konten asli anichin diterima.
export const isValidAnichinHtml = (html) => {
  if (!html || typeof html !== 'string' || html.length < 500) return false;
  const trimmed = html.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return false;
  const lower = html.toLowerCase();
  if (lower.includes('nefu-initial-loading')) return false;
  if (lower.includes('id="root"') && lower.includes('/src/main.jsx')) return false;
  if (/just a moment|attention required|cf-browser-verification|access denied/.test(lower)) return false;
  return (
    lower.includes('bsx') ||
    lower.includes('swiper-slide') ||
    lower.includes('listupd') ||
    lower.includes('bixbox') ||
    lower.includes('eplister') ||
    lower.includes('entry-title') ||
    lower.includes('wp-content/uploads')
  );
};

const fetchWithTimeout = async (url, ms = 10000) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
};

// Ambil HTML lewat rantai proxy: kembalikan HTML pertama yang valid. Kalau
// tidak ada yang valid, kembalikan HTML terpanjang yang masih masuk akal
// (bukan JSON error / SPA) supaya parser masih punya kesempatan, bukan
// langsung kosong.
const fetchHtmlWithFallback = async (url) => {
  const candidates = proxyCandidates(url);
  let best = '';
  for (const candidate of candidates) {
    try {
      const html = await fetchWithTimeout(candidate, 10000);
      if (isValidAnichinHtml(html)) return html;
      if (
        html &&
        html.length > best.length &&
        !html.trimStart().startsWith('{') &&
        !html.toLowerCase().includes('nefu-initial-loading')
      ) {
        best = html;
      }
    } catch {
      // Proxy ini gagal (timeout / DNS diblokir / CORS) -> coba berikutnya.
    }
  }
  return best;
};

export const fetchAnichinHtml = fetchHtmlWithFallback;
export const fetchProxyHtml = fetchHtmlWithFallback;

// Resizer poster.
// Poster asli dari anichin.moe besarnya 60-500 KB (sampai 960x1280 px), padahal
// di kartu cuma dipakai 120x180 px. Browser tetap harus decode resolusi penuh
// (~4,9 MB bitmap per gambar), dan di halaman Donghua ada >100 kartu -> itu
// penyebab utama scroll berat. wsrv.nl bikin versi kecil + webp: payload turun
// ~90% dan beban decode ikut turun drastis.
export const wsrvUrl = (url, width) => {
  const abs = absUrl(url);
  if (!abs) return '';
  if (!/^https?:/i.test(abs)) return abs;
  return `https://wsrv.nl/?url=${encodeURIComponent(abs)}&w=${width}&output=webp&q=72&we`;
};

// Kalau resizer gagal (host down / rate limit), <img> balik ke proxy
// same-origin, lalu ke allorigins sebagai tahap terakhir. dataset.fallback
// adalah penghitung tahap (0 -> 1 -> 2) supaya tidak loop onError selamanya.
export const onImgError = (e) => {
  const el = e.currentTarget;
  if (!el) return;
  const raw = el.dataset.raw;
  if (!raw) return;
  const stage = parseInt(el.dataset.fallback || '0', 10);
  if (stage === 0) {
    const next = getProxyUrl(raw);
    if (next && el.src !== next) {
      el.dataset.fallback = '1';
      el.src = next;
      return;
    }
    el.dataset.fallback = '2';
    el.src = `https://api.allorigins.win/raw?url=${encodeURIComponent(absUrl(raw))}`;
  } else if (stage === 1) {
    el.dataset.fallback = '2';
    el.src = `https://api.allorigins.win/raw?url=${encodeURIComponent(absUrl(raw))}`;
  }
  // stage >= 2: menyerah, biarkan alt text yang tampil.
};
