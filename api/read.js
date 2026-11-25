// AIDL Studio · 공모전 링크 읽기 서버 함수
// 브라우저가 CORS 때문에 직접 읽지 못하는 공고 페이지를 대신 읽고,
// '모집 요강·공모 안내' 같은 하위 페이지를 최대 3개까지 함께 가져옵니다.
const dns = require('dns').promises;
const net = require('net');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const MAX_HTML = 3_000_000;
const MAX_FILE = 3_000_000; // 응답 한도(4.5MB) 안에 base64로 담을 수 있는 크기
const BLOCKED = /접근이\s*제한|접속할\s*수\s*없|접근\s*권한이\s*없|Access\s*(is\s*)?(restricted|denied)|403\s*Forbidden|Just a moment|Attention Required|Checking your browser|captcha|cf-chl|로봇이\s*아닙니다/i;
const SUBLINK = /요강|모집|공모\s*안내|공고|안내|참가|응모|가이드|guide|info|notice|apply|about|overview|detail/i;
const SUBSKIP = /로그인|login|회원가입|join|signup|logout|mypage|마이페이지|qna|faq|privacy|개인정보|이용약관|terms|javascript:|mailto:|tel:/i;

function privateIP(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const x = ip.toLowerCase();
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80') || x.startsWith('::ffff:127.') || x.startsWith('::ffff:10.') || x.startsWith('::ffff:192.168.');
}

async function safeURL(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('주소 형식이 올바르지 않습니다.'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('http 또는 https 공개 주소만 읽을 수 있습니다.');
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(u.hostname)) throw new Error('내부 주소는 읽을 수 없습니다.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => { throw new Error('사이트 주소를 찾을 수 없습니다.'); });
  if (!addrs.length || addrs.some(a => privateIP(a.address))) throw new Error('내부 주소는 읽을 수 없습니다.');
  return u;
}

async function get(url, ms = 12000) {
  let u = await safeURL(url);
  for (let hop = 0; hop < 5; hop++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    let res;
    try {
      res = await fetch(u.href, { redirect: 'manual', signal: ctrl.signal, headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/pdf,image/*;q=0.9,*/*;q=0.8', 'accept-language': 'ko-KR,ko;q=0.9,en;q=0.6' } });
    } catch (e) {
      throw new Error(ctrl.signal.aborted ? '사이트 응답이 너무 느립니다.' : '사이트에 연결하지 못했습니다.');
    } finally { clearTimeout(t); }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { u = await safeURL(new URL(res.headers.get('location'), u).href); continue; }
    return { res, url: u };
  }
  throw new Error('이동(리다이렉트)이 너무 많습니다.');
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', hellip: '…', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•' };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(n); } catch { return m; } }
    return ENT[e.toLowerCase()] ?? m;
  });
}
function htmlText(html) {
  let h = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1>/gi, ' ');
  const main = h.match(/<main\b[\s\S]*?<\/main>/i) || h.match(/<article\b[\s\S]*?<\/article>/i);
  if (main && main[0].replace(/<[^>]+>/g, '').trim().length > 200) h = main[0];
  h = h.replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/dt|\/dd|\/td|\/th)\b[^>]*>/gi, '\n');
  return decode(h.replace(/<[^>]+>/g, ' ')).replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim();
}
function title(html) { const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i); return m ? decode(m[1]).trim() : ''; }
function subLinks(html, base) {
  const out = [], seen = new Set([base.href.split('#')[0]]);
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let u; try { u = new URL(decode(m[1]), base); } catch { continue; }
    const href = u.href.split('#')[0], label = decode(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (u.host !== base.host || seen.has(href) || /\.(jpe?g|png|gif|zip|hwp|pdf)$/i.test(u.pathname)) continue;
    if (!(SUBLINK.test(label) || SUBLINK.test(u.pathname)) || SUBSKIP.test(label + ' ' + href)) continue;
    seen.add(href); out.push({ href, label });
    if (out.length >= 3) break;
  }
  return out;
}
const blocked = (status, text) => status === 401 || status === 403 || status === 429 || (BLOCKED.test(text.slice(0, 1500)) && text.replace(/\s+/g, '').length < 2500);

module.exports = async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  const send = (code, body) => { res.statusCode = code; res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body)); };
  try {
    const target = (req.query && req.query.url) || new URL(req.url, 'http://x').searchParams.get('url');
    if (!target) return send(400, { ok: false, error: '읽을 주소(url)가 없습니다.' });
    const { res: r, url } = await get(target);
    const ct = r.headers.get('content-type') || '';
    if (/pdf|image\//i.test(ct)) {
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MAX_FILE) return send(200, { ok: false, error: '파일이 커서 링크로 읽을 수 없습니다. 내려받아 직접 첨부하세요.' });
      const ext = /pdf/.test(ct) ? 'pdf' : /png/.test(ct) ? 'png' : /webp/.test(ct) ? 'webp' : 'jpg';
      return send(200, { ok: true, file: buf.toString('base64'), type: ct.split(';')[0], ext });
    }
    const html = (await r.text()).slice(0, MAX_HTML);
    const text = /html/i.test(ct) ? htmlText(html) : html;
    if (blocked(r.status, text)) return send(200, { ok: false, blocked: true, error: '사이트가 자동 읽기를 차단했습니다.' });
    if (!r.ok) return send(200, { ok: false, error: '사이트 응답 ' + r.status });
    const pages = [{ url: url.href, title: title(html), text }];
    if (/html/i.test(ct)) {
      const subs = await Promise.all(subLinks(html, url).map(async l => {
        try {
          const { res: s } = await get(l.href, 9000);
          if (!s.ok || !/html/i.test(s.headers.get('content-type') || '')) return null;
          const h = (await s.text()).slice(0, MAX_HTML), t = htmlText(h);
          return t.length > 80 && !blocked(s.status, t) ? { url: l.href, title: l.label || title(h), text: t } : null;
        } catch { return null; }
      }));
      pages.push(...subs.filter(Boolean));
    }
    return send(200, { ok: true, pages });
  } catch (e) {
    return send(200, { ok: false, error: String((e && e.message) || e) });
  }
};
