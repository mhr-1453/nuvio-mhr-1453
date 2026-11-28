// ==========================================================================================
// CizgiMax Scraper for Nuvio Local Scrapers
// ------------------------------------------------------------------------------------------
// Kaynak: cizgimax-scraper.js (tek dosya Node CLI scraper) Nuvio sozlesmesine cevirilmistir.
//
// Site : https://cizgimax.online  (Turkce cizgi film / anime / dizi katalogu;
//        sunucu taraflı PHP + ArtPlayer 5 oynatıcı)
//
// AKIS HARITASI
//   GET /api/search/suggest/?q=<q> ......... canli arama onerileri (JSON)
//   GET /ara/?q=<q> ........................ HTML arama sayfasi (yedek; .film-item kartlari)
//   GET /diziler/<slug>-izle/ .............. dizi detayi (JSON-LD + sezon/bolum listesi)
//   GET /<slug>-<n>-sezon-<m>-bolum-izle/ .. bolum detayi (JSON-LD + servers base64(JSON))
//   var servers = JSON.parse(atob("...")) .. oynatici kaynak listesi (bolum sayfasina gomulu)
//   GET /oynat/?t=<token> .................. 302 -> provider embed (dzen / sibnet / ...)
//   GET /api/stream/sibnet/?t=<token> ...... sibnet video URL (site API)
//   GET https://sibnet.ru/embed/<id>/ ...... sibnet embed (yedek cozum)
//   GET /api/np-resolve/?t=<token> ......... np (native) -> {id}
//   GET tau-video.xyz/api/video?id=<id> .... np upstream -> {urls[], captions[]}
//   POST /api/sign-np/ (X-CSRF-Token) ...... upstream URL'leri /api/stream/dzen/?s= imzali URL
//   GET dzen.ru/embed/<id> ................. "url":"https://vd..." HLS/DASH kaynaklari
//   GET <hdfc metaUrl> ..................... {hls, subtitles}
//
// CLOUDFLARE / ORIGIN STRATEJISI
//   cizgimax.online datacenter IP'lerden "Bir dakika lutfen..." (Turnstile) challenge
//   dondurebilir. Ayni uygulamanin origin sunucusu streamh.cizgimax.online CF arkasinda
//   degildir. HTTP katmani canonical -> origin otomatik gecer ve origin'de
//   "X-Forwarded-Host: cizgimax.online" + "Referer: https://cizgimax.online/" basliklari
//   gondererek sitenin "sadece cizgimax.online uzerinde oynatilabilir" kontrolunu gecer.
//
// Nuvio sozlesmesi: module.exports = { getStreams }
//   getStreams(id, mediaType, season, episode) -> Promise<[{name,title,url,quality,size,headers,subtitles}]>
//   id: TMDB id (sayi) veya IMDB id ("tt1234567") | mediaType: "movie" | "tv"
//
// HAYATA GERCEK ORTAMDA (Hermes): async/await YOK — tamami Promise zinciri, ES5 tarzidir.
// ==========================================================================================
'use strict';

var BASE_URL = 'https://cizgimax.online';
var ORIGIN_URL = 'https://streamh.cizgimax.online';
var SITE_REFERER = 'https://cizgimax.online/';
var NP_API_URL = 'https://tau-video.xyz/api/video?id=';
var DZEN_REFERER = 'https://dzen.ru/';
var SIBNET_REFERER = 'https://video.sibnet.ru/';

var USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
var ACCEPT_LANGUAGE = 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7';

var TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
var TMDB_BASE_URL = 'https://api.themoviedb.org/3';
var CINEMETA_URL = 'https://v3-cinemeta.strem.io/meta/';

var DZEN_QUALITY = {
  fullhd: '1080p',
  high: '720p',
  medium: '480p',
  low: '360p',
  lowest: '240p',
  tiny: '144p',
};

// null | 'canonical' | 'origin' — CF challenge gorulurse origin'e gecer.
var activeHost = null;

function siteBase() {
  return activeHost === 'origin' ? ORIGIN_URL : BASE_URL;
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// ==========================================================================================
// 1) ES5 yardimcilari (Hermes uyumlu)
// ==========================================================================================

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#([0-9]+);/g, function (_, d) { return String.fromCharCode(parseInt(d, 10)); })
    .replace(/&#x([0-9a-fA-F]+);/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); });
}

function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function attr(tag, name) {
  var m = new RegExp(name.replace(/[.*+?^${}()|[<LB>]<RB>]\]/g, '\\$&') + '\\s*=\\s*["\']([^"\']*)["\']', 'i').exec(tag);
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
  var base = String(baseUrl || siteBase());
  if (url.indexOf('/') === 0) {
    var om = base.match(/^https?:\/\/[^\/]+/);
    return (om ? om[0] : base) + url;
  }
  return base.slice(0, base.lastIndexOf('/') + 1) + url;
}

function hostOf(u) {
  var m = String(u || '').match(/^https?:\/\/([^\/?#]+)/i);
  return m ? m[1] : null;
}

/** Guvenli response header okuma (fetch polyfill farklari icin). */
function getHeader(res, name) {
  try {
    if (res && res.headers && typeof res.headers.get === 'function') {
      return res.headers.get(name);
    }
  } catch (e) { /* yoksay */ }
  return null;
}

// --- Base64 (Buffer/atob yok: saf JS) -----------------------------------

function b64ToBytes(s) {
  var input = String(s || '').replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+\/=]/g, '');
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

function b64DecodeUtf8(s) {
  return bytesToString(b64ToBytes(s));
}

// --- JSON yardimcilari ---------------------------------------------------

/** HTML icindeki application/ld+json bloklarini ayristirir. */
function ldJson(html) {
  var out = [];
  var re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    try { out.push(JSON.parse(m[1].trim())); } catch (e) { /* bozuk JSON-LD */ }
  }
  return out;
}

function jsonLoose(body) {
  try { return JSON.parse(body); } catch (e) { return null; }
}

// ==========================================================================================
// 2) HTTP KATMANI (canonical -> origin otomatik gecis)
// ==========================================================================================

function isCloudflareChallenge(status, body) {
  if (!body) return false;
  if (status !== 403 && status !== 503) return false;
  return /challenges\.cloudflare\.com|Bir dakika l|Just a moment|cf-chl/i.test(body);
}

/**
 * Cekirdek istek. 5xx ve ag hatalarinda artan beklemeyle 3 deneme yapar.
 * opts: {method, headers, body, accept, referer, contentType, xrw, noLang, retries}
 */
function httpReq(url, opts) {
  opts = opts || {};
  var headers = {
    'User-Agent': USER_AGENT,
    'Accept': opts.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  };
  if (!opts.noLang) headers['Accept-Language'] = ACCEPT_LANGUAGE;
  if (typeof opts.referer === 'string') {
    if (opts.referer !== '') headers['Referer'] = opts.referer;
  } else {
    headers['Referer'] = SITE_REFERER;
  }
  if (opts.xrw) headers['X-Requested-With'] = 'XMLHttpRequest';
  if (opts.contentType) headers['Content-Type'] = opts.contentType;
  if (opts.headers) {
    for (var hk in opts.headers) {
      if (typeof opts.headers[hk] !== 'undefined') headers[hk] = opts.headers[hk];
    }
  }

  var init = { method: opts.method || 'GET', headers: headers };
  if (opts.body) init.body = opts.body;

  var maxAttempts = opts.retries || 3;
  function tryOnce() {
    return fetch(url, init).then(function (response) {
      return response.text().then(function (text) {
        return {
          status: response.status,
          ok: response.ok,
          location: getHeader(response, 'location'),
          text: text,
        };
      });
    });
  }
  function attempt(n) {
    return tryOnce().then(function (res) {
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

/**
 * Site sayfasi GET. CF challenge donerse (canonical) origin sunucusuna gecer ve
 * "X-Forwarded-Host: cizgimax.online" basligiyle tekrar dener. Donus: {status, text}.
 * opts: {accept, method, body, contentType, headers, referer}
 */
function siteGet(path, opts) {
  opts = opts || {};
  function attempt(base) {
    var url = /^https?:\/\//i.test(path) ? path : base + path;
    var headers = {};
    if (base === ORIGIN_URL) headers['X-Forwarded-Host'] = 'cizgimax.online';
    if (opts.headers) {
      for (var k in opts.headers) headers[k] = opts.headers[k];
    }
    return httpReq(url, {
      method: opts.method || 'GET',
      body: opts.body,
      contentType: opts.contentType,
      accept: opts.accept,
      headers: headers,
      xrw: opts.xrw !== false,
    }).then(function (res) {
      if (isCloudflareChallenge(res.status, res.text) && base !== ORIGIN_URL) {
        activeHost = 'origin';
        return attempt(ORIGIN_URL).then(function (res2) {
          if (res2.status < 400 && !isCloudflareChallenge(res2.status, res2.text)) return res2;
          activeHost = null;
          return res2;
        });
      }
      return res;
    });
  }
  return attempt(siteBase());
}

/** Basarili HTTP bekleyen site GET; donus: sayfa metni. */
function siteGetText(path, what, opts) {
  return siteGet(path, opts).then(function (res) {
    if (isCloudflareChallenge(res.status, res.text)) {
      throw new Error('Cloudflare dogrulama sayfasi alindi (' + (what || path) + ')');
    }
    if (res.status >= 400) throw new Error('HTTP ' + res.status + ': ' + (what || path));
    if (!res.text) throw new Error('Bos yanit: ' + (what || path));
    return res.text;
  });
}

/** Harici host GET (TMDB / Cinemeta / sibnet / dzen). Donus: sayfa metni. */
function externalGet(url, opts) {
  return httpReq(url, {
    accept: (opts && opts.accept) || 'application/json, text/plain, */*',
    referer: (opts && typeof opts.referer === 'string') ? opts.referer : undefined,
    noLang: opts && opts.noLang,
    retries: (opts && opts.retries) || 2,
  }).then(function (res) {
    if (res.status >= 400) throw new Error('HTTP ' + res.status + ': ' + url);
    return res.text;
  });
}

// ==========================================================================================
// 3) HTML YARDIMCILARI
// ==========================================================================================

/** "Etiket: Deger" ciftlerini sozluge cevirir (kunye). */
function labelValues(listHtml) {
  var out = {};
  var re = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  var m;
  while ((m = re.exec(listHtml)) !== null) {
    var li = m[1];
    var sm = /<span[^>]*>([\s\S]*?)<\/span>/i.exec(li);
    if (!sm) continue;
    var label = stripTags(sm[1]).replace(/:$/, '');
    var valueHtml = li.slice(sm.index + sm[0].length);
    var value = stripTags(valueHtml);
    if (label && value) out[label] = value;
  }
  return out;
}

/** Belirli bir class'in tum bloklarini (ic ice div dahil) ham metin olarak dondurur. */
function blocksByClass(html, cls) {
  var res = [];
  var re = new RegExp('<(\\w+)[^>]*class="[^"]*\\b' + cls + '\\b[^"]*"[^>]*>', 'gi');
  var m;
  while ((m = re.exec(html)) !== null) {
    var tag = m[1];
    var start = m.index + m[0].length;
    var closeRe = new RegExp('</' + tag + '>', 'gi');
    var depth = 1, mm;
    var end = html.length;
    closeRe.lastIndex = start;
    while ((mm = closeRe.exec(html)) !== null) {
      depth--;
      if (depth === 0) { end = mm.index; break; }
    }
    res.push(html.slice(start, end));
    re.lastIndex = end;
  }
  return res;
}

function firstByClass(html, cls) {
  var b = blocksByClass(html, cls);
  return b.length ? b[0] : null;
}

/** class'i belirtilen <a> etiketleri (attribute sirasi farketmez). */
function anchorsWithClass(html, cls) {
  var out = [];
  var re = /<a\b[^>]*>/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    var tag = m[0];
    if (!new RegExp('class="[^"]*\\b' + cls + '\\b[^"]*"', 'i').test(tag)) continue;
    var href = attr(tag, 'href');
    var close = html.indexOf('</a>', m.index);
    out.push({
      tag: tag,
      href: href,
      inner: html.slice(m.index + tag.length, close < 0 ? html.length : close),
    });
    re.lastIndex = close < 0 ? html.length : close + 4;
  }
  return out;
}

function absUrl(u, base) {
  if (!u) return null;
  u = String(u);
  if (/^https?:\/\//i.test(u)) return u;
  if (u.indexOf('//') === 0) return 'https:' + u;
  return resolveUrl(u, base || siteBase());
}

// ==========================================================================================
// 4) PARSERLER
// ==========================================================================================

/** .film-item kartlarini (ana sayfa, arsiv, kategori, arama) ayristirir. */
function parseCards(html) {
  var items = [];
  var re = /<div[^>]*class="[^"]*\bfilm-item\b[^"]*"[^>]*>/gi;
  var idx = [];
  var m;
  while ((m = re.exec(html)) !== null) idx.push({ start: m.index, head: m[0] });
  for (var i = 0; i < idx.length; i++) {
    var chunk = html.slice(idx[i].start, idx[i + 1] ? idx[i + 1].start : html.length);
    var posterA = anchorsWithClass(chunk, 'poster')[0];
    var img = /<img[^>]*\bsrc="([^"]+)"[^>]*>/i.exec(chunk);
    var imgAlt = img ? attr(img[0], 'alt') : '';
    var corner = /<span[^>]*class="[^"]*\bcorner-tag\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(chunk);
    var nameA = anchorsWithClass(chunk, 'film-name')[0];
    var desc = /<p[^>]*class="[^"]*\bphc-desc\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(chunk);
    var metaUl = /<ul[^>]*class="[^"]*\bphc-meta\b[^"]*"[^>]*>([\s\S]*?)<\/ul>/i.exec(chunk);
    var meta = labelValues(metaUl ? metaUl[1] : '');
    var head = idx[i].head;

    var title = nameA ? stripTags(nameA.inner) : (imgAlt || stripTags(desc ? desc[1] : ''));
    if (!title) continue;

    items.push({
      id: attr(head, 'data-anime-id') || null,
      title: title,
      url: posterA ? absUrl(posterA.href) : null,
      seriesUrl: nameA ? absUrl(nameA.href) : null,
      poster: img ? absUrl(img[1]) : null,
      category: corner ? stripTags(corner[1]) : null,
      description: desc ? stripTags(desc[1]) : null,
      score: meta['Puan'] || null,
      year: meta['Yayın Yılı'] || null,
    });
  }
  return items;
}

/** Arama onerileri API'si (daha zengin metadata). */
function parseSuggest(json) {
  if (!json || !json.animes || typeof json.animes.length === 'undefined') return [];
  var out = [];
  for (var i = 0; i < json.animes.length; i++) {
    var a = json.animes[i];
    out.push({
      id: a.id || null,
      title: a.name || '',
      url: a.url ? absUrl(a.url) : null,
      poster: a.poster ? absUrl(a.poster) : null,
      year: a.year || null,
      status: a.status_label || null,
    });
  }
  return out;
}

/** Dizi detay sayfasi: JSON-LD + kunye + sezon/bolum listesi. */
function parseSeries(html, url) {
  var ld = null;
  var lds = ldJson(html);
  for (var q = 0; q < lds.length; q++) {
    if (lds[q] && lds[q]['@type'] && /TVSeries|Movie/i.test(String(lds[q]['@type']))) { ld = lds[q]; break; }
  }
  if (!ld) ld = {};
  var metaGrid = firstByClass(html, 'anime-meta-grid') || '';
  var kv = labelValues(metaGrid);

  // Sezonlar (ep-season-btn)
  var seasons = [];
  var seRe = /<button[^>]*class="[^"]*\bep-season-btn\b[^"]*"[^>]*data-season="(\d+)"[^>]*>([\s\S]*?)<\/button>/gi;
  var sm;
  while ((sm = seRe.exec(html)) !== null) {
    seasons.push({ season: parseInt(sm[1], 10), label: stripTags(sm[2]) });
  }

  // Bolumler: .ep-grid-numbers[data-season-pane="N"] bloklari
  var episodes = [];
  var paneRe = /<div[^>]*class="[^"]*\bep-grid-numbers\b[^"]*"[^>]*data-season-pane="(\d+)"[^>]*>/gi;
  var paneIdx = [];
  var pm;
  while ((pm = paneRe.exec(html)) !== null) {
    paneIdx.push({ season: parseInt(pm[1], 10), start: pm.index });
  }
  for (var i = 0; i < paneIdx.length; i++) {
    var chunk = html.slice(paneIdx[i].start, paneIdx[i + 1] ? paneIdx[i + 1].start : html.length);
    var aRe = anchorsWithClass(chunk, 'ep-num-btn');
    for (var j = 0; j < aRe.length; j++) {
      var am = aRe[j];
      var labelM = /<span[^>]*class="[^"]*\bep-num-label\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(am.inner);
      var label = stripTags(labelM ? labelM[1] : '');
      var num = parseInt(label, 10);
      if (isNaN(num)) num = episodes.length + 1;
      // bolum URL'i: /<slug>-<n>-sezon-<m>-bolum-izle/
      var um = am.href.match(/-([0-9]+)-sezon-([0-9]+)-bolum/);
      episodes.push({
        season: um ? parseInt(um[1], 10) : paneIdx[i].season,
        number: um ? parseInt(um[2], 10) : num,
        title: attr(am.tag, 'title') || null,
        url: absUrl(am.href, url),
      });
    }
  }

  var ogImage = /<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i.exec(html);
  var poster = ogImage ? absUrl(attr(ogImage[0], 'content'), url) : null;
  var h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  var descBlock = firstByClass(html, 'anime-desc');

  return {
    title: ld.name || (h1 ? stripTags(h1[1]) : ''),
    description: ld.description || (descBlock ? stripTags(descBlock) : ''),
    year: yearOf(ld.datePublished) || yearOf(kv['Yayın Yılı']),
    seasons: seasons,
    episodes: episodes,
    poster: poster,
    url: url || null,
  };
}

/** Oynatici kaynak listesi: var servers = JSON.parse(atob("...")) -> dizi. */
function parseServers(html) {
  var m = /var\s+servers\s*=\s*JSON\.parse\(atob\("([^"]+)"\)\)/.exec(html);
  if (!m) return [];
  try {
    var data = jsonLoose(b64DecodeUtf8(m[1]));
    return (data && typeof data.length !== 'undefined') ? data : [];
  } catch (e) {
    return [];
  }
}

/** Bolum detay sayfasi: JSON-LD + servers + csrf token. */
function parseEpisode(html, url) {
  var ld = null;
  var lds = ldJson(html);
  for (var q = 0; q < lds.length; q++) {
    if (lds[q] && lds[q]['@type'] && /TVEpisode/i.test(String(lds[q]['@type']))) { ld = lds[q]; break; }
  }
  if (!ld) ld = {};
  var servers = parseServers(html);
  var ogImage = /<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i.exec(html);
  var titleM = /<title>([\s\S]*?)<\/title>/i.exec(html);
  var csrfM = /<meta[^>]*name=["']csrf-token["'][^>]*content=["']([^"']+)["']/i.exec(html);
  var descM = /<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']*)["']/i.exec(html);

  return {
    title: ld.name || (titleM ? stripTags(titleM[1]) : ''),
    series: ld.partOfSeries && ld.partOfSeries.name ? ld.partOfSeries.name : null,
    season: typeof ld.seasonNumber !== 'undefined' ? ld.seasonNumber : null,
    episode: typeof ld.episodeNumber !== 'undefined' ? ld.episodeNumber : null,
    description: ld.description || (descM ? decodeEntities(descM[1]) : ''),
    poster: ogImage ? absUrl(attr(ogImage[0], 'content'), url) : null,
    servers: servers,
    csrf: csrfM ? attr(csrfM[0], 'content') : null,
    url: url || null,
  };
}

// ==========================================================================================
// 5) TMDB / Cinemeta eslestirme (diger eklentilerle ayni yaklasim)
// ==========================================================================================

function fetchTmdbMeta(id, mediaType) {
  var kind = mediaType === 'movie' ? 'movie' : 'tv';
  var url = TMDB_BASE_URL + '/' + kind + '/' + id + '?api_key=' + TMDB_API_KEY + '&language=tr-TR';
  return externalGet(url).then(function (body) {
    var data = jsonLoose(body);
    if (!data) throw new Error('TMDB meta JSON bozuk (id: ' + id + ')');
    return {
      names: [data.original_name || data.original_title, data.name || data.title],
      year: yearOf(data.first_air_date || data.release_date),
      kind: kind,
    };
  });
}

function fetchCinemetaMeta(imdbId) {
  return externalGet(CINEMETA_URL + 'series/' + imdbId + '.json').then(function (body) {
    var meta = (jsonLoose(body) || {}).meta || {};
    return { names: [meta.name, meta.originalName], year: yearOf(meta.released), kind: 'tv' };
  }).catch(function () {
    return externalGet(CINEMETA_URL + 'movie/' + imdbId + '.json').then(function (body) {
      var meta = (jsonLoose(body) || {}).meta || {};
      return { names: [meta.name, meta.originalName], year: yearOf(meta.released), kind: 'movie' };
    });
  });
}

/** CizgiMax'ta tum icerikler /diziler/ altindadir; bolum sayfasi ise -bolum-izle icerir. */
function urlKind(url) {
  url = String(url || '');
  if (/-bolum-izle\/?$/i.test(url) || /-bolum-izle\//.test(url)) return 'episode';
  if (/\/diziler\//.test(url)) return 'series';
  return '';
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
    var itemKind = urlKind(item.url);
    if (wantKind === 'movie' && itemKind === 'episode') score -= 10;
    if (wantKind === 'series' && itemKind === 'episode') score -= 10;
    if (itemKind === 'series') score += 5;
    var cardYear = parseInt(item.year, 10);
    if (!isNaN(cardYear) && year) {
      if (cardYear === year) score += 20;
      else if (Math.abs(cardYear - year) <= 1) score += 10;
    }
    if (score > bestScore) { bestScore = score; best = item; }
  }
  return bestScore >= 70 ? best : null;
}

// ==========================================================================================
// 6) Site aramasi (suggest API -> HTML yedek; asciiFold katlama ile)
// ==========================================================================================

/** Canli arama onerileri: /api/search/suggest/?q= */
function searchSuggest(q) {
  return siteGetText('/api/search/suggest/?q=' + encodeURIComponent(q), 'arama onerileri', {
    accept: 'application/json, text/plain, */*',
  }).then(function (text) {
    var data = jsonLoose(text);
    return parseSuggest(data);
  }).catch(function () {
    return [];
  });
}

/** HTML arama yedegi: /ara/?q= (film-item kartlari). */
function searchHtml(q) {
  return siteGetText('/ara/?q=' + encodeURIComponent(q), 'arama sayfasi').then(function (html) {
    var cards = parseCards(html);
    var out = [];
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      var u = c.seriesUrl || c.url;
      if (!u) continue;
      out.push({ id: c.id, title: c.title, url: u, poster: c.poster, year: c.year });
    }
    return out;
  }).catch(function () {
    return [];
  });
}

/** Iki kaynagi birlestirir (URL bazli tekillestirme). */
function mergeResults(listA, listB) {
  var seen = {};
  var out = [];
  var lists = [listA, listB];
  for (var l = 0; l < lists.length; l++) {
    for (var i = 0; i < lists[l].length; i++) {
      var it = lists[l][i];
      if (!it || !it.url || !it.title) continue;
      if (seen[it.url]) continue;
      seen[it.url] = true;
      out.push(it);
    }
  }
  return out;
}

function searchSite(query) {
  return searchSuggest(query).then(function (suggestItems) {
    return searchHtml(query).then(function (htmlItems) {
      return mergeResults(suggestItems, htmlItems);
    });
  });
}

/** TMDB/Cinemeta id'sini site kartina esler. Donus: {id,title,url,year,poster}. */
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
          if (!fallback) throw new Error('CizgiMax uzerinde bulunamadi: ' + names.join(' / '));
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
// 7) OYNATICI COZUMLEME
// ==========================================================================================

/** JSON nesnesinden ilk video URL'sini cikarir. */
function extractVideoUrlFromJson(json) {
  if (!json || typeof json !== 'object') return null;
  var keys = ['url', 'src', 'file', 'link', 'mp4', 'm3u8', 'stream', 'video_url', 'source'];
  for (var i = 0; i < keys.length; i++) {
    var v = json[keys[i]];
    if (typeof v === 'string' && /^https?:\/\//i.test(v)) return v;
  }
  for (var k in json) {
    if (Object.prototype.hasOwnProperty.call(json, k)) {
      var v2 = json[k];
      if (typeof v2 === 'string' && /\.(m3u8|mp4)(\?|$)/i.test(v2)) return v2;
    }
  }
  return null;
}

/** Duz metinden ilk m3u8/mp4/mpd adresini bulur. */
function extractFirstMediaUrl(text) {
  var m = /https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mp4|mpd)(?:\?[^\s"'<>\\]*)?/i.exec(String(text || ''));
  return m ? m[0] : null;
}

/** Metindeki tum medya URL'lerini (tekillenmis) dondurur. */
function extractMediaUrlList(text, limit) {
  var out = [];
  var seen = {};
  var re = /https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mp4|mpd)(?:\?[^\s"'<>\\]*)?/gi;
  var m;
  while ((m = re.exec(text)) !== null && out.length < (limit || 10)) {
    if (seen[m[0]]) continue;
    seen[m[0]] = true;
    out.push(m[0]);
  }
  return out;
}

/** Dzen embed sayfasindan HLS/DASH + kalite listesi cikarir. */
function dzenPageSources(html) {
  var urls = [];
  function scan(text) {
    var re = /"url":"(https:\/\/vd[^"]+)"[^}]*?"type":"(hls|dash|lowest|low|medium|high|fullhd|tiny)"/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      urls.push({ url: m[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/'), kind: m[2] });
    }
  }
  scan(html);
  if (!urls.length) {
    // JSON escaped bicim: https:\/\/vd... ve \u0026
    scan(String(html).replace(/\\u0026/g, '&').replace(/\\\//g, '/'));
  }
  var sources = [];
  var hls = null, dash = null;
  for (var i = 0; i < urls.length; i++) {
    if (urls[i].kind === 'hls' && !hls) hls = urls[i].url;
    if (urls[i].kind === 'dash' && !dash) dash = urls[i].url;
    if (DZEN_QUALITY[urls[i].kind]) {
      sources.push({ label: 'Dzen', type: 'hls', url: urls[i].url, quality: DZEN_QUALITY[urls[i].kind] });
    }
  }
  if (hls) sources.unshift({ label: 'Dzen', type: 'm3u8', url: hls, quality: 'auto' });
  else if (dash) sources.unshift({ label: 'Dzen', type: 'mpd', url: dash, quality: 'auto' });
  return { ok: sources.length > 0, provider: 'dzen.ru', sources: sources };
}

/** Sibnet shell oynatici sayfasindan video URL'si cikarir. */
function sibnetShellSources(html) {
  var found = [];
  var re = /https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mp4)(?:\?[^\s"'<>\\]*)?/gi;
  var m;
  while ((m = re.exec(html)) !== null && found.length < 6) {
    found.push({
      label: 'Sibnet',
      type: /\.m3u8/i.test(m[0]) ? 'm3u8' : 'mp4',
      url: m[0],
      quality: 'auto',
    });
  }
  var vu = /["']?(?:videoUrl|video_url|file|src)["']?\s*[:=]\s*["'](https?:\/\/[^"']+)["']/i.exec(html);
  if (vu) {
    found.unshift({
      label: 'Sibnet',
      type: /\.m3u8/i.test(vu[1]) ? 'm3u8' : 'mp4',
      url: vu[1],
      quality: 'auto',
    });
  }
  var j = jsonLoose(html);
  if (j) {
    var ju = extractVideoUrlFromJson(j);
    if (ju) {
      found.unshift({
        label: 'Sibnet',
        type: /\.m3u8/i.test(ju) ? 'm3u8' : 'mp4',
        url: ju,
        quality: 'auto',
      });
    }
  }
  return { ok: found.length > 0, provider: 'video.sibnet.ru', sources: found };
}

/** Genel embed sayfasindan medya URL'lerini tarar. */
function genericSources(html) {
  var urls = extractMediaUrlList(html, 10);
  var sources = [];
  for (var i = 0; i < urls.length; i++) {
    sources.push({
      label: 'Embed',
      type: /\.m3u8/i.test(urls[i]) ? 'm3u8' : (/\.mpd/i.test(urls[i]) ? 'mpd' : 'mp4'),
      url: urls[i],
      quality: 'auto',
    });
  }
  return { ok: sources.length > 0, provider: 'embed', sources: sources };
}

/** Embed URL'ini ceker ve govdeye gore dzen/sibnet/genel olarak cozer. */
function resolveEmbedUrl(embedUrl, depth) {
  var d = depth || 0;
  var isDzen = /dzen\.ru/i.test(embedUrl);
  var isSibnet = /sibnet/i.test(embedUrl);
  var referer = isDzen ? DZEN_REFERER : (isSibnet ? SIBNET_REFERER : SITE_REFERER);
  return httpReq(embedUrl, {
    referer: referer,
    accept: 'text/html,application/xhtml+xml,*/*',
    retries: 2,
  }).then(function (r) {
    if (r.status >= 400) {
      return { ok: false, provider: hostOf(embedUrl), error: 'HTTP ' + r.status + ' (embed)' };
    }
    var result = resolveEmbedBody(embedUrl, r.text || '', d);
    if (!result) {
      result = { ok: false, provider: hostOf(embedUrl), error: 'Embed icerigi cozulemedi' };
    }
    result.embed = embedUrl;
    return result;
  }).catch(function (err) {
    return { ok: false, provider: hostOf(embedUrl), error: String(err && err.message ? err.message : err) };
  });
}

/** Sayfa govdesini saglayiciya gore siniflandirip cozer. */
function resolveEmbedBody(embedUrl, html, depth) {
  html = html || '';
  if (!html) return null;
  var d = depth || 0;

  // Dzen embed sayfasi
  if (/dzen\.ru/i.test(embedUrl) || /dzen\.ru\/embed/i.test(html) || /"url":\s*"https:\/\/vd/i.test(html)) {
    var dz = dzenPageSources(html);
    if (dz.ok) { dz.provider = 'dzen.ru'; return dz; }
  }
  // Sibnet shell oynatıcı
  if (/video\.sibnet\.ru|shell\.php|videoid=/i.test(embedUrl) || /video\.sibnet\.ru|shell\.php/i.test(html)) {
    var sb = sibnetShellSources(html);
    if (sb.ok) { sb.provider = 'video.sibnet.ru'; return sb; }
  }
  // Gomulu iframe (farkli host ise ic ice bir kez daha dene)
  var im = /<iframe[^>]*src="(https?:\/\/[^"]+)"/i.exec(html);
  if (im && d < 2) {
    var inner = decodeEntities(im[1]);
    var innerHost = hostOf(inner);
    var outerHost = hostOf(embedUrl);
    if (!outerHost || !innerHost || innerHost !== outerHost) {
      return resolveEmbedUrl(inner, d + 1);
    }
  }
  return genericSources(html);
}

/** iframe tipi: /oynat/?t= -> 302 (veya takip edilen embed sayfasi) -> cozumle. */
function resolveIframeServer(srv) {
  return siteGet(srv.src, { accept: 'text/html,application/xhtml+xml,*/*' }).then(function (res) {
    var embed = (res.location && /^https?:\/\//i.test(res.location)) ? res.location : null;
    var body = res.text || '';
    if (!embed) {
      var im = /<iframe[^>]*src="(https?:\/\/[^"]+)"/i.exec(body);
      if (im) embed = decodeEntities(im[1]);
    }
    if (!embed) {
      // Yonlendirme takip edildi: govdeyi dogrudan siniflandir
      var byBody = resolveEmbedBody('', body, 0);
      if (byBody && byBody.ok) {
        byBody.label = srv.label;
        return byBody;
      }
      return { ok: false, provider: 'iframe', label: srv.label, error: 'Embed yonlendirmesi alinamadi' };
    }
    return resolveEmbedUrl(embed, 0).then(function (r) {
      r.label = srv.label;
      return r;
    });
  }).catch(function (err) {
    return { ok: false, provider: 'iframe', label: srv.label, error: String(err && err.message ? err.message : err) };
  });
}

/** Sibnet site API'si -> yedek: sibnet embed dogrudan. */
function resolveSibnetEmbed(embedId) {
  if (!embedId) return Promise.resolve({ ok: false, provider: 'video.sibnet.ru', error: 'embedId yok' });
  var urls = [
    'https://sibnet.ru/embed/' + embedId + '/',
    'https://www.sibnet.ru/embed/' + embedId + '/',
  ];
  var chain = Promise.resolve({ ok: false, provider: 'video.sibnet.ru', error: 'sibnet embed cozumlenemedi' });
  for (var i = 0; i < urls.length; i++) {
    (function (u) {
      chain = chain.then(function (prev) {
        if (prev && prev.ok) return prev;
        return httpReq(u, { referer: SIBNET_REFERER, accept: 'text/html,*/*', retries: 1 }).then(function (r) {
          if (r.status >= 400) return prev;
          var s = sibnetShellSources(r.text || '');
          if (s.ok) { s.embed = u; return s; }
          return prev;
        }).catch(function () { return prev; });
      });
    })(urls[i]);
  }
  return chain;
}

function resolveSibnetShell(embedUrl) {
  var vidM = /[?&]videoid=(\d+)/i.exec(embedUrl);
  var tries = [];
  if (vidM) {
    tries.push('https://video.sibnet.ru/api/video/' + vidM[1]);
    tries.push('https://video.sibnet.ru/api/video?videoid=' + vidM[1]);
    tries.push('https://video.sibnet.ru/shell.php?videoid=' + vidM[1]);
  }
  tries.push(embedUrl);
  var chain = Promise.resolve({ ok: false, provider: 'video.sibnet.ru', error: 'sibnet shell cozumlenemedi' });
  for (var i = 0; i < tries.length; i++) {
    (function (u) {
      chain = chain.then(function (prev) {
        if (prev && prev.ok) return prev;
        return httpReq(u, { referer: SIBNET_REFERER, accept: '*/*', noLang: true, retries: 1 }).then(function (r) {
          if (r.status >= 400) return prev;
          var s = sibnetShellSources(r.text || '');
          if (s.ok) { s.embed = u; return s; }
          return prev;
        }).catch(function () { return prev; });
      });
    })(tries[i]);
  }
  return chain;
}

function resolveSibnetServer(srv) {
  return siteGet(srv.streamUrl, { accept: 'application/json, text/plain, */*' }).then(function (res) {
    if (res.location && /^https?:\/\//i.test(res.location)) {
      return {
        ok: true,
        provider: 'sibnet',
        label: srv.label,
        sources: [{ label: 'Sibnet', type: /\.m3u8/i.test(res.location) ? 'm3u8' : 'mp4', url: res.location, quality: 'auto' }],
      };
    }
    var data = jsonLoose(res.text || '');
    var url = data ? extractVideoUrlFromJson(data) : extractFirstMediaUrl(res.text);
    if (url) {
      return {
        ok: true,
        provider: 'sibnet',
        label: srv.label,
        sources: [{ label: 'Sibnet', type: /\.m3u8/i.test(url) ? 'm3u8' : 'mp4', url: url, quality: 'auto' }],
      };
    }
    // Yedek: sibnet embed sayfasini dogrudan coz
    return resolveSibnetEmbed(srv.embedId).then(function (direct) {
      direct.label = srv.label;
      return direct;
    });
  }).catch(function (err) {
    // Site API basarisizsa embed yedegini yine de dene
    return resolveSibnetEmbed(srv.embedId).then(function (direct) {
      direct.label = srv.label;
      return direct;
    }).catch(function () {
      return { ok: false, provider: 'sibnet', label: srv.label, error: String(err && err.message ? err.message : err) };
    });
  });
}

/** np (native): /api/np-resolve/?t= -> {id} -> tau-video upstream -> (opsiyonel imza). */
function resolveNpServer(srv, csrf) {
  return siteGetText(srv.resolveUrl, 'np-resolve', { accept: 'application/json' }).then(function (text) {
    var data = jsonLoose(text);
    var id = data && data.id;
    if (!id) throw new Error('np-resolve id yok');

    return httpReq(NP_API_URL + encodeURIComponent(String(id)), {
      referer: '',
      accept: 'application/json, text/plain, */*',
      noLang: true,
      retries: 2,
    }).then(function (up) {
      var upstream = up.ok ? jsonLoose(up.text) : null;
      var urls = [];
      var captions = [];
      if (upstream) {
        var ulist = upstream.urls || [];
        for (var i = 0; i < ulist.length; i++) {
          var lb = String(ulist[i].label || '').toLowerCase();
          if (ulist[i].url && /\d+p$/.test(lb)) urls.push({ q: lb, url: ulist[i].url });
        }
        captions = upstream.captions || [];
      }

      // Sunucu tarafi imzalama: upstream URL'leri /api/stream/dzen/?s=... yapar
      var signTask;
      if (csrf && urls.length) {
        var tokenM = String(srv.resolveUrl).match(/[?&]t=([^&]+)/);
        var signUrls = [];
        for (var s = 0; s < urls.length; s++) signUrls.push({ q: urls[s].q, url: urls[s].url });
        signTask = siteGet('/api/sign-np/', {
          method: 'POST',
          contentType: 'application/json',
          accept: 'application/json',
          headers: { 'X-CSRF-Token': csrf },
          body: JSON.stringify({ token: tokenM ? tokenM[1] : '', urls: signUrls, captions: captions }),
        }).then(function (sres) {
          var sdata = sres.status < 400 ? jsonLoose(sres.text) : null;
          if (sdata && sdata.signed) {
            var map = {};
            for (var k = 0; k < sdata.signed.length; k++) {
              map[sdata.signed[k].q] = sdata.signed[k].src;
            }
            for (var u2 = 0; u2 < urls.length; u2++) {
              if (map[urls[u2].q]) urls[u2].url = absUrl(map[urls[u2].q]);
            }
          }
        }).catch(function () { /* imza basarisiz -> dogrudan URL kullanilir */ });
      } else {
        signTask = Promise.resolve();
      }

      return signTask.then(function () {
        if (!urls.length) {
          return { ok: false, provider: 'np', label: srv.label, error: 'Upstream kaynak bulunamadi (id=' + id + ')' };
        }
        var sources = [];
        for (var f = 0; f < urls.length; f++) {
          sources.push({
            label: 'np',
            type: /\.m3u8/i.test(urls[f].url) ? 'm3u8' : 'mp4',
            url: urls[f].url,
            quality: urls[f].q,
          });
        }
        var subs = [];
        for (var c = 0; c < captions.length; c++) {
          var cap = captions[c];
          if (cap && cap.url) {
            subs.push({
              url: absUrl(cap.url, NP_API_URL),
              lang: cap.lang || cap.name || 'tr',
              label: cap.name || cap.lang || 'Turkce',
            });
          }
        }
        return { ok: true, provider: 'np', label: srv.label, sources: sources, subtitles: subs };
      });
    });
  });
}

/** hdfc: meta endpoint -> {hls, subtitles}. */
function resolveMetaServer(srv) {
  return siteGetText(srv.metaUrl, 'hdfc meta', { accept: 'application/json' }).then(function (text) {
    var j = jsonLoose(text);
    if (!j) throw new Error('meta JSON yok');
    var sources = [];
    if (j.hls || j.url || j.m3u8) {
      sources.push({ label: 'HLS', type: 'm3u8', url: j.hls || j.url || j.m3u8, quality: 'auto' });
    }
    if (j.dash || j.mpd) {
      sources.push({ label: 'DASH', type: 'mpd', url: j.dash || j.mpd, quality: 'auto' });
    }
    var subs = [];
    if (j.subtitles && typeof j.subtitles.length !== 'undefined') {
      for (var i = 0; i < j.subtitles.length; i++) {
        var s = j.subtitles[i];
        var file = s && (s.file || s.url);
        if (!file) continue;
        subs.push({
          url: absUrl(file),
          lang: s.lang || s.kind || 'tr',
          label: s.label || s.lang || 'Turkce',
        });
      }
    }
    return { ok: sources.length > 0, provider: 'hdfc', label: srv.label, sources: sources, subtitles: subs };
  });
}

/** Tek bir oynatici kaynagini tipine gore cozer. */
function resolveOneServer(srv, ep) {
  if (!srv) return Promise.resolve({ ok: false, error: 'kaynak yok' });
  if (srv.type === 'sibnet' && srv.streamUrl) return resolveSibnetServer(srv);
  if (srv.type === 'iframe' && srv.src) return resolveIframeServer(srv);
  if (srv.resolveUrl) return resolveNpServer(srv, ep && ep.csrf);
  if (srv.metaUrl) return resolveMetaServer(srv);
  if (srv.src) return resolveEmbedUrl(srv.src, 0).then(function (r) { r.label = srv.label; return r; });
  return Promise.resolve({ ok: false, error: 'Desteklenmeyen tip: ' + srv.type, label: srv.label });
}

/** Bir bolumun tum oynatici kaynaklarini sirayla cozer. */
function resolveEpisodeServers(ep) {
  var servers = (ep && ep.servers) || [];
  var out = [];
  var chain = Promise.resolve();
  for (var i = 0; i < servers.length; i++) {
    (function (srv) {
      chain = chain.then(function () {
        return resolveOneServer(srv, ep).then(function (r) {
          if (!r.label) r.label = srv.label;
          out.push(r);
        }, function (e) {
          out.push({ ok: false, label: srv.label, error: String(e && e.message ? e.message : e) });
        });
      });
    })(servers[i]);
  }
  return chain.then(function () { return out; });
}

// ==========================================================================================
// 8) AKIS BICIMLEME + NUVIO ANA GIRIS
// ==========================================================================================

function headersForSource(url) {
  var u = String(url || '');
  if (/dzen\.ru|\/vd[0-9]/i.test(u)) return { Referer: DZEN_REFERER };
  if (/sibnet/i.test(u)) return { Referer: SIBNET_REFERER };
  if (u.indexOf(siteBase()) === 0 || u.indexOf(ORIGIN_URL) === 0 || u.indexOf('/api/stream/dzen/') !== -1) {
    var h = { Referer: SITE_REFERER };
    if (activeHost === 'origin') h['X-Forwarded-Host'] = 'cizgimax.online';
    return h;
  }
  return {};
}

function formatServerResult(resolved, mediaTitle) {
  if (!resolved || !resolved.ok || !resolved.sources || !resolved.sources.length) return [];
  var out = [];
  var seen = {};
  for (var i = 0; i < resolved.sources.length; i++) {
    var src = resolved.sources[i];
    if (!src || !src.url) continue;
    if (seen[src.url]) continue;
    seen[src.url] = true;
    out.push({
      name: '⌜ ÇizgiMax ⌟ | ' + (resolved.label || resolved.provider || 'Kaynak') + ' | ' + (src.quality || 'auto'),
      title: mediaTitle || '',
      url: src.url,
      quality: src.quality || 'auto',
      size: 'Unknown',
      headers: headersForSource(src.url),
      subtitles: resolved.subtitles || [],
    });
  }
  return out;
}

function qualityRank(label) {
  var m = String(label || '').match(/([0-9]+)p/);
  return m ? parseInt(m[1], 10) : 0;
}

function buildStreamsForPage(pageUrl, mediaTitle) {
  return siteGetText(pageUrl, 'bolum sayfasi').then(function (html) {
    var ep = parseEpisode(html, pageUrl);
    if (!ep.servers.length) throw new Error('oynatici kaynak listesi bulunamadi');
    return resolveEpisodeServers(ep).then(function (results) {
      var links = [];
      for (var i = 0; i < results.length; i++) {
        links = links.concat(formatServerResult(results[i], mediaTitle));
      }
      links.sort(function (a, b) { return qualityRank(b.quality) - qualityRank(a.quality); });
      return links;
    });
  });
}

/** Kart sayfasini oynatilabilir bolum sayfasina donusturur (S/E hedefiyle). */
function pickPlayablePage(card, wantSeason, wantEpisode) {
  return siteGetText(card.url, 'dizi sayfasi').then(function (html) {
    // Kart dogrudan oynatilabilir bir sayfa ise (tek bolumluk icerik / film)
    if (parseServers(html).length) {
      return { url: card.url, title: card.title };
    }
    var series = parseSeries(html, card.url);
    var eps = [];
    for (var i = 0; i < series.episodes.length; i++) eps.push(series.episodes[i]);
    if (!eps.length) throw new Error('Bolum bulunamadi: ' + card.title);

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
    if (!target) target = eps[0];
    return {
      url: target.url,
      title: card.title + ' S' + target.season + 'E' + target.number,
    };
  });
}

/**
 * NUVIO ANA GIRIS.
 * id: TMDB id (sayi/string) veya IMDB id ("tt...") | mediaType: "movie" | "tv"
 * CizgiMax Turkce cizgi film / anime / dizi katalogu; esleme TMDB/Cinemeta uzerinden yapilir.
 */
function getStreams(id, mediaType, season, episode) {
  if (mediaType !== 'tv' && mediaType !== 'movie' && mediaType !== 'anime') return Promise.resolve([]);

  var rid = String(Math.floor(Math.random() * 900000) + 100000);
  function log(msg, extra) {
    try {
      if (typeof extra !== 'undefined') console.log('[CizgiMax][rid:' + rid + '] ' + msg, extra);
      else console.log('[CizgiMax][rid:' + rid + '] ' + msg);
    } catch (e) { }
  }
  log('getStreams start', { id: id, S: season, E: episode });

  var wantSeason = parseInt(season, 10) || 1;
  var wantEpisode = parseInt(episode, 10) || 1;

  return resolveSiteCard(id, mediaType).then(function (card) {
    log('eslesme', { url: card.url, title: card.title, yil: card.year });
    return pickPlayablePage(card, wantSeason, wantEpisode);
  }).then(function (target) {
    log('bolum secildi', { url: target.url, title: target.title });
    return buildStreamsForPage(target.url, target.title);
  }).catch(function (err) {
    log('HATA: ' + (err && err.message ? err.message : err));
    return [];
  });
}

// Export for Nuvio
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams: getStreams };
} else {
  global.CizgiMaxScraperModule = { getStreams: getStreams };
}
