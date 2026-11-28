// ==========================================================================================
// SetFilmIzle Scraper for Nuvio Local Scrapers
// ------------------------------------------------------------------------------------------
// Kaynak: setfilm-scraper.js (tek dosya Node scraper) birebir JavaScript'e cevirilmistir.
//
// Site : https://www.setfilmizle.ltd  (WordPress + "setfilm" tema, film / dizi, Turkce)
//
// AKIS HARITASI
//   GET /wp-admin/admin-ajax.php?action=stf_live_search&keyword=<q> .. canli arama (JSON)
//   GET /?s=<q> .................................................... HTML arama (yedek)
//   GET /film/<slug>/ .............................................. film detayi (post-id + nonce)
//   GET /dizi/<slug>/ .............................................. dizi detayi (sezon panelleri)
//   GET /bolum/<slug>-S-sezon-E-bolum/ ............................. bolum detayi
//   POST admin-ajax action=get_video_url (nonce, post_id, SetPlay) . stream JSON'u
//   GET <bridge setplay.sbs/stfplay.php?t=..> ...................... SPG.cerceve("id","b64","key")
//   bridge base64+XOR cozumu ....................................... fastplay.mom/stfplay.php?v=..
//   GET <fastplay> ................................................. window.STF_KOPRU = {src, subtitles}
//   window.SPG_A = {sp, spT} -> X-Sp = "<spT>.<rand36>.<fnv1a32(sp|spT|rand)>" (WAF basligi)
//   GET <fastplay origin>/manifests/<id>/master.txt (X-Sp ile) ..... HLS master playlist
//
// scraper v2 hizalama notlari:
//   - Segment istekleri (srv.*.cfd, .png maskeli MPEG-TS) de X-Sp ister; Nuvio akis
//     girdisindeki headers tum oynatma oturumuna uygulanir (manifest + segment).
//   - Yanlis etiketli eslesme yedegi: film/ -> dizi/ -> bolum/ aday dongusu
//     (buildStreamsForPage icinde; scraper v2 getSources mantiginin karsiligi).
//   - Harici altyazilarda lang yerine kind alani olabilir (lang || kind yedegi).
//   - StreamProxy / serve komutu ve binary segment indirme yalnizca Node CLI icindir;
//     Nuvio oynaticisi headers alanindaki X-Sp/Referer/Origin ile dogrudan oynatir.
//
// scraper v3 hizalama notlari (setfilm-scraper.js guncel surumu):
//   - X-Sp bir NONCE'dir: ayni deger ikinci kez gonderilirse 404 (replay korumasi).
//     Her istekte yeni rand uretilir; zaman damgasi sayfa render anindan gecen
//     sureyle ilerletilir: buildXSp(sp, spT, pageAt).
//   - Manifest istekleri 404/403/429/520-524 donerse artan beklemeyle yeni X-Sp
//     uretilerek tekrar denenir (parseManifest mantiginin karsiligi).
//   - Guard akisi 7 denemeye genisletildi (800/1500/2500/4000/6000/8000 ms); her
//     denemede fastplay sayfasi tazelenir, STF_KOPRU + SPG_A yeniden okunur.
//   - get_video_url basarisizsa bir kez taze=1 parametresiyle yeniden denenir.
//   - Icerik sayfasinda nonce yoksa anasayfa ('/') nonce'u yedek olarak kullanilir.
//
// WAF KURALLARI (fastplay.mom):
//   - .m3u8/.txt istekleri X-Sp basligi olmadan -> 404
//   - Ayni X-Sp degeri ikinci kez -> 404 (replay korumasi)
//   - "Accept: text/html..." ve Accept-Language basliklari m3u8 isteklerinde -> 404
//     (medya isteklerinde Accept: */* ve Accept-Language YOK gonderilir)
//   - X-Sp zaman damgasi fastplay sayfasinin render anina baglidir; hata alinirsa
//     fastplay sayfasi yeniden cekilip guard tazelenir.
//
// Nuvio sozlesmesi: module.exports = { getStreams }
//   getStreams(id, mediaType, season, episode) -> Promise<[{name,title,url,quality,size,headers,subtitles}]>
//   id: TMDB id (sayi) veya IMDB id ("tt1234567") | mediaType: "movie" | "tv"
//
// HAYATA GERCEK ORTAMDA (Hermes): async/await YOK — tamami Promise zinciri, ES5 tarzidir.
// ==========================================================================================
'use strict';

var BASE_URL = 'https://www.setfilmizle.ltd';
var AJAX_URL = BASE_URL + '/wp-admin/admin-ajax.php';

var USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

var TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
var TMDB_BASE_URL = 'https://api.themoviedb.org/3';
var CINEMETA_URL = 'https://v3-cinemeta.strem.io/meta/';

function originOf(url) {
  var m = String(url || '').match(/^(https?:\/\/[^\/]+)/i);
  return m ? m[1] : String(url || '');
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// ==========================================================================================
// 0) Cevrim disi yardimcilar
// ==========================================================================================

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#([0-9]+);/g, function (m, d) { return String.fromCharCode(parseInt(d, 10)); })
    .replace(/&#x([0-9a-fA-F]+);/g, function (m, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&shy;/g, '');
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function attr(html, name) {
  var m = new RegExp(name + '\\s*=\\s*"([^"]*)"', 'i').exec(html || '');
  return m ? decodeEntities(m[1]) : '';
}

/** Turkce karakterleri ASCII'ye katlar. */
function asciiFold(s) {
  var map = {
    'ı': 'i', 'İ': 'i', 'ş': 's', 'Ş': 's', 'ğ': 'g', 'Ğ': 'g',
    'ü': 'u', 'Ü': 'u', 'ö': 'o', 'Ö': 'o', 'ç': 'c', 'Ç': 'c',
    'â': 'a', 'î': 'i', 'û': 'u', 'ê': 'e',
  };
  var out = '';
  var str = String(s || '');
  for (var i = 0; i < str.length; i++) {
    var c = map[str[i]];
    out += (typeof c !== 'undefined') ? c : str[i];
  }
  return out.toLowerCase();
}

function normalizeTitle(s) {
  if (!s) return '';
  return asciiFold(s).replace(/[^a-z0-9]/g, '');
}

function yearOf(dateStr) {
  if (!dateStr) return null;
  var m = String(dateStr).match(/([0-9]{4})/);
  return m ? parseInt(m[1], 10) : null;
}

function diceSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  var map = {};
  for (var i = 0; i < a.length - 1; i++) {
    var bg = a.substr(i, 2);
    map[bg] = (map[bg] || 0) + 1;
  }
  var hits = 0;
  for (var j = 0; j < b.length - 1; j++) {
    var bg2 = b.substr(j, 2);
    if (map[bg2]) { map[bg2]--; hits++; }
  }
  return (2 * hits) / (a.length - 1 + b.length - 1);
}

function resolveUrl(url, baseUrl) {
  url = String(url || '');
  if (url.indexOf('http://') === 0 || url.indexOf('https://') === 0) return url;
  if (url.indexOf('//') === 0) return 'https:' + url;
  if (url.indexOf('/') === 0) return originOf(baseUrl) + url;
  return baseUrl.slice(0, baseUrl.lastIndexOf('/') + 1) + url;
}

// --- Base64 + XOR (Buffer yok: saf JS) ---------------------------------

function b64ToBytes(s) {
  var input = String(s || '').replace(/\\-/g, '+').replace(/_/g, '/').replace(/\\\//g, '/').replace(/[^A-Za-z0-9+\/=]/g, '');
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var lookup = {};
  for (var c = 0; c < 64; c++) lookup[chars[c]] = c;
  var out = [];
  var buffer = 0, bits = 0;
  for (var i = 0; i < input.length; i++) {
    var ch = input[i];
    if (ch === '=') break;
    var v = lookup[ch];
    if (typeof v === 'undefined') continue;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return out;
}

function bytesToString(bytes) {
  var out = '';
  var CHUNK = 4096;
  for (var i = 0; i < bytes.length; i += CHUNK) {
    var part = bytes.slice(i, i + CHUNK);
    var raw = '';
    for (var j = 0; j < part.length; j++) raw += String.fromCharCode(part[j]);
    try {
      out += decodeURIComponent(escape(raw));
    } catch (e) {
      out += raw;
    }
  }
  return out;
}

/** Bridge sayfasinin base64(+XOR) payload'ini cozer; donus: '|' ile ayrilmis parcalar. */
function xorDecode(b64a, b64b) {
  var a = b64ToBytes(b64a);
  var b = b64ToBytes(b64b || '');
  if (!b.length) return [bytesToString(a)];
  var out = '';
  for (var i = 0; i < a.length; i++) {
    out += String.fromCharCode(a[i] ^ b[i % b.length]);
  }
  return out.split('|');
}

// --- FNV-1a 32-bit + X-Sp guard ----------------------------------------

function imul32(a, b) {
  var ah = (a >>> 16) & 0xffff;
  var al = a & 0xffff;
  var bh = (b >>> 16) & 0xffff;
  var bl = b & 0xffff;
  return ((al * bl) + (((ah * bl + al * bh) << 16) >>> 0)) | 0;
}

function fnv1a32(str) {
  var h = 2166136261;
  for (var i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = imul32(h, 16777619) >>> 0;
  }
  var hex = h.toString(16);
  while (hex.length < 8) hex = '0' + hex;
  return hex;
}

/**
 * sp + spT ciftinden X-Sp baslik degerini uretir (sayfanin JS mantigiyla ayni).
 * ONEMLI: sunucu X-Sp degerini NONCE gibi kullanir — ayni deger ikinci kez
 * gonderilirse 404 doner. Bu yuzden HER istek icin yeni rand uretilir ve
 * zaman damgasi sayfa render anindan gecen sureyle ilerletilir (pageAt).
 */
function buildXSp(sp, spT, pageAt) {
  var seed = sp || '';
  var base = Number(spT) || 0;
  if (pageAt) {
    var elapsed = Math.floor((Date.now() - pageAt) / 1000);
    if (elapsed > 0) base += elapsed;
  }
  var rand = Math.floor(2176782336 * Math.random()).toString(36);
  return base + '.' + rand + '.' + fnv1a32(seed + '|' + base + '|' + rand);
}

// --- HTML icerik ayiklama ----------------------------------------------

/** Bridge sayfasindaki SPG.cerceve("id","payload","key") argumanlari (manuel tarama). */
function parseBridgeArgs(html) {
  var key = 'SPG.cerceve(';
  var start = html.indexOf(key);
  if (start < 0) return null;
  var i = start + key.length;

  function readString() {
    while (i < html.length && /\s/.test(html[i])) i++;
    if (html[i] === '\\') i++;
    if (html[i] !== '"') return null;
    i++;
    var out = '';
    while (i < html.length) {
      var c = html[i];
      if (c === '\\' && html[i + 1] === '"') { out += '"'; i += 2; continue; }
      if (c === '"') { i++; break; }
      out += c;
      i++;
    }
    return out;
  }

  var first = readString();
  if (first === null) return null;
  while (i < html.length && /[\s,]/.test(html[i])) i++;
  var payload = readString();
  if (payload === null) return null;
  while (i < html.length && /[\s,]/.test(html[i])) i++;
  var xorKey = readString();
  return { id: first, payload: payload, key: xorKey };
}

/** JS nesne literali (tirnaksiz anahtar, tek tirnak) -> JSON'a cevirip parse eder. */
function jsObjectToJson(text) {
  if (!text) return null;
  var out = String(text);
  out = out.replace(/'((?:[^'\\]|\\.)*)'/g, function (m, s) {
    return '"' + s.replace(/"/g, '\\"') + '"';
  });
  out = out.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":');
  try {
    return JSON.parse(out);
  } catch (e) {
    return null;
  }
}

/** Isaretlenen yerden dengeli suslu parantez blogunu ham metin olarak cikarir. */
function extractBalancedObject(text, marker) {
  var idx = text.indexOf(marker);
  if (idx < 0) return null;
  var start = text.indexOf('{', idx);
  if (start < 0) return null;
  var depth = 0, inStr = false, esc = false;
  for (var i = start; i < text.length; i++) {
    var c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// ==========================================================================================
// 1) HTTP katmani
// ==========================================================================================

/**
 * Genel GET/POST; yeniden deneme + geri cekilme.
 * opts: { method, body, contentType, referer, origin, accept, acceptLanguage,
 *         headers {ekstra: X-Sp vb.}, okStatuses }
 */
function httpReq(url, opts) {
  opts = opts || {};
  var headers = {
    'User-Agent': USER_AGENT,
    'Accept': opts.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  };
  // fastplay.mom WAF'i: m3u8 isteklerinde Accept-Language YOK olmali
  if (opts.acceptLanguage !== false) {
    headers['Accept-Language'] = 'tr-TR,tr;q=0.9,en;q=0.8';
  }
  if (opts.referer) headers['Referer'] = opts.referer;
  if (opts.origin) headers['Origin'] = opts.origin;
  if (opts.contentType) headers['Content-Type'] = opts.contentType;
  if (opts.headers) {
    for (var k in opts.headers) headers[k] = opts.headers[k];
  }

  var init = { method: opts.method || 'GET', headers: headers };
  if (opts.body) init.body = opts.body;

  var maxAttempts = 3;
  function tryOnce(attempt) {
    return fetch(url, init).then(function (response) {
      return response.text().then(function (text) {
        return { status: response.status, ok: response.ok, text: text };
      });
    });
  }
  function attempt(n) {
    return tryOnce(n).then(function (res) {
      if (res.status >= 500 && n + 1 < maxAttempts) {
        return sleep(600 * (n + 1)).then(function () { return attempt(n + 1); });
      }
      return res;
    }).catch(function (err) {
      if (n + 1 < maxAttempts) {
        return sleep(600 * (n + 1)).then(function () { return attempt(n + 1); });
      }
      throw err;
    });
  }
  return attempt(0);
}

/** Site sayfasi GET (basarili HTTP bekler). */
function siteGet(url, referer) {
  return httpReq(url, { referer: referer || BASE_URL + '/' }).then(function (res) {
    if (res.status >= 400) throw new Error('HTTP ' + res.status + ': ' + url);
    if (!res.text) throw new Error('Bos yanit: ' + url);
    return res.text;
  });
}

/** Harici host GET (TMDB / Cinemeta). */
function externalGet(url) {
  return httpReq(url, {
    accept: 'application/json, text/plain, */*',
  }).then(function (res) {
    if (res.status >= 400) throw new Error('HTTP ' + res.status + ': ' + url);
    return res.text;
  });
}

// ==========================================================================================
// 2) TMDB / Cinemeta eslestirme (SuperFilmIzle eklentisiyle ayni yaklasim)
// ==========================================================================================

function fetchTmdbMeta(id, mediaType) {
  var kind = mediaType === 'movie' ? 'movie' : 'tv';
  var url = TMDB_BASE_URL + '/' + kind + '/' + id + '?api_key=' + TMDB_API_KEY + '&language=tr-TR';
  return externalGet(url).then(function (body) {
    var data = JSON.parse(body);
    return {
      names: [data.original_name || data.original_title, data.name || data.title],
      year: yearOf(data.first_air_date || data.release_date),
      kind: kind,
    };
  });
}

function fetchCinemetaMeta(imdbId) {
  var url = CINEMETA_URL + 'series/' + imdbId + '.json';
  return externalGet(url).then(function (body) {
    var meta = (JSON.parse(body).meta) || {};
    return { names: [meta.name, meta.originalName], year: yearOf(meta.released), kind: 'tv' };
  }).catch(function () {
    return externalGet(CINEMETA_URL + 'movie/' + imdbId + '.json').then(function (body) {
      var meta = (JSON.parse(body).meta) || {};
      return { names: [meta.name, meta.originalName], year: yearOf(meta.released), kind: 'movie' };
    });
  });
}

function pickBestItem(items, names, year, wantKind) {
  var best = null;
  var bestScore = -1;
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var a = normalizeTitle(item.title);
    if (!a) continue;
    var nameScore = 0;
    for (var n = 0; n < names.length; n++) {
      var b = normalizeTitle(names[n]);
      if (!b) continue;
      if (a === b) nameScore = Math.max(nameScore, 100);
      else if (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) nameScore = Math.max(nameScore, 80);
      else if (diceSimilarity(a, b) >= 0.7) nameScore = Math.max(nameScore, 70);
    }
    if (nameScore === 0) continue;
    var score = nameScore;
    // tur eslesmesi tercih edilir ama tek basina eleme yapmaz
    var itemKind = urlKind(item.url);
    if (wantKind && itemKind && itemKind !== wantKind) score -= 15;
    if (wantKind && itemKind === wantKind) score += 5;
    var cardYear = parseInt(item.year, 10);
    if (!isNaN(cardYear) && year) {
      if (cardYear === year) score += 20;
      else if (Math.abs(cardYear - year) <= 1) score += 10;
    }
    if (score > bestScore) { bestScore = score; best = item; }
  }
  return bestScore >= 70 ? best : null;
}

function urlKind(url) {
  url = String(url || '');
  if (/\/film\//.test(url)) return 'movie';
  if (/\/dizi\//.test(url)) return 'series';
  if (/\/bolum\//.test(url)) return 'episode';
  return '';
}

// ==========================================================================================
// 3) Arama (canli AJAX -> HTML yedek; asciiFold katlama ile)
// ==========================================================================================

function parseCardBlock(block) {
  var imgTag = block.match(/<img[^>]+>/);
  var title = stripTags((block.match(/class="card-ad"[^>]*>([\s\S]*?)<\/h[23]>/) || [])[1] || '') ||
    (imgTag ? attr(imgTag[0], 'alt') : '');
  var img = imgTag ? attr(imgTag[0], 'src') : '';
  var imdbRaw = (block.match(/class="badge-imdb"[^>]*>([\s\S]*?)<\/span>/) || [])[1];
  var metaRaw = stripTags((block.match(/class="meta"[^>]*>([\s\S]*?)<\/p>/) || [])[1] || '');
  var parts = metaRaw.split('·');
  var year = '';
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].trim();
    if (/^[0-9]{4}/.test(p)) { year = p; break; }
  }
  return {
    id: null,
    title: title,
    url: '',
    image: img || null,
    year: year || null,
    imdbRating: imdbRaw ? stripTags(imdbRaw) : null,
    kind: '',
  };
}

/** HTML arama (/?s=) kartlarini ayristirir. */
function parseSearchCards(html) {
  var out = [];
  var seen = {};
  var re = /<a[^>]+class="[^"]*card-link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  var m;
  while ((m = re.exec(html)) !== null) {
    var url = decodeEntities(m[1]);
    if (url.indexOf('http') !== 0) url = resolveUrl(url, BASE_URL);
    if (url.indexOf(BASE_URL) !== 0) continue;
    if (seen[url]) continue;
    seen[url] = true;
    var card = parseCardBlock(m[2]);
    card.url = url;
    card.kind = urlKind(url);
    if (card.title) out.push(card);
  }
  return out;
}

/** Canli arama (admin-ajax stf_live_search). */
function searchAjax(q) {
  var url = AJAX_URL + '?action=stf_live_search&keyword=' + encodeURIComponent(q);
  return httpReq(url, {
    referer: BASE_URL + '/',
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
  }).then(function (res) {
    if (res.status >= 400) throw new Error('HTTP ' + res.status);
    var json = JSON.parse(res.text);
    var items = [];
    for (var key in json) {
      var it = json[key];
      if (!it || !it.url) continue;
      var u = String(it.url);
      if (u.indexOf('http') !== 0) u = resolveUrl(u, BASE_URL);
      var extra = it.extra || {};
      items.push({
        id: it.id || null,
        title: it.title || '',
        url: u,
        image: it.img || null,
        year: extra.date ? String(extra.date).slice(0, 4) : null,
        imdbRating: extra.imdb || null,
        lang: extra.dil || null,
        kind: urlKind(u),
      });
    }
    return items;
  });
}

function searchHtml(q) {
  return siteGet(BASE_URL + '/?s=' + encodeURIComponent(q)).then(function (html) {
    return parseSearchCards(html);
  });
}

/** Arama: AJAX -> HTML; bos ise asciiFold katlanmis ve slug denemeleri. */
function searchSite(query) {
  var q = String(query || '').trim();
  if (!q) return Promise.resolve([]);

  function tryAjax() {
    return searchAjax(q).catch(function () { return []; });
  }
  function tryHtml() {
    return searchHtml(q).catch(function () { return []; });
  }
  function tryFolded() {
    var folded = asciiFold(q);
    if (!folded || folded === q) return Promise.resolve([]);
    return searchAjax(folded).catch(function () { return []; }).then(function (items) {
      if (items.length) return items;
      return searchHtml(folded).catch(function () { return []; });
    });
  }

  return tryAjax().then(function (items) {
    if (items.length) return items;
    return tryHtml();
  }).then(function (items) {
    if (items.length) return items;
    return tryFolded();
  });
}

/** TMDB/IMDB kimligini SetFilmIzle kartina cevirir. */
function resolveSiteCard(id, mediaType) {
  var metaTask = (typeof id === 'string' && id.indexOf('tt') === 0)
    ? fetchCinemetaMeta(id)
    : fetchTmdbMeta(id, mediaType);

  return metaTask.then(function (meta) {
    var names = [];
    for (var i = 0; i < meta.names.length; i++) {
      if (meta.names[i]) names.push(meta.names[i]);
    }
    if (!names.length) throw new Error('Baslik adi bulunamadi (id: ' + id + ')');

    var wantKind = mediaType === 'movie' ? 'movie' : 'series';
    var tryIndex = 0;
    function tryNext() {
      if (tryIndex >= names.length) {
        return searchSite(names[0]).then(function (items) {
          var fallback = pickBestItem(items, names, meta.year, wantKind);
          if (!fallback) throw new Error('SetFilmIzle uzerinde bulunamadi: ' + names.join(' / '));
          return fallback;
        });
      }
      var query = names[tryIndex++];
      return searchSite(query).then(function (items) {
        var match = pickBestItem(items, names, meta.year, wantKind);
        if (match) return match;
        return tryNext();
      });
    }
    return tryNext();
  });
}

// ==========================================================================================
// 4) Dizi sayfasi: sezon panelleri + bolum listesi
// ==========================================================================================

/** Dizi sayfasindaki season-panel bloklarini ve fep bolumlerini toplar. */
function parseSeasons(html) {
  var seasons = [];
  var marks = [];
  var findRe = /<div[^>]+class="[^"]*season-panel[^"]*"[^>]*data-season="(\d+)"[^>]*>/g;
  var fm;
  while ((fm = findRe.exec(html)) !== null) {
    marks.push({ season: parseInt(fm[1], 10), bodyStart: fm.index + fm[0].length });
  }
  for (var i = 0; i < marks.length; i++) {
    var end = (i + 1 < marks.length) ? findNextPanelStart(html, marks[i].bodyStart) : html.length;
    if (end < 0) end = html.length;
    var block = html.slice(marks[i].bodyStart, end);
    var episodes = [];
    var epRe = /<a[^>]+class="fep[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    var em;
    while ((em = epRe.exec(block)) !== null) {
      var url = decodeEntities(em[1]);
      if (url.indexOf('http') !== 0) url = resolveUrl(url, BASE_URL);
      var b = em[2];
      var sub = stripTags((b.match(/class="fep-sub"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '');
      var epTitle = stripTags((b.match(/class="fep-title"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '');
      var num = null;
      var t1 = epTitle.match(/([0-9]+)/);
      var t2 = sub.match(/Episode\s*([0-9]+)/i);
      var t3 = url.match(/-([0-9]+)-sezon-([0-9]+)-bolum/);
      if (t3) num = parseInt(t3[2], 10);
      else if (t2) num = parseInt(t2[1], 10);
      else if (t1) num = parseInt(t1[1], 10);
      var se = null;
      if (t3) se = parseInt(t3[1], 10);
      episodes.push({
        url: url,
        season: se || marks[i].season,
        number: num,
        title: epTitle,
      });
    }
    seasons.push({ season: marks[i].season, episodes: episodes });
  }
  return seasons;
}

/** Siradaki season-panel baslangicini bulur (ic ice div'leri sayarak). */
function findNextPanelStart(html, from) {
  var re = /<div[^>]+class="[^"]*season-panel[^"]*"/g;
  re.lastIndex = from;
  var m = re.exec(html);
  return m ? m.index : html.length;
}

/** Bolum URL'inden sezon/bolum numaralarini cikarir. */
function parseEpisodeUrl(url) {
  var m = url.match(/-([0-9]+)-sezon-([0-9]+)-bolum/);
  if (m) return [parseInt(m[1], 10), parseInt(m[2], 10)];
  return null;
}

/** Tum sezon panellerini toplar; diger sezonlar icin AJAX paneli dener. */
function fetchEpisodes(seriesUrl, diziId) {
  return siteGet(seriesUrl).then(function (html) {
    var seasons = parseSeasons(html);
    var want = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    var have = {};
    for (var i = 0; i < seasons.length; i++) have[seasons[i].season] = true;
    var missing = [];
    for (var w = 0; w < want.length; w++) {
      if (!have[want[w]]) missing.push(want[w]);
    }
    if (!missing.length || !diziId) return seasons;

    // Eksik sezonlar icin AJAX sezon paneli (sessizce dener)
    var idx = 0;
    function fetchRest() {
      if (idx >= missing.length) return Promise.resolve(null);
      var sn = missing[idx++];
      var url = AJAX_URL + '?action=stf_sezon&dizi=' + encodeURIComponent(diziId) +
        '&sezon=' + sn + '&bolum=';
      return httpReq(url, {
        referer: seriesUrl,
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      }).then(function (res) {
        if (res.status < 400 && res.text && /class="fep/.test(res.text)) {
          var panelHtml = '<div class="season-panel" data-season="' + sn + '">' + res.text;
          var extra = parseSeasons(panelHtml);
          for (var e = 0; e < extra.length; e++) seasons.push(extra[e]);
        }
        return fetchRest();
      }).catch(function () { return fetchRest(); });
    }
    return fetchRest().then(function () { return seasons; });
  });
}

// ==========================================================================================
// 5) Video zinciri: nonce -> get_video_url -> bridge -> fastplay -> X-Sp manifest
// ==========================================================================================

function extractPostId(html) {
  var m = html.match(/id="stfPlayer"[^>]*data-post-id="([0-9]+)"/);
  if (m) return m[1];
  m = html.match(/data-post-id="([0-9]+)"/);
  return m ? m[1] : null;
}

function extractNonce(html) {
  var m = html.match(/nonces:\s*\{[\s\S]*?video:\s*"([a-f0-9]+)"/);
  if (m) return m[1];
  m = html.match(/video:\s*"([a-f0-9]+)"/);
  return m ? m[1] : null;
}

/** admin-ajax get_video_url -> stream JSON'u (basarisizsa bir kez taze=1 ile dener). */
function fetchVideoJson(postId, nonce, pageUrl) {
  function once(useFresh) {
    var form = 'action=get_video_url' +
      '&nonce=' + encodeURIComponent(nonce) +
      '&post_id=' + encodeURIComponent(postId) +
      '&player_name=' + encodeURIComponent('SetPlay') +
      '&part_key=' +
      (useFresh ? '&taze=1' : '');
    return httpReq(AJAX_URL, {
      method: 'POST',
      body: form,
      contentType: 'application/x-www-form-urlencoded',
      referer: pageUrl || BASE_URL + '/',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    }).then(function (res) {
      if (res.status >= 400) throw new Error('get_video_url HTTP ' + res.status);
      var json;
      try {
        json = JSON.parse(res.text);
      } catch (e) {
        throw new Error('get_video_url JSON degil: ' + res.text.slice(0, 120));
      }
      if (!json.success || !json.data) {
        throw new Error('get_video_url basarisiz: ' + JSON.stringify(json).slice(0, 200));
      }
      return json.data;
    });
  }
  return once(false).catch(function (err) {
    // scraper v3: sunucu cache'lenmis/otuken sonucu reddedebilir; taze=1 ile bir kez daha dene
    return once(true).catch(function () { throw err; });
  });
}

/** Bridge HTML -> fastplay oynatici URL (SPG.cerceve -> base64+XOR). */
function resolveBridge(bridgeUrl) {
  return httpReq(bridgeUrl, { referer: BASE_URL + '/' }).then(function (res) {
    if (res.status >= 400) throw new Error('bridge HTTP ' + res.status);
    var args = parseBridgeArgs(res.text);
    if (!args) throw new Error('Bridge SPG.cerceve bulunamadi');
    var parts = xorDecode(args.payload, args.key || '');
    for (var i = 0; i < parts.length; i++) {
      if (/^https?:\/\//i.test(parts[i])) return parts[i];
    }
    throw new Error('Bridge cozumu bos');
  });
}

/** window.SPG_A = {sp, spT} degerlerini ayiklar. */
function extractSpgA(html) {
  var m = html.match(/window\.SPG_A=\s*(\{[\s\S]*?\});/);
  if (!m) return null;
  return jsObjectToJson(m[1]);
}

/** STF_KOPRU src + subtitles ayiklar. */
function extractKopru(html) {
  var raw = extractBalancedObject(html, 'window.STF_KOPRU');
  if (!raw) return null;
  return jsObjectToJson(raw);
}

/**
 * HLS master manifest'ini X-Sp guard ile ceker ve ayristirir.
 * Donus: Promise<text>
 * fastplay.mom manifesti yeniden uretirken 404/403/429/520-524 dondurebiliyor;
 * her denemede YENI bir X-Sp uretilir (replay korumasi: ayni deger 404 verir).
 */
function fetchManifest(manifestUrl, fastplayUrl, spgA, pageAt) {
  var RETRY_STATUSES = [404, 403, 429, 520, 521, 522, 523, 524];
  var delays = [1000, 2000, 3000, 5000, 8000];
  var attempt = 0;

  function once() {
    var headers = {};
    if (spgA && spgA.sp !== undefined) {
      headers['X-Sp'] = buildXSp(spgA.sp, spgA.spT, pageAt);
    }
    return httpReq(manifestUrl, {
      referer: fastplayUrl,
      origin: originOf(fastplayUrl),
      accept: '*/*',
      acceptLanguage: false,
      headers: headers,
    }).then(function (res) {
      if (res.status !== 200) {
        var err = new Error('manifest HTTP ' + res.status);
        err.status = res.status;
        throw err;
      }
      return res.text;
    });
  }

  function attemptLoop() {
    return once().catch(function (err) {
      var st = err && err.status;
      var retryable = RETRY_STATUSES.indexOf(st) !== -1;
      if (!retryable || attempt >= delays.length) throw err;
      return sleep(delays[attempt++]).then(attemptLoop);
    });
  }
  return attemptLoop();
}

/** Master playlist metninden en yuksek cozunurlugu cikarir. */
function masterQualityLabel(text) {
  var re = /RESOLUTION=([0-9]+)x([0-9]+)/g;
  var best = 0, m;
  while ((m = re.exec(text)) !== null) {
    var h = parseInt(m[2], 10);
    if (!isNaN(h) && h > best) best = h;
  }
  return best ? best + 'p' : 'auto';
}

/** Master playlist'teki SUBTITLES izlerini Nuvio bicimine cevirir. */
function manifestSubtitleTracks(text, manifestUrl) {
  var out = [];
  var re = /#EXT-X-MEDIA:([^\n]*)/g;
  var m;
  while ((m = re.exec(text)) !== null) {
    var line = m[1];
    var typeM = line.match(/TYPE=([^,]+)/);
    if (!typeM || typeM[1].indexOf('SUBTITLES') === -1) continue;
    var uriM = line.match(/URI="([^"]+)"/);
    var langM = line.match(/LANGUAGE="([^"]+)"/);
    var nameM = line.match(/NAME="([^"]+)"/);
    if (!uriM) continue;
    out.push({
      url: resolveUrl(uriM[1], manifestUrl),
      lang: langM ? langM[1] : 'tr',
      label: nameM ? nameM[1] : (langM ? langM[1] : 'Turkce'),
    });
  }
  return out;
}

/** Harici altyazi listesini (file/label/lang) Nuvio bicimine cevirir. */
function formatExternalSubtitles(subs, baseUrl) {
  var out = [];
  if (!subs || typeof subs.length === 'undefined') return out;
  for (var i = 0; i < subs.length; i++) {
    var s = subs[i];
    if (!s || !s.file) continue;
    // bazi kaynaklarda lang yerine kind alan kullanilir (scraper v2: lang || kind)
    var lang = s.lang || s.kind || 'tr';
    out.push({
      url: resolveUrl(s.file, baseUrl),
      lang: lang,
      label: s.label || lang || 'Turkce',
    });
  }
  return out;
}

/**
 * Fastplay sayfasini + manifesti guard ile cozer.
 * Hata durumunda fastplay sayfasi tazelenir (X-Sp zaman damgasi render'a bagli)
 * ve STF_KOPRU + SPG_A her denemede yeniden okunur (scraper v3: 7 deneme).
 */
function resolveFastplay(fastplayUrl, maxAttempts) {
  var delays = [800, 1500, 2500, 4000, 6000, 8000];
  var attempts = maxAttempts || (delays.length + 1);
  var attempt = 0;

  function tryOnce() {
    var pageAt = Date.now();
    return siteGet(fastplayUrl, BASE_URL + '/').then(function (html) {
      var kopru = extractKopru(html);
      if (!kopru || !kopru.src) throw new Error('STF_KOPRU bulunamadi');
      var manifestUrl = /^http/i.test(kopru.src) ? kopru.src : originOf(fastplayUrl) + kopru.src;
      var spgA = extractSpgA(html) || null;
      return fetchManifest(manifestUrl, fastplayUrl, spgA, pageAt).then(function (text) {
        return {
          manifestUrl: manifestUrl,
          quality: masterQualityLabel(text),
          subtitles: manifestSubtitleTracks(text, manifestUrl),
          spgA: spgA,
          pageAt: pageAt,
        };
      });
    });
  }

  function attemptLoop() {
    return tryOnce().catch(function (err) {
      attempt++;
      if (attempt >= attempts) throw err;
      return sleep(delays[Math.min(attempt - 1, delays.length - 1)]).then(attemptLoop);
    });
  }
  return attemptLoop();
}

/**
 * Icerik sayfasini (film veya bolum) tam video zinciriyle cozer.
 * Donus: Promise<[{manifestUrl, quality, subtitles, embedUrl}]> (0 veya 1 ogeli)
 */
function resolvePageSources(pageUrl) {
  return siteGet(pageUrl).then(function (html) {
    var postId = extractPostId(html);
    if (!postId) throw new Error('post-id bulunamadi: ' + pageUrl);
    var nonce = extractNonce(html);
    // scraper v3: nonce sayfaya ozeldir; icerik sayfasinda yoksa anasayfa yedek
    if (nonce) return { postId: postId, nonce: nonce };
    return siteGet(BASE_URL + '/').then(function (homeHtml) {
      var homeNonce = extractNonce(homeHtml);
      if (!homeNonce) throw new Error('video nonce bulunamadi: ' + pageUrl);
      return { postId: postId, nonce: homeNonce };
    });
  }).then(function (found) {
    return fetchVideoJson(found.postId, found.nonce, pageUrl).then(function (data) {
      var stream = data.stream || {};
      var results = [];
      var externalSubs = formatExternalSubtitles(stream.subtitles, pageUrl);

      // Dogrudan kaynak (src)
      if (stream.type === 'src' && stream.src) {
        var srcUrl = resolveUrl(stream.src, BASE_URL);
        results.push({
          manifestUrl: srcUrl,
          quality: 'auto',
          subtitles: externalSubs,
          embedUrl: null,
          headers: {
            'User-Agent': USER_AGENT,
            'Referer': BASE_URL + '/',
            'Origin': BASE_URL,
          },
        });
        return results;
      }

      // Bridge zinciri (setplay -> fastplay -> master.txt)
      if (stream.type === 'bridge' && stream.url) {
        return resolveBridge(stream.url).then(function (fastplayUrl) {
          return resolveFastplay(fastplayUrl, 7).then(function (resolved) {
            // Oncelik: manifest icindeki SUBTITLES izleri (ayni verify token'ini
            // paylasirlar, harici dosyalardan daha guvenilir). Harici altyazilar yedek.
            var subs = resolved.subtitles.length ? resolved.subtitles : externalSubs;
            // Harici + manifest izlerini birlestir (URL'e gore tekillestir)
            var seen = {};
            var merged = [];
            for (var i = 0; i < subs.length; i++) {
              if (!seen[subs[i].url]) { seen[subs[i].url] = true; merged.push(subs[i]); }
            }
            results.push({
              manifestUrl: resolved.manifestUrl,
              quality: resolved.quality,
              subtitles: merged,
              embedUrl: fastplayUrl,
              headers: {
                'User-Agent': USER_AGENT,
                'Referer': fastplayUrl,
                'Origin': originOf(fastplayUrl),
                'Accept': '*/*',
                'X-Sp': resolved.spgA ? buildXSp(resolved.spgA.sp, resolved.spgA.spT, resolved.pageAt) : undefined,
              },
            });
            return results;
          });
        });
      }

      // YouTube veya genel embed
      if (data.yt && data.yt.id) {
        results.push({
          manifestUrl: null,
          quality: 'youtube',
          subtitles: [],
          embedUrl: 'https://www.youtube.com/watch?v=' + data.yt.id,
          headers: {},
        });
        return results;
      }
      if (data.url) {
        results.push({
          manifestUrl: null,
          quality: 'embed',
          subtitles: [],
          embedUrl: data.url,
          headers: {},
        });
        return results;
      }
      return results;
    });
  }).catch(function (err) {
    // Sayfada dogrudan m3u8 varsa yedek olarak kullan
    return siteGet(pageUrl).then(function (html2) {
      var m = html2.match(/(https?:\/\/[^"'\s]+?\.m3u8[^"'\s]*)/);
      if (m) {
        return [{
          manifestUrl: m[1],
          quality: 'auto',
          subtitles: [],
          embedUrl: null,
          headers: {
            'User-Agent': USER_AGENT,
            'Referer': BASE_URL + '/',
          },
        }];
      }
      throw err;
    });
  });
}

// ==========================================================================================
// 6) Nuvio cikti formati + getStreams ana girisi
// ==========================================================================================

function qualityRank(label) {
  var m = String(label || '').match(/([0-9]+)p/);
  if (m) return parseInt(m[1], 10);
  return 0;
}

function formatSourceLinks(resolved, mediaTitle) {
  var headers = {};
  for (var k in resolved.headers) {
    if (typeof resolved.headers[k] !== 'undefined') headers[k] = resolved.headers[k];
  }
  if (resolved.manifestUrl) {
    return [{
      name: '⌜ SetFilmIzle ⌟ | SetPlay | ' + (resolved.quality || 'auto'),
      title: mediaTitle || '',
      url: resolved.manifestUrl,
      quality: resolved.quality || 'auto',
      size: 'Unknown',
      headers: headers,
      subtitles: resolved.subtitles || [],
    }];
  }
  // Cozulemeyen kaynak kaybolmasin: embed olarak sunulur
  return [{
    name: '⌜ SetFilmIzle ⌟ | SetPlay | embed',
    title: mediaTitle || '',
    url: resolved.embedUrl || '',
    quality: 'embed',
    size: 'Unknown',
    headers: headers,
    subtitles: [],
  }];
}

function buildStreamsForPage(pageUrl, mediaTitle) {
  return resolvePageSources(pageUrl).then(function (results) {
    var links = [];
    for (var i = 0; i < results.length; i++) {
      links = links.concat(formatSourceLinks(results[i], mediaTitle));
    }
    links.sort(function (a, b) { return qualityRank(b.quality) - qualityRank(a.quality); });
    return links;
  }).catch(function (err) {
    // scraper v2 yedegi: ayni slug'i diger tiplerde dene (film -> dizi -> bolum).
    // Arama sonucu yanlis etiketli olabilir (film sayfasi aslinda dizi/bolum).
    var msg = err && err.message ? err.message : '';
    if (msg.indexOf('post-id bulunamadi') === -1) throw err;
    var slugMatch = new RegExp('/(?:film|dizi|bolum)/([^/]+)/$').exec(pageUrl);
    if (!slugMatch) throw err;
    var slug = slugMatch[1];
    var candidates = [BASE_URL + '/film/' + slug + '/', BASE_URL + '/dizi/' + slug + '/', BASE_URL + '/bolum/' + slug + '/'];
    var chain = Promise.reject(err);
    for (var c = 0; c < candidates.length; c++) {
      (function (cand) {
        if (cand === pageUrl) return; // ayni sayfayi tekrar deneme
        chain = chain.catch(function () {
          return resolvePageSources(cand).then(function (results) {
            var links2 = [];
            for (var i = 0; i < results.length; i++) {
              links2 = links2.concat(formatSourceLinks(results[i], mediaTitle));
            }
            links2.sort(function (a, b) { return qualityRank(b.quality) - qualityRank(a.quality); });
            return links2;
          });
        });
      })(candidates[c]);
    }
    return chain;
  });
}

/**
 * NUVIO ANA GIRIS.
 * id: TMDB id (sayi/string) veya IMDB id ("tt...") | mediaType: "movie" | "tv"
 * SetFilmIzle Turkce film/dizi katalogu; esleme TMDB/Cinemeta uzerinden yapilir.
 */
function getStreams(id, mediaType, season, episode) {
  if (mediaType !== 'tv' && mediaType !== 'movie') return Promise.resolve([]);

  var rid = String(Math.floor(Math.random() * 900000) + 100000);
  function log(msg, extra) {
    try {
      if (typeof extra !== 'undefined') console.log('[SetFilmIzle][rid:' + rid + '] ' + msg, extra);
      else console.log('[SetFilmIzle][rid:' + rid + '] ' + msg);
    } catch (e) { }
  }
  log('getStreams start', { id: id, S: season, E: episode });

  var wantSeason = parseInt(season, 10) || 1;
  var wantEpisode = parseInt(episode, 10) || 1;
  var mediaTitleBase = '';

  return resolveSiteCard(id, mediaType).then(function (card) {
    if (!card) throw new Error('Eslesme bulunamadi');
    mediaTitleBase = card.title || 'Icerik';
    log('eslesme', { url: card.url, title: card.title, yil: card.year });

    if (mediaType === 'movie') {
      return buildStreamsForPage(card.url, mediaTitleBase);
    }

    // Dizi: hedef sezon+bolumu bul
    return fetchEpisodes(card.url, card.id).then(function (seasons) {
      var eps = [];
      for (var i = 0; i < seasons.length; i++) {
        for (var j = 0; j < seasons[i].episodes.length; j++) eps.push(seasons[i].episodes[j]);
      }
      if (!eps.length) {
        log('bolum bulunamadi, dizi sayfasi denenecek');
        return buildStreamsForPage(card.url, mediaTitleBase);
      }
      var target = null;
      for (var k = 0; k < eps.length; k++) {
        if (eps[k].season === wantSeason && eps[k].number === wantEpisode) { target = eps[k]; break; }
      }
      if (!target) {
        for (var l = 0; l < eps.length; l++) {
          if (eps[l].season === 1 && eps[l].number === wantEpisode) { target = eps[l]; break; }
        }
      }
      if (!target) {
        for (var m2 = 0; m2 < eps.length; m2++) {
          if (eps[m2].number === wantEpisode) { target = eps[m2]; break; }
        }
      }
      if (!target) {
        log('S' + wantSeason + 'E' + wantEpisode + ' bulunamadi, ilk bolum denenecek');
        target = eps[0];
      }
      log('bolum secildi S' + target.season + 'E' + target.number);
      var title = mediaTitleBase + ' S' + target.season + 'E' + target.number;
      return buildStreamsForPage(target.url, title);
    });
  })
    .catch(function (err) {
      log('HATA: ' + (err && err.message ? err.message : err));
      return [];
    });
}

// Export for Nuvio
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams: getStreams };
} else {
  global.SetFilmIzleScraperModule = { getStreams: getStreams };
}
