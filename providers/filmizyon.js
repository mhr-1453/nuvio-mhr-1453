// ==========================================================================================
// FilmIzyon Scraper for Nuvio Local Scrapers
// ------------------------------------------------------------------------------------------
// Kaynak: filmizyon-scraper.js (tek dosya Node scraper) birebir JavaScript'e cevirilmistir.
//
// Site : https://www.filmizyon.net  (WordPress + filmizyon-next temasi)
//
// URL YAPISI
//   Film   : /film/<slug>/            Dizi : /dizi/<slug>/
//   Bolum  : /dizi/<slug>/sezon-<n>/bolum-<n>/
//
// AJAX UCLARI (wp-admin/admin-ajax.php, nonce sayfadaki base64 inline script'ten gelir)
//   fz_film_archive_query (nonce: filmizyonDiscover, sayfa: /film-arsivi/)
//   fz_listing_load_more  (nonce: filmizyonListing,  sayfa: /)
//   fz_live_search        (nonce: filmizyonLiveSearch, sayfa: /)   -> arama
//
// OYNATICI ZINCIRI
//   part iframe (data-src) -> pl.vixolity.com/<token> embed sayfasi
//   embed sayfasindaki obfuscate inline script:
//     hex -> ters cevir -> base64 -> latin1 -> karakter offset -> base64 -> UTF-8 kaynak kod
//     kaynak kod icinde AYAR = { kaynak: "https://ha.vixolity.com/vs/<videoId>", videoId, ... }
//   videoId bicimi: film = tt<imdbId> | bolum = tt<imdbId>/s<sezon>/e<bolum>
//   ha.vixolity.com/vs/... = HLS master playlist (segmentler .gif olarak maskelenmis)
//   ONEMLI: manifest istegi gercek bir User-Agent gerektirir (curl UA => 403)
//
// Nuvio sozlesmesi: module.exports = { getStreams }
//   getStreams(id, mediaType, season, episode) -> Promise<[{name,title,url,quality,size,headers,subtitles}]>
//   id: TMDB id (sayi) veya IMDB id ("tt1234567") | mediaType: "movie" | "tv"
//
// NOTLAR
//   - Tum regex desenleri new RegExp('...') string biciminde kurulur; nokta [.] ve rakam
//     [0-9] biciminde yazilir. Boylece kaynak dosya icerisinde backslash karakteri yoktur.
//   - Hermes ortaminda Buffer/atob garanti degildir; base64/hex/UTF-8 cozumleri saf JS ile
//     yazilmistir.
//   - async/await YOK — tamami Promise zinciridir (Hermes uyumu icin).
// ==========================================================================================
'use strict';

var BASE_URL = 'https://www.filmizyon.net';
var AJAX_URL = BASE_URL + '/wp-admin/admin-ajax.php';

var USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

var TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
var TMDB_BASE_URL = 'https://api.themoviedb.org/3';
var CINEMETA_URL = 'https://v3-cinemeta.strem.io/meta/';

// Yardimci karakter sabitleri (kacis kullanimini onlemek icin)
var DQ = String.fromCharCode(34);   // cift tirnak
var APOS = String.fromCharCode(39); // tek tirnak
var NL = String.fromCharCode(10);   // satir sonu
var CR = String.fromCharCode(13);   // satir basi
var TAB = String.fromCharCode(9);   // tab
var BS = String.fromCharCode(92);   // ters bolu (escape karakteri)
var WS = ' ' + NL + CR + TAB;       // bosluk sinifi icerigi
var WSCLASS = '[' + WS + ']';       // regex bosluk sinifi

// ==========================================================================================
// 0) Metin yardimcilari
// ==========================================================================================

function decodeEntities(s) {
  var out = String(s || '');
  var pairs = [
    ['&nbsp;', ' '], ['&amp;', '&'], ['&lt;', '<'], ['&gt;', '>'],
    ['&quot;', DQ], ['&#39;', APOS], ['&#039;', APOS], ['&#0?39;', APOS],
    ['&rsquo;', String.fromCharCode(8217)], ['&lsquo;', String.fromCharCode(8216)],
    ['&mdash;', String.fromCharCode(8212)], ['&ndash;', String.fromCharCode(8211)],
    ['&ccedil;', 'c'], ['&uuml;', 'u'], ['&ouml;', 'o'],
  ];
  for (var i = 0; i < pairs.length; i++) {
    if (pairs[i][0].indexOf('?') !== -1) {
      // &#0?39; bicimindeki desen: &#039; ve &#39; ikisini de kapsar
      var both = ['&#39;', '&#039;'];
      for (var b = 0; b < both.length; b++) {
        while (out.indexOf(both[b]) !== -1) out = out.split(both[b]).join(pairs[i][1]);
      }
      continue;
    }
    while (out.indexOf(pairs[i][0]) !== -1) out = out.split(pairs[i][0]).join(pairs[i][1]);
  }
  var dec = new RegExp('&#([0-9]+);', 'g');
  out = out.replace(dec, function (m, d) { return String.fromCharCode(parseInt(d, 10)); });
  var hex = new RegExp('&#x([0-9A-Fa-f]+);', 'gi');
  out = out.replace(hex, function (m, h) { return String.fromCharCode(parseInt(h, 16)); });
  return out;
}

function stripTags(html) {
  var t = String(html || '');
  var scriptRe = new RegExp('<script[^]*?</script>', 'gi');
  t = t.replace(scriptRe, ' ');
  var styleRe = new RegExp('<style[^]*?</style>', 'gi');
  t = t.replace(styleRe, ' ');
  var svgRe = new RegExp('<svg[^]*?</svg>', 'gi');
  t = t.replace(svgRe, ' ');
  var brRe = new RegExp('<br[^>]*>', 'gi');
  t = t.replace(brRe, ' ');
  var blockRe = new RegExp('</(p|div|li|h[1-6]|tr)>', 'gi');
  t = t.replace(blockRe, ' ');
  var tagRe = new RegExp('<[^>]+>', 'g');
  t = t.replace(tagRe, ' ');
  return decodeEntities(t.replace(new RegExp('[ ' + WS + ']+', 'g'), ' ')).trim();
}

function clean(s) {
  return stripTags(s).replace(new RegExp('[' + WS + ']+', 'g'), ' ').trim();
}

function toInt(v) {
  var n = parseInt(String(v || '').replace(/[^0-9-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function toFloat(v) {
  var n = parseFloat(String(v || '').replace(/,/g, '.').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function attr(html, name) {
  var re = new RegExp(name + WSCLASS + '*[=][ ]*[' + DQ + ']([^' + DQ + ']*)[' + DQ + ']', 'i');
  var m = re.exec(html || '');
  return m ? decodeEntities(m[1]) : null;
}

function attrAny(html, name) {
  var re = new RegExp(name + WSCLASS + '*[=][ ]*(?:[' + DQ + ']([^' + DQ + ']*)[' + DQ + ']|[' + APOS + ']([^' + APOS + ']*)[' + APOS + '])', 'i');
  var m = re.exec(html || '');
  if (!m) return null;
  return decodeEntities(typeof m[1] !== 'undefined' ? m[1] : m[2]);
}

function srcsetLargest(srcset) {
  if (!srcset) return null;
  var best = null;
  var bestW = -1;
  var parts = srcset.split(',');
  for (var i = 0; i < parts.length; i++) {
    var bits = parts[i].replace(new RegExp('[' + WS + ']+', 'g'), ' ').trim().split(' ');
    var url = bits[0];
    var w = bits[1] ? parseInt(bits[1], 10) || 0 : 0;
    if (url && w > bestW) {
      bestW = w;
      best = url;
    }
  }
  return best;
}

// ==========================================================================================
// 1) Saf kod cozuculer (Hermes icin Buffer/atob yerine)
// ==========================================================================================

var B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
var B64_LOOKUP = {};
(function () {
  for (var i = 0; i < B64_ALPHABET.length; i++) B64_LOOKUP[B64_ALPHABET.charAt(i)] = i;
})();

/** Base64 metni -> bayt dizisi (ilk '=' dolgusunda durur; Buffer davranisiyla ayni). */
function b64Decode(str) {
  var out = [];
  var bits = 0;
  var acc = 0;
  var s = String(str || '');
  for (var i = 0; i < s.length; i++) {
    var ch = s.charAt(i);
    if (ch === '=') break; // dolgu: kalan atlanir
    var v = B64_LOOKUP[ch];
    if (typeof v === 'undefined') continue; // alfabe disi (satir sonu vb.) atlanir
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xFF);
    }
  }
  return out;
}

/** Hex metni -> bayt dizisi. */
function hexToBytes(hex) {
  var out = [];
  var s = String(hex || '');
  for (var i = 0; i + 1 < s.length; i += 2) {
    out.push(parseInt(s.substring(i, i + 2), 16));
  }
  return out;
}

/** Bayt dizisi -> latin1 metin (charCode = bayt degeri). */
function bytesToLatin1(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

/** Bayt dizisini UTF-8 olarak cozer (4 baytli karakterler dahil). */
function utf8Decode(bytes) {
  var out = '';
  var i = 0;
  while (i < bytes.length) {
    var b = bytes[i];
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i += 1;
    } else if (b < 0xE0) {
      out += String.fromCharCode(((b & 0x1F) << 6) | ((bytes[i + 1] || 0) & 0x3F));
      i += 2;
    } else if (b < 0xF0) {
      out += String.fromCharCode(((b & 0x0F) << 12) | ((bytes[i + 1] || 0) & 0x3F) << 6 | ((bytes[i + 2] || 0) & 0x3F));
      i += 3;
    } else {
      var cp = ((b & 0x07) << 18) | ((bytes[i + 1] || 0) & 0x3F) << 12 | ((bytes[i + 2] || 0) & 0x3F) << 6 | ((bytes[i + 3] || 0) & 0x3F);
      cp -= 0x10000;
      out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
      i += 4;
    }
  }
  return out;
}

function reverseString(s) {
  var out = '';
  for (var i = s.length - 1; i >= 0; i--) out += s.charAt(i);
  return out;
}

/** Verilen '[' konumundan eslesen ']'... aslinda '{' -> '}' konumu (string kacislerine duyarli). */
function matchBrace(text, openIndex) {
  var depth = 0;
  var inStr = null;
  for (var i = openIndex; i < text.length; i++) {
    var c = text.charAt(i);
    if (inStr) {
      if (c === BS) {
        i++;
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === DQ || c === APOS) {
      inStr = c;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function jsonLooseParse(raw) {
  try {
    return JSON.parse(raw);
  } catch (e1) {
    // sondaki virgul toleransi: ",}" ve ",]" bicimleri (']' alternasyonla, kacissiz)
    var fixed = raw.replace(new RegExp(',([' + WS + ']*(?:[}]|]))', 'g'), '$1');
    try {
      return JSON.parse(fixed);
    } catch (e2) {
      return null;
    }
  }
}

// ==========================================================================================
// 2) HTML cozumleme: inline configler (nonce) + vixolity payload
// ==========================================================================================

/** data:text/javascript;base64 URI'lerindeki window config'lerini toplar. */
function decodeInlineConfigs(html) {
  var configs = {};
  var re = new RegExp('data:text[/]javascript;base64,([A-Za-z0-9+/=]+)', 'g');
  var m;
  while ((m = re.exec(html)) !== null) {
    var text = utf8Decode(b64Decode(m[1]));
    var varRe = new RegExp('(?:var|window[.]|const|let)[' + WS + ']+([A-Za-z0-9_$]+)[' + WS + ']*[=][' + WS + ']*[{]', 'g');
    var v;
    while ((v = varRe.exec(text)) !== null) {
      var objStart = v.index + v[0].length - 1;
      var objEnd = matchBrace(text, objStart);
      if (objEnd < 0) continue;
      var parsed = jsonLooseParse(text.substring(objStart, objEnd + 1));
      if (parsed && typeof parsed === 'object') configs[v[1]] = parsed;
      varRe.lastIndex = objEnd;
    }
  }
  return configs;
}

/**
 * Vixolity embed sayfasindaki obfuscate script'i cozer.
 * Duzen: hex -> ters -> base64 -> latin1 -> karakter offset -> base64 -> UTF-8 kaynak kod
 */
function decodeVixolityPayload(html) {
  var re = new RegExp('[}][)][(][' + WS + ']*[' + APOS + ']([0-9a-fA-F]+)[' + APOS + ']' +
    '(?:[,][' + WS + ']*[' + APOS + ']?([0-9]+)[' + APOS + ']?)?');
  var m = re.exec(html);
  if (!m) return null;

  var hex = m[1];
  var offset = m[2] ? parseInt(m[2], 10) : 0;

  var bytes = hexToBytes(hex);
  bytes.reverse();
  var reversed = bytesToLatin1(bytes);

  var stage2 = bytesToLatin1(b64Decode(reversed));

  var stage3 = '';
  for (var i = 0; i < stage2.length; i++) {
    stage3 += String.fromCharCode((stage2.charCodeAt(i) - offset + 256) % 256);
  }

  var source;
  try {
    source = utf8Decode(b64Decode(stage3));
  } catch (e) {
    return null;
  }
  if (!source) return null;

  var ayarIdx = new RegExp('var[' + WS + ']+AYAR[' + WS + ']*[=][' + WS + ']*[{]').exec(source);
  if (!ayarIdx) return { source: source, ayar: null };
  var braceStart = ayarIdx.index + ayarIdx[0].length - 1;
  var braceEnd = matchBrace(source, braceStart);
  if (braceEnd < 0) return { source: source, ayar: null };

  var rawAyar = source.substring(braceStart, braceEnd + 1);
  var ayar = jsonLooseParse(rawAyar);
  return { source: source, ayar: ayar || null };
}

/** URL'nin saglayicisini tespit eder. */
function detectProvider(url) {
  var u = String(url || '').toLowerCase();
  if (!u) return null;
  if (u.indexOf('youtube.com') !== -1 || u.indexOf('youtu.be') !== -1) return 'youtube';
  if (u.indexOf('vixolity.com') !== -1) return 'vixolity';
  if (u.indexOf('vidmoly') !== -1) return 'vidmoly';
  if (u.indexOf('dailymotion') !== -1) return 'dailymotion';
  if (u.indexOf('ok.ru') !== -1 || u.indexOf('odnoklassniki') !== -1) return 'okru';
  if (u.indexOf('vk.com') !== -1 || u.indexOf('vkvideo') !== -1) return 'vk';
  if (u.indexOf('streamtape') !== -1) return 'streamtape';
  if (u.indexOf('voe.') !== -1) return 'voe';
  if (u.indexOf('megacloud') !== -1) return 'megacloud';
  return null;
}

// ==========================================================================================
// 3) HLS master playlist cozumleme
// ==========================================================================================

function parseAttributeList(str) {
  var out = {};
  var re = new RegExp('([A-Z0-9-]+)[=]([' + DQ + '][^' + DQ + ']*[' + DQ + ']|[^,]*)', 'g');
  var m;
  while ((m = re.exec(str)) !== null) {
    var val = m[2];
    if (val.charAt(0) === DQ && val.charAt(val.length - 1) === DQ) {
      val = val.substring(1, val.length - 1);
    }
    out[m[1]] = val;
  }
  return out;
}

function resolveUrl(base, rel) {
  if (!rel) return rel;
  if (rel.indexOf('http://') === 0 || rel.indexOf('https://') === 0) return rel;
  if (rel.indexOf('//') === 0) return 'https:' + rel;
  var cut = base.lastIndexOf('/');
  return base.substring(0, cut + 1) + rel;
}

function parseMasterPlaylist(url, text) {
  var result = { isMaster: false, variants: [], subtitles: [], audio: [] };
  if (!text) return result;
  var lines = String(text).split(CR).join(NL).split(NL);
  var pending = null;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    if (line.indexOf('#EXT-X-STREAM-INF:') === 0) {
      pending = parseAttributeList(line.substring(line.indexOf(':') + 1));
      continue;
    }
    if (line.indexOf('#EXT-X-MEDIA:') === 0) {
      var a = parseAttributeList(line.substring(line.indexOf(':') + 1));
      var track = {
        type: a.TYPE,
        groupId: a['GROUP-ID'],
        name: a.NAME || null,
        lang: a.LANGUAGE || 'tr',
        label: a.NAME || a.LANGUAGE || 'Altyazi',
        url: a.URI ? resolveUrl(url, a.URI) : null,
      };
      if (track.type === 'SUBTITLES' || track.type === 'CLOSED-CAPTIONS') result.subtitles.push(track);
      else if (track.type === 'AUDIO') result.audio.push(track);
      continue;
    }
    if (line.charAt(0) === '#') continue;
    if (pending) {
      var resParts = pending.RESOLUTION ? pending.RESOLUTION.split('x') : [];
      result.variants.push({
        url: resolveUrl(url, line),
        bandwidth: toInt(pending.BANDWIDTH),
        resolution: pending.RESOLUTION || null,
        height: resParts[1] ? toInt(resParts[1]) : null,
      });
      pending = null;
    }
  }
  result.isMaster = result.variants.length > 0;
  // en yuksek cozunurluge gore sirala
  result.variants.sort(function (a, b) { return (b.height || 0) - (a.height || 0); });
  return result;
}

// ==========================================================================================
// 4) Ag katmani (throttle + yeniden deneme)
// ==========================================================================================

var _lastRequestAt = 0;
var _nonceCache = {};

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function throttle() {
  var wait = _lastRequestAt + 250 - Date.now();
  _lastRequestAt = Date.now();
  return wait > 0 ? sleep(wait) : Promise.resolve();
}

function baseHeaders(referer, accept) {
  return {
    'User-Agent': USER_AGENT,
    'Accept': accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    'Referer': referer || BASE_URL + '/',
  };
}

function siteGet(url, options, attemptNo) {
  var opts = options || {};
  var n = attemptNo || 0;
  return throttle().then(function () {
    return fetch(url, {
      method: opts.method || 'GET',
      headers: Object.assign(baseHeaders(opts.referer, opts.accept), opts.extraHeaders || {}),
      body: opts.body,
    }).then(function (res) {
      return res.text().then(function (body) {
        return { status: res.status, body: body };
      });
    });
  }).catch(function (err) {
    if (n < 2) {
      return sleep(600 * (n + 1)).then(function () { return siteGet(url, opts, n + 1); });
    }
    throw err;
  });
}

/** HTML sayfa ceker; 200 degilse hata firlatir. */
function getPage(url, options) {
  return siteGet(url, options).then(function (r) {
    if (r.status !== 200) throw new Error('Sayfa ' + r.status + ': ' + url);
    return r.body;
  });
}

/** admin-ajax POST cagrisi (form-urlencoded). */
function postAjax(payload) {
  var parts = [];
  for (var k in payload) {
    if (typeof payload[k] !== 'undefined' && payload[k] !== null) {
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(payload[k])));
    }
  }
  var body = parts.join('&');
  return siteGet(AJAX_URL, {
    method: 'POST',
    accept: 'application/json, text/javascript, */*; q=0.01',
    extraHeaders: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
    body: body,
  }).then(function (r) {
    try {
      return JSON.parse(r.body);
    } catch (e) {
      return { success: false, raw: r.body };
    }
  });
}

/** Sayfa inline config'lerinden nonce ceker (oturum icinde cache'lenir). */
function getNonce(configKey) {
  if (_nonceCache[configKey]) return Promise.resolve(_nonceCache[configKey]);
  var pages = {
    filmizyonDiscover: '/film-arsivi/',
    filmizyonListing: '/',
    filmizyonLiveSearch: '/',
  };
  var path = pages[configKey] || '/';
  return getPage(BASE_URL + path).then(function (html) {
    var configs = decodeInlineConfigs(html);
    var nonce = configs[configKey] && configs[configKey].nonce;
    if (!nonce) throw new Error('Nonce bulunamadi: ' + configKey);
    _nonceCache[configKey] = nonce;
    return nonce;
  });
}

// ==========================================================================================
// 5) TMDB / Cinemeta meta cozumleme + eslesme
// ==========================================================================================

function fetchTmdbMeta(id, mediaType) {
  var type = mediaType === 'movie' ? 'movie' : 'tv';
  var url = TMDB_BASE_URL + '/' + type + '/' + id + '?api_key=' + TMDB_API_KEY + '&language=tr-TR&append_to_response=external_ids';
  return siteGet(url, { accept: 'application/json' }).then(function (r) {
    if (r.status !== 200) throw new Error('TMDB HTTP ' + r.status + ': ' + id);
    var j = JSON.parse(r.body);
    var names = [j.name || j.title];
    if (j.original_name) names.push(j.original_name);
    if (j.original_title) names.push(j.original_title);
    var date = j.first_air_date || j.release_date || '';
    return {
      name: j.name || j.title || '',
      names: names,
      year: parseInt(String(date).substring(0, 4), 10) || null,
      imdbId: (j.external_ids && j.external_ids.imdb_id) || null,
      type: type,
    };
  });
}

function fetchCinemetaMeta(id, mediaType) {
  var types = mediaType === 'movie' ? ['movie', 'series'] : ['series', 'movie'];
  var idx = 0;
  function tryType() {
    if (idx >= types.length) throw new Error('Cinemeta kaydi bulunamadi: ' + id);
    var url = CINEMETA_URL + types[idx++] + '/' + id + '.json';
    return siteGet(url, { accept: 'application/json' }).then(function (r) {
      if (r.status !== 200) return tryType();
      var j = JSON.parse(r.body);
      var meta = j.meta || {};
      var names = [meta.name];
      if (meta.originalName) names.push(meta.originalName);
      if (meta.aliases && typeof meta.aliases.length === 'number') {
        for (var i = 0; i < meta.aliases.length && i < 5; i++) names.push(meta.aliases[i]);
      }
      return {
        name: meta.name || '',
        names: names,
        year: meta.releaseInfo ? parseInt(String(meta.releaseInfo).substring(0, 4), 10) || null : null,
        imdbId: id,
        type: types[0] === 'movie' ? 'movie' : 'tv',
      };
    });
  }
  return tryType();
}

function normalizeTitle(s) {
  var map = { 'ı': 'i', 'İ': 'i', 'ş': 's', 'Ş': 's', 'ğ': 'g', 'Ğ': 'g', 'ü': 'u', 'Ü': 'u', 'ö': 'o', 'Ö': 'o', 'ç': 'c', 'Ç': 'c', 'â': 'a', 'î': 'i', 'û': 'u', 'ê': 'e', 'é': 'e' };
  var out = '';
  var str = String(s || '');
  for (var i = 0; i < str.length; i++) {
    var c = map[str[i]];
    out += (typeof c !== 'undefined') ? c : str[i];
  }
  return out.toLowerCase();
}

function normalizeForCompare(s) {
  return normalizeTitle(String(s || '')).replace(/[^a-z0-9]+/g, '');
}

function diceSimilarity(a, b) {
  var s1 = normalizeTitle(a);
  var s2 = normalizeTitle(b);
  if (s1 === s2) return 100;
  if (s1.length < 2 || s2.length < 2) return 0;
  var bigrams1 = {};
  var count1 = 0;
  for (var i = 0; i < s1.length - 1; i++) {
    var g = s1.substring(i, i + 2);
    bigrams1[g] = (bigrams1[g] || 0) + 1;
    count1++;
  }
  var count2 = 0;
  var hits = 0;
  for (var j = 0; j < s2.length - 1; j++) {
    var g2 = s2.substring(j, j + 2);
    count2++;
    if (bigrams1[g2]) { hits++; bigrams1[g2]--; }
  }
  return Math.round((2 * hits / (count1 + count2)) * 100);
}

/** Arama sonucu icinden en iyi eslesmeyi secer (tt id > ad+tip > ad+yil). */
function pickBestMatch(items, names, year, imdbId, wantType) {
  var best = null;
  var bestScore = 0;
  for (var i = 0; i < (items || []).length; i++) {
    var it = items[i];
    if (!it || !it.title || !it.url) continue;
    var score = 0;

    // 1) poster URL'inde gomulu IMDB id (en guvenli eslesme)
    if (imdbId && it.poster && String(it.poster).indexOf(imdbId) !== -1) score = 100;

    // 2) ad benzerligi
    if (score < 100) {
      var nameScore = 0;
      for (var j = 0; j < names.length; j++) {
        if (!names[j]) continue;
        var sim = diceSimilarity(it.title, names[j]);
        var eq = normalizeForCompare(it.title) === normalizeForCompare(names[j]);
        var cand = eq ? 85 : sim * 0.85;
        if (cand > nameScore) nameScore = cand;
      }
      score = nameScore;
      // 3) yil uyumu (tam yil guclu sinyal; +-1 tolerans)
      var itYear = toInt(it.year);
      if (year && itYear) {
        if (itYear === year) score += 15;
        else if (Math.abs(itYear - year) <= 1) score += 8;
      }
      // 4) tip uyumu ('Film' / 'Dizi')
      if (wantType === 'movie' && it.typeLabel === 'Film') score += 5;
      if (wantType === 'tv' && it.typeLabel === 'Dizi') score += 5;
    }

    if (score > bestScore) {
      bestScore = score;
      best = it;
    }
  }
  return bestScore >= 60 ? best : null;
}

/** TMDB/IMDB kimligini FilmIzyon arama sonucuna cevirir. */
function resolveFilmizyonItem(id, mediaType) {
  var isImdb = typeof id === 'string' && id.indexOf('tt') === 0;
  var metaTask = isImdb
    ? fetchCinemetaMeta(id, mediaType || 'tv')
    : fetchTmdbMeta(id, mediaType || 'tv');

  return metaTask.then(function (meta) {
    var names = [];
    for (var i = 0; i < meta.names.length; i++) {
      if (meta.names[i]) names.push(meta.names[i]);
    }
    if (!names.length) throw new Error('Baslik adi bulunamadi (id: ' + id + ')');
    var wantType = meta.type === 'movie' ? 'movie' : 'tv';

    var tryIndex = 0;
    function tryNext() {
      if (tryIndex >= names.length) {
        return searchFallback(names[0]).then(function (items) {
          var fb = pickBestMatch(items, names, meta.year, meta.imdbId, wantType);
          if (!fb) throw new Error('FilmIzyon uzerinde bulunamadi: ' + names.join(' / '));
          return fb;
        });
      }
      var query = names[tryIndex++];
      return search(query).then(function (items) {
        var match = pickBestMatch(items, names, meta.year, meta.imdbId, wantType);
        if (match) return match;
        return tryNext();
      });
    }
    return tryNext();
  });
}

// ==========================================================================================
// 6) Arama (AJAX canli arama; nonce cekilemezse ?s= HTML yedegi)
// ==========================================================================================

function search(query) {
  return getNonce('filmizyonLiveSearch').then(function (nonce) {
    return postAjax({ action: 'fz_live_search', nonce: nonce, q: String(query || '').trim() });
  }).then(function (json) {
    if (!json || !json.success || !json.data) return [];
    var raw = json.data.items || [];
    var out = [];
    for (var i = 0; i < raw.length && i < 20; i++) {
      var it = raw[i];
      out.push({
        id: it.id || null,
        typeLabel: it.label || '',
        title: it.title || '',
        url: it.url || null,
        poster: it.poster || null,
        year: it.year || null,
      });
    }
    return out;
  }).catch(function () {
    // nonce veya AJAX basarisiz -> HTML yedegi
    return searchFallback(query);
  });
}

/** WordPress ?s= arama sayfasindan poster kartlarini cozer (yedek yol). */
function searchFallback(query) {
  var url = BASE_URL + '/?s=' + encodeURIComponent(String(query || '').trim());
  return getPage(url).then(function (html) {
    return parsePosterCards(html);
  }).catch(function () {
    return [];
  });
}

function sliceArticleBlock(html, openIndex) {
  var openRe = new RegExp('<article[^a-zA-Z0-9_]', 'gi');
  var closeRe = new RegExp('</article[ ]*>', 'gi');
  var depth = 1;
  var i = openIndex;
  while (i < html.length) {
    openRe.lastIndex = i;
    closeRe.lastIndex = i;
    var o = openRe.exec(html);
    var c = closeRe.exec(html);
    if (!c) break;
    if (o && o.index < c.index) {
      depth++;
      i = o.index + 1;
    } else {
      depth--;
      i = c.index + c[0].length;
      if (depth === 0) return html.substring(openIndex, i);
    }
  }
  return html.substring(openIndex);
}

function parsePosterCards(html) {
  var items = [];
  var re = new RegExp('<article[^>]*class[=][ ]*[' + DQ + '][^' + DQ + ']*fz-poster-card[^' + DQ + ']*[' + DQ + '][^>]*>', 'gi');
  var m;
  while ((m = re.exec(html)) !== null) {
    var block = sliceArticleBlock(html, m.index);
    var linkRe = new RegExp('<a[ ]+class[=]["]' + 'fz-poster-card__link["][^>]*href[=][' + DQ + ']([^' + DQ + ']+)[' + DQ + ']', 'i');
    var link = linkRe.exec(block);
    var imgRe = new RegExp('<img[^>]*class[=][ ]*[' + DQ + ']fz-poster-card__img[' + DQ + '][^>]*>', 'i');
    var img = imgRe.exec(block);
    var titleRe = new RegExp('class[=][ ]*[' + DQ + ']fz-poster-card__title[' + DQ + '][^>]*>([^]*?)</(?:h3|span)>', 'i');
    var title = titleRe.exec(block);
    var yearRe = new RegExp('class[=][ ]*[' + DQ + ']fz-poster-card__year[' + DQ + '][^>]*>([^]*?)</(?:span|h3)>', 'i');
    var year = yearRe.exec(block);
    var posterUrl = img ? srcsetLargest(attrAny(img[0], 'srcset')) || attr(img[0], 'src') : null;
    var artClass = attr(m[0], 'class') || '';
    if (!link) continue;
    items.push({
      title: title ? clean(title[1]) : null,
      url: decodeEntities(link[1]),
      year: year ? clean(year[1]) : null,
      poster: posterUrl,
      typeLabel: artClass.indexOf('dizi') !== -1 ? 'Dizi' : 'Film',
    });
    if (items.length >= 20) break;
  }
  return items;
}

// ==========================================================================================
// 7) Sayfa cozumleme: part'lar + sezon panelleri + erisim durumu
// ==========================================================================================

/** Oynatici part sekmelerini (iframe'ler) cozer. */
function parseParts(html) {
  var parts = [];
  var startRe = new RegExp('<div[^>]*class[=][ ]*[' + DQ + '][^' + DQ + ']*fz-player__part[^' + DQ + ']*[' + DQ + '][^>]*data-part-panel[=][' + DQ + ']([0-9]+)[' + DQ + '][^>]*>', 'gi');
  var starts = [];
  var sm;
  while ((sm = startRe.exec(html)) !== null) {
    starts.push({ number: toInt(sm[1]), end: sm.index + sm[0].length, index: sm.index });
  }
  for (var i = 0; i < starts.length; i++) {
    var nextBoundary = i + 1 < starts.length ? starts[i + 1].index : html.length;
    var body = html.substring(starts[i].end, nextBoundary);
    var navRe = new RegExp('data-part-switch[=][' + DQ + ']' + starts[i].number + '[' + DQ + '][^>]*>([^]*?)</button>', 'i');
    var nav = navRe.exec(html);
    var iframeRe = new RegExp('<iframe[^>]*>', 'i');
    var iframe = iframeRe.exec(body);
    var src = iframe ? attrAny(iframe[0], 'data-src') || attrAny(iframe[0], 'src') : null;
    var label = nav ? clean(nav[1]) : null;
    parts.push({
      number: starts[i].number,
      label: label,
      embedUrl: src,
      provider: src ? detectProvider(src) : null,
      isTrailer: /fragman/i.test(label || ''),
    });
  }

  // Yedek: part bloklari bulunamazsa sayfadaki tum vixolity iframe'leri
  if (!parts.length) {
    var allIframes = [];
    var re = new RegExp('<iframe[^>]*>', 'gi');
    var im;
    while ((im = re.exec(html)) !== null) {
      var s = attrAny(im[0], 'data-src') || attrAny(im[0], 'src');
      if (s && detectProvider(s) === 'vixolity') allIframes.push(s);
    }
    for (var k = 0; k < allIframes.length; k++) {
      parts.push({ number: k + 1, label: 'Kaynak ' + (k + 1), embedUrl: allIframes[k], provider: 'vixolity', isTrailer: false });
    }
  }
  return parts;
}

/** DMCA / engel / 18+ durumunu kontrol eder. */
function detectAvailability(html) {
  var out = { playable: true, status: 'available', notice: null };
  var dmcaRe = new RegExp('class[=][ ]*[' + DQ + ']fz-dmca-notice__text[' + DQ + '][^>]*>([^]*?)</p>', 'i');
  var dmca = dmcaRe.exec(html);
  if (dmca) {
    out.playable = false;
    out.status = 'removed-dmca';
    out.notice = clean(dmca[1]);
    return out;
  }
  if (new RegExp('fz-player[^' + DQ + ']*fz-player--blocked', 'i').test(html)) {
    out.playable = false;
    out.status = 'blocked';
  }
  return out;
}

/** Dizi sayfasindaki sezon panellerinden bolum linklerini cozer (yedek URL yolu). */
function parseSeasonPanels(html) {
  var seasons = [];
  var panelRe = new RegExp('data-season-panel[=][' + DQ + ']([0-9]+)[' + DQ + ']', 'gi');
  var starts = [];
  var pm;
  while ((pm = panelRe.exec(html)) !== null) {
    starts.push({ number: toInt(pm[1]), index: pm.index });
  }
  for (var i = 0; i < starts.length; i++) {
    var end = i + 1 < starts.length ? starts[i + 1].index : html.length;
    var body = html.substring(starts[i].index, end);
    var eps = [];
    var itemRe = new RegExp('<a[^>]*class[=][ ]*[' + DQ + '][^' + DQ + ']*fz-dizi-episode-list__link[^' + DQ + ']*[' + DQ + '][^>]*href[=][' + DQ + ']([^' + DQ + ']+)[' + DQ + '][^>]*>([^]*?)</a>', 'g');
    var im;
    while ((im = itemRe.exec(body)) !== null) {
      var inner = im[2];
      var labelRe = new RegExp('class[=][ ]*[' + DQ + ']fz-dizi-episode-list__label[' + DQ + '][^>]*>([^]*?)</span>', 'i');
      var label = labelRe.exec(inner);
      var num = label ? toInt((/[0-9]+/.exec(clean(label[1])) || [])[0]) : null;
      eps.push({ number: num, url: decodeEntities(im[1]) });
    }
    seasons.push({ season: starts[i].number, episodes: eps });
  }
  return seasons;
}

// ==========================================================================================
// 8) Vixolity embed cozumleme -> HLS manifest
// ==========================================================================================

function resolveEmbed(embedUrl) {
  return getPage(embedUrl, { referer: BASE_URL + '/' }).then(function (html) {
    var decoded = decodeVixolityPayload(html);
    var info = {
      embedUrl: embedUrl,
      videoId: null,
      manifest: null,
      variants: [],
      subtitles: [],
      isMaster: false,
      error: null,
    };
    if (decoded && decoded.ayar) {
      info.videoId = decoded.ayar.videoId || null;
      info.manifest = decoded.ayar.kaynak || null;
    }
    if (!info.manifest) {
      // yedek: sayfada gecen vixolity /vs/ adresi
      var directRe = new RegExp('https?://[a-z0-9.-]*vixolity[.]com[/]vs/[a-z0-9/_-]+', 'i');
      var direct = directRe.exec(html);
      if (direct) info.manifest = direct[0];
    }
    if (!info.manifest) {
      info.error = 'Manifest bulunamadi (payload cozulemedi)';
      return info;
    }
    // Manifest gercek UA ister (curl UA => 403)
    return siteGet(info.manifest, {
      referer: embedUrl,
      accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*',
    }).then(function (mres) {
      if (mres.status === 200) {
        var pl = parseMasterPlaylist(info.manifest, mres.body);
        info.variants = pl.variants;
        info.subtitles = pl.subtitles;
        info.isMaster = pl.isMaster;
      } else {
        info.error = 'Manifest HTTP ' + mres.status;
      }
      return info;
    });
  }).catch(function (err) {
    return { embedUrl: embedUrl, videoId: null, manifest: null, variants: [], subtitles: [], isMaster: false, error: err && err.message ? err.message : String(err) };
  });
}

// ==========================================================================================
// 9) Nuvio cikti + getStreams ana girisi
// ==========================================================================================

function makeStream(nameSuffix, url, quality, referer, subtitles, title) {
  return {
    name: '⌜ FilmIzyon ⌟ | ' + nameSuffix,
    title: title || '',
    url: url,
    quality: quality || 'auto',
    size: 'Unknown',
    headers: {
      'User-Agent': USER_AGENT,
      'Referer': referer || BASE_URL + '/',
    },
    subtitles: subtitles || [],
  };
}

/** Tek bir vixolity part'i icin cozum gorevi uretir (dongu closure hatasini onler). */
function embedTask(part) {
  return resolveEmbed(part.embedUrl).then(function (info) {
    return { info: info, number: part.number, labelText: part.label };
  });
}

/** Sayfadaki part'lari akislara cevirir (vixolity HLS + diger saglayici embed'leri). */
function pageToStreams(html, pageUrl, mediaTitle, logPrefix) {
  var parts = parseParts(html);
  var avail = detectAvailability(html);
  if (!avail.playable) {
    console.log(logPrefix + ' icerik oynatilamaz (' + avail.status + '): ' + (avail.notice || ''));
    return Promise.resolve([]);
  }
  if (!parts.length) {
    console.log(logPrefix + ' part bulunamadi');
    return Promise.resolve([]);
  }

  var tasks = [];
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (p.isTrailer || p.provider === 'youtube' || !p.embedUrl) continue;

    if (p.provider === 'vixolity') {
      tasks.push(embedTask(p));
    } else if (p.provider) {
      // diger saglayicilar (vidmoly vb.): embed olarak sunulur
      tasks.push(Promise.resolve({
        info: null,
        embed: p.embedUrl,
        number: p.number,
        labelText: p.label,
        provider: p.provider,
      }));
    }
  }

  return Promise.all(tasks).then(function (results) {
    var streams = [];
    for (var r = 0; r < results.length; r++) {
      var res = results[r];
      var suffix = res.labelText ? ('Part ' + res.number + ': ' + res.labelText) : ('Part ' + res.number);
      if (res.embed) {
        streams.push(makeStream(suffix + ' | embed (' + res.provider + ')', res.embed, 'embed', BASE_URL + '/', [], mediaTitle));
        continue;
      }
      if (!res.info) continue;
      var info = res.info;
      if (!info.manifest) {
        console.log(logPrefix + ' part ' + res.number + ' cozulemedi: ' + (info.error || 'bilinmeyen'));
        continue;
      }
      var quality = 'auto';
      var topVariant = (info.variants && info.variants.length) ? info.variants[0] : null;
      if (topVariant && topVariant.height) quality = topVariant.height + 'p';
      else if (info.isMaster) quality = 'auto';
      else quality = 'HLS';
      var subs = [];
      for (var s = 0; s < (info.subtitles || []).length; s++) {
        var st = info.subtitles[s];
        if (st.url) subs.push({ url: st.url, lang: st.lang || 'tr', label: st.label || 'Altyazi' });
      }
      streams.push(makeStream(suffix + ' | HLS | ' + quality, info.manifest, quality, info.embedUrl, subs, mediaTitle));
    }
    return streams;
  });
}

function getMovieStreams(movieUrl, mediaTitle, logPrefix) {
  return getPage(movieUrl, { referer: BASE_URL + '/' }).then(function (html) {
    return pageToStreams(html, movieUrl, mediaTitle, logPrefix);
  });
}

function getEpisodeStreams(epUrl, mediaTitle, logPrefix) {
  return getPage(epUrl, { referer: BASE_URL + '/' }).then(function (html) {
    return pageToStreams(html, epUrl, mediaTitle, logPrefix);
  });
}

/**
 * getStreams ana girisi.
 * 1) TMDB/IMDB -> FilmIzyon eslesmesi (arama; poster tt id + ad + yil)
 * 2) film: /film/<slug>/ | dizi: /dizi/<slug>/sezon-<s>/bolum-<e>/
 * 3) part iframe -> vixolity decode -> HLS master
 */
function getStreams(id, mediaType, season, episode) {
  var rid = Math.floor(Math.random() * 900000 + 100000);
  var logPrefix = '[FilmIzyon][rid:' + rid + ']';
  console.log(logPrefix + ' getStreams start { id: ' + id + ', S: ' + season + ', E: ' + episode + ' }');

  return resolveFilmizyonItem(id, mediaType || 'tv').then(function (item) {
    console.log(logPrefix + ' eslesme { title: ' + item.title + ', yil: ' + item.year + ', url: ' + item.url + ' }');
    var wantType = (mediaType === 'movie') || (item.typeLabel === 'Film') || item.url.indexOf('/film/') !== -1 ? 'movie' : 'tv';
    var mediaTitle = item.title || '';

    if (wantType === 'movie') {
      return getMovieStreams(item.url, mediaTitle, logPrefix);
    }

    // Dizi: bolum URL'sini kur; bulunamazsa sezon panellerinden turet
    var s = toInt(season) || 1;
    var e = toInt(episode) || 1;
    var base = String(item.url).replace(/[/]+$/, '');
    var epUrl = base + '/sezon-' + s + '/bolum-' + e + '/';
    return getEpisodeStreams(epUrl, mediaTitle + ' ' + s + 'x' + (e < 10 ? '0' + e : e), logPrefix).then(function (streams) {
      if (streams.length) return streams;
      // yedek: dizi sayfasindan bolum linkini bul
      return getPage(base + '/', { referer: BASE_URL + '/' }).then(function (seriesHtml) {
        var seasons = parseSeasonPanels(seriesHtml);
        var target = null;
        for (var i = 0; i < seasons.length; i++) {
          if (seasons[i].season !== s) continue;
          for (var j = 0; j < seasons[i].episodes.length; j++) {
            if (seasons[i].episodes[j].number === e) { target = seasons[i].episodes[j].url; break; }
          }
          if (target) break;
        }
        if (!target) return [];
        console.log(logPrefix + ' yedek bolum URL kullaniliyor: ' + target);
        return getEpisodeStreams(target, mediaTitle, logPrefix);
      }).catch(function () {
        return [];
      });
    });
  }).then(function (streams) {
    console.log(logPrefix + ' tamamlandi: ' + streams.length + ' akis');
    return streams;
  }).catch(function (err) {
    console.log(logPrefix + ' HATA: ' + (err && err.message ? err.message : err));
    return [];
  });
}

// Nuvio yerel scraper sozlesmesi
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams: getStreams };
}
