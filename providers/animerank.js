// ==========================================================================================
// AnimeRank Scraper for Nuvio Local Scrapers
// ------------------------------------------------------------------------------------------
// Kaynak: AnimeRankScraper.kt (tek dosya Kotlin scraper) birebir JavaScript'e cevirilmistir.
//
// Site : https://animerank.tv  (MAL id tabanli Turkce anime sitesi)
//
// API HARITASI (herkese acik)
//   GET /api/anime/list?limit=&page=&q=&sort=&genre=&type=&yearFrom= ... katalog/arama
//   GET /api/anime/{malId} ............................................ anime kunyesi
//   GET /api/anime/{malId}/episodes?limit= ............................ bolum listesi
//   GET /api/config/player ............................................ oynatici yapisi (hls acik mi)
//   GET /api/izle/erisim .............................................. uyelik erisim durumu
//   GET /watch/{malId}-{slug}/{ep} .................................... izleme sayfasi (JSON-LD)
//   GET https://media.animerank.tv/{malId}/ep{ep}.onizleme.mp4 ........ herkese acik onizleme klibi
//
// KORUMALI UCLAR (premium uyelik ister; oturum cerezi varsa Nuvio headers ile gecer)
//   GET /api/stream/info/{malId}/{ep} ................................. gercek yayin kaynagi
//   GET /hls/{malId}/ep{ep}/master.m3u8 ............................... HLS master (hls=true gerekir)
//
// AKIS STRATEJISI (Kotlin PlayerAnalysis adaylariyla ayni oncelik):
//   1) izleme sayfasinda gecen dogrudan m3u8/mp4 adresleri
//   2) /api/config/player hls=true ise HLS master + varyantlari
//   3) /api/stream/info 200 donerse (oturum acik) gercek akis
//   4) herkese acik onizleme MP4 + izleme sayfasi embed'i (uyelik yoksa)
//
// NOT: Tum regex desenleri new RegExp('...') string biciminde kurulur; nokta [.] ve rakam
// [0-9] biciminde yazilir. Boylece kaynak dosya icerisinde backslash karakteri yoktur.
//
// Nuvio sozlesmesi: module.exports = { getStreams }
//   getStreams(id, mediaType, season, episode) -> Promise<[{name,title,url,quality,size,headers,subtitles}]>
//   id: TMDB id (sayi) veya IMDB id ("tt1234567") | mediaType: "movie" | "tv"
//
// HAYATA GERCEK ORTAMDA CALISMAZ ISE (Hermes): async/await YOK — tamami Promise zinciri,
// ES5 tarzi sintaksdir. Duzenleme yaparken async/await kullanmayin.
// ==========================================================================================
'use strict';

var BASE_URL = 'https://animerank.tv';
var MEDIA_BASE = 'https://media.animerank.tv';

var USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

var TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
var TMDB_BASE_URL = 'https://api.themoviedb.org/3';
var CINEMETA_URL = 'https://v3-cinemeta.strem.io/meta/';

var BASE_HEADERS = {
  'User-Agent': USER_AGENT,
  'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
  'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
};

// Yardimci karakter sabitleri (kacis kullanimini onlemek icin)
var DQ = String.fromCharCode(34);  // cift tirnak
var APOS = String.fromCharCode(39); // tek tirnak
var NL = String.fromCharCode(10);  // satir sonu

// ==========================================================================================
// 0) JSON-LD cikarma ve HTML yardimcilari
// ==========================================================================================

function decodeEntities(s) {
  var out = String(s || '');
  var pairs = [
    ['&nbsp;', ' '], ['&amp;', '&'], ['&lt;', '<'], ['&gt;', '>'],
    ['&quot;', DQ], ['&#39;', APOS], ['&#039;', APOS], ['&hellip;', '...'],
    ['&ccedil;', 'c'], ['&uuml;', 'u'], ['&ouml;', 'o'],
  ];
  for (var i = 0; i < pairs.length; i++) {
    while (out.indexOf(pairs[i][0]) !== -1) out = out.split(pairs[i][0]).join(pairs[i][1]);
  }
  // &#123; ve &#x1A; bicimindeki sayisal referanslar
  var dec = new RegExp('&#([0-9]+);', 'g');
  out = out.replace(dec, function (m, d) { return String.fromCharCode(parseInt(d, 10)); });
  var hex = new RegExp('&#x([0-9A-Fa-f]+);', 'g');
  out = out.replace(hex, function (m, h) { return String.fromCharCode(parseInt(h, 16)); });
  return out;
}

function stripTags(html) {
  var t = String(html || '');
  var scriptRe = new RegExp('<script[^]*?</script>', 'gi');
  t = t.replace(scriptRe, ' ');
  var styleRe = new RegExp('<style[^]*?</style>', 'gi');
  t = t.replace(styleRe, ' ');
  var tagRe = new RegExp('<[^>]+>', 'g');
  t = t.replace(tagRe, ' ');
  return decodeEntities(t.replace(new RegExp('[ ' + NL + ']+', 'g'), ' ')).trim();
}

/** Sayfadaki tum JSON-LD bloklarini ayristirir (Kotlin Html.jsonLdBlocks). */
function jsonLdBlocks(html) {
  var out = [];
  var re = new RegExp('<script[^>]*type[=][ ]*[' + DQ + APOS + ']application/ld[+]json[' + DQ + APOS + '][^>]*>([^]*?)</script[ ]*>', 'gi');
  var m;
  while ((m = re.exec(html)) !== null) {
    try {
      var parsed = JSON.parse(m[1]);
      if (parsed && typeof parsed === 'object') out.push(parsed);
    } catch (e) { /* bozuk blok atlanir */ }
  }
  return out;
}

/** @graph icinde de arayarak belirtilen @type'li JSON-LD nesnesini bulur. */
function jsonLdByType(html, typeName) {
  var blocks = jsonLdBlocks(html);
  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i];
    if (b['@type']) {
      var t = b['@type'];
      if (t === typeName) return b;
      if (typeof t.join === 'function' && t.join(',').indexOf(typeName) !== -1) return b;
    }
    if (b['@graph'] && typeof b['@graph'].length === 'number') {
      for (var j = 0; j < b['@graph'].length; j++) {
        var g = b['@graph'][j];
        if (g && g['@type'] === typeName) return g;
      }
    }
  }
  return null;
}

function metaContent(html, key) {
  var re = new RegExp('<meta[^>]*(?:property|name)[=][ ]*[' + DQ + APOS + ']' + key + '[' + DQ + APOS + '][^>]*>', 'gi');
  var m = re.exec(html);
  if (!m) return null;
  var cm = m[0].match(new RegExp('content[=][ ]*[' + DQ + APOS + ']([^' + DQ + APOS + ']*)[' + DQ + APOS + ']', 'i'));
  return cm ? decodeEntities(cm[1]) : null;
}

/** Bagil adresleri mutlak hale getirir (URI.resolve davranisinin basit hali). */
function resolveUrl(base, rel) {
  if (!rel) return rel;
  if (rel.indexOf('http://') === 0 || rel.indexOf('https://') === 0) return rel;
  if (rel.indexOf('//') === 0) return 'https:' + rel;
  if (rel.indexOf('/') === 0) {
    var hm = base.match(new RegExp('^(https?://[^/]+)', 'i'));
    return (hm ? hm[1] : BASE_URL) + rel;
  }
  var cut = base.lastIndexOf('/');
  return base.substring(0, cut + 1) + rel;
}

// ==========================================================================================
// 1) Ag katmani
// ==========================================================================================

function fetchJson(url, headers, attemptNo) {
  var n = attemptNo || 0;
  var merged = {};
  var k;
  for (k in BASE_HEADERS) merged[k] = BASE_HEADERS[k];
  for (k in (headers || {})) merged[k] = headers[k];
  return fetch(url, { method: 'GET', headers: merged }).then(function (response) {
    return response.text().then(function (body) {
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        return { status: response.status, ok: false, body: body };
      }
      if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + url);
      return { status: response.status, ok: true, body: body };
    });
  }).catch(function (err) {
    if (n < 2) {
      return new Promise(function (resolve) { setTimeout(resolve, 700 * (n + 1)); })
        .then(function () { return fetchJson(url, headers, n + 1); });
    }
    throw err;
  });
}

/** JSON donmesi beklenen istek; ok=false ise null doner (hata firlatmaz). */
function apiGet(url, headers) {
  return fetchJson(url, headers).then(function (r) {
    if (!r.ok) return { status: r.status, ok: false, json: null, body: r.body };
    var j = null;
    try { j = JSON.parse(r.body); } catch (e) { j = null; }
    return { status: r.status, ok: true, json: j, body: r.body };
  });
}

function siteGet(url, referer, extraHeaders) {
  var headers = { 'Referer': referer || BASE_URL + '/' };
  var k;
  for (k in (extraHeaders || {})) headers[k] = extraHeaders[k];
  return fetchJson(url, headers).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + url);
    return r.body;
  });
}

// ==========================================================================================
// 2) TMDB / Cinemeta meta cozumleme + eslesme (animecix.js ile ayni yontem)
// ==========================================================================================

function fetchTmdbMeta(id, mediaType) {
  var type = mediaType === 'movie' ? 'movie' : 'tv';
  var url = TMDB_BASE_URL + '/' + type + '/' + id + '?api_key=' + TMDB_API_KEY + '&language=tr-TR';
  return fetchJson(url).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + url);
    var j = JSON.parse(r.body);
    var names = [j.name || j.title];
    if (j.original_name) names.push(j.original_name);
    if (j.original_title) names.push(j.original_title);
    var date = j.first_air_date || j.release_date || '';
    return { name: j.name || j.title || '', originalName: j.original_name || j.original_title || '', names: names, year: parseInt(String(date).substring(0, 4), 10) || null, type: type };
  });
}

function fetchCinemetaMeta(id, mediaType) {
  // Cinemeta formati: /meta/{type}/{imdbId}.json — tip bilinmiyorsa once secilen tip, sonra digeri denenir
  var types = mediaType === 'movie' ? ['movie', 'series'] : ['series', 'movie'];
  var idx = 0;
  function tryType() {
    if (idx >= types.length) throw new Error('Cinemeta kaydi bulunamadi: ' + id);
    var url = CINEMETA_URL + types[idx++] + '/' + id + '.json';
    return fetchJson(url).then(function (r) {
      if (!r.ok) return tryType();
      var j = JSON.parse(r.body);
      var meta = j.meta || {};
      var names = [meta.name];
      if (meta.originalName) names.push(meta.originalName);
      if (meta.aliases && typeof meta.aliases.length === 'number') {
        for (var i = 0; i < meta.aliases.length && i < 5; i++) names.push(meta.aliases[i]);
      }
      return { name: meta.name || '', originalName: meta.originalName || '', names: names, year: meta.releaseInfo ? parseInt(String(meta.releaseInfo).substring(0, 4), 10) || null : null, type: meta.type || 'tv' };
    });
  }
  return tryType();
}

function normalizeTitle(s) {
  var map = { 'ı': 'i', 'İ': 'i', 'ş': 's', 'Ş': 's', 'ğ': 'g', 'Ğ': 'g', 'ü': 'u', 'Ü': 'u', 'ö': 'o', 'Ö': 'o', 'ç': 'c', 'Ç': 'c', 'â': 'a', 'î': 'i', 'û': 'u', 'ê': 'e', 'É': 'e', 'é': 'e' };
  var out = '';
  var str = String(s || '');
  for (var i = 0; i < str.length; i++) {
    var c = map[str[i]];
    out += (typeof c !== 'undefined') ? c : str[i];
  }
  return out.toLowerCase();
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

function normalizeForCompare(s) {
  return normalizeTitle(String(s || '')).replace(/[^a-z0-9]+/g, '');
}

/** AnimeRank listesinde en iyi eslesmeyi secer (ad + yil, ±1 tolerans). */
function pickBestMatch(results, names, year) {
  var best = null;
  var bestScore = 0;
  for (var i = 0; i < (results || []).length; i++) {
    var r = results[i];
    if (!r || !r.title) continue;
    var nameScore = 0;
    for (var j = 0; j < names.length; j++) {
      if (!names[j]) continue;
      var sim = diceSimilarity(r.title, names[j]);
      var eq = normalizeForCompare(r.title) === normalizeForCompare(names[j]);
      var cand = eq ? 80 : (sim >= 80 ? sim * 0.8 : sim * 0.6);
      if (r.titleOriginal && normalizeForCompare(r.titleOriginal) === normalizeForCompare(names[j])) cand = Math.max(cand, 80);
      if (cand > nameScore) nameScore = cand;
    }
    var yearScore = 0;
    if (year && r.year) {
      if (r.year === year) yearScore = 20;
      else if (Math.abs(r.year - year) <= 1) yearScore = 10;
    }
    var score = nameScore + yearScore;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return bestScore >= 60 ? best : null;
}

/** TMDB/IMDB kimligini AnimeRank kaydina cevirir. */
function resolveAnimeRankTitle(id, mediaType) {
  var metaTask = (typeof id === 'string' && id.indexOf('tt') === 0)
    ? fetchCinemetaMeta(id, mediaType || 'tv')
    : fetchTmdbMeta(id, mediaType);

  return metaTask.then(function (meta) {
    var names = [];
    for (var i = 0; i < meta.names.length; i++) {
      if (meta.names[i]) names.push(meta.names[i]);
    }
    if (!names.length) throw new Error('Baslik adi bulunamadi (id: ' + id + ')');

    var tryIndex = 0;
    function tryNext() {
      if (tryIndex >= names.length) {
        return apiSearch(names[0]).then(function (results) {
          var fallback = pickBestMatch(results, names, meta.year);
          if (!fallback) throw new Error('AnimeRank uzerinde bulunamadi: ' + names.join(' / '));
          return fallback;
        });
      }
      var query = names[tryIndex++];
      return apiSearch(query).then(function (results) {
        var match = pickBestMatch(results, names, meta.year);
        if (match) return match;
        return tryNext();
      });
    }
    return tryNext();
  });
}

// ==========================================================================================
// 3) AnimeRank API
// ==========================================================================================

function apiUrl(path) {
  return BASE_URL + path;
}

/** /api/anime/list?q= aramasi -> items dizisi. */
function apiSearch(query) {
  var url = apiUrl('/api/anime/list?limit=20&page=1&q=' + encodeURIComponent(query));
  return apiGet(url, { 'Accept': 'application/json, text/plain, */*', 'Referer': BASE_URL + '/' }).then(function (r) {
    if (!r.ok || !r.json || !r.json.data) return [];
    var items = r.json.data.items;
    return (items && typeof items.length === 'number') ? items : [];
  });
}

/** /api/anime/{malId} kunyesi. */
function apiDetail(malId) {
  var url = apiUrl('/api/anime/' + malId);
  return apiGet(url, { 'Accept': 'application/json, text/plain, */*', 'Referer': BASE_URL + '/' }).then(function (r) {
    if (!r.ok || !r.json) return null;
    return r.json.data || null;
  });
}

/** /api/anime/{malId}/episodes -> bolum nesneleri. */
function apiEpisodes(malId) {
  var url = apiUrl('/api/anime/' + malId + '/episodes?limit=2000');
  return apiGet(url, { 'Accept': 'application/json, text/plain, */*', 'Referer': BASE_URL + '/' }).then(function (r) {
    if (!r.ok || !r.json || !r.json.data) return [];
    var items = r.json.data.items;
    return (items && typeof items.length === 'number') ? items : [];
  });
}

function playerConfig() {
  return apiGet(apiUrl('/api/config/player'), { 'Accept': 'application/json, text/plain, */*' }).then(function (r) {
    if (!r.ok || !r.json) return { hls: false };
    return r.json;
  });
}

/** /api/stream/info denemesi; oturum cerezi Nuvio headers ile gecirilebilir. */
function streamInfo(malId, episode, extraHeaders) {
  var url = apiUrl('/api/stream/info/' + malId + '/' + episode);
  return apiGet(url, Object.assign({ 'Accept': 'application/json, text/plain, */*', 'Referer': BASE_URL + '/watch/' }, extraHeaders || {})).then(function (r) {
    return { status: r.status, ok: r.ok, json: r.json };
  });
}

// ==========================================================================================
// 4) Izleme sayfasi analizi + M3U8 ayristirma (Kotlin parseM3U8 cevirisi)
// ==========================================================================================

/** Izleme sayfasindan dogrudan video adreslerini toplar. */
function collectPageReferences(html) {
  var out = [];
  var seen = {};
  var re = new RegExp('https?://[^' + DQ + APOS + '<>' + ' ' + ']+[.](?:m3u8|mp4|mpd)', 'gi');
  var m;
  while ((m = re.exec(html)) !== null) {
    var url = m[0];
    if (!seen[url]) {
      seen[url] = true;
      out.push(url);
    }
    if (out.length >= 6) break;
  }
  return out;
}

/** M3U8 metnini ayristirir (EXT-X-STREAM-INF + EXT-X-MEDIA). */
function parseM3U8(url, body) {
  var lines = String(body || '').split(NL);
  var hasHeader = false;
  var variants = [];
  var pendingAttrs = null;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace(new RegExp('[ ' + NL + ']+', 'g'), '').replace(new RegExp('[' + String.fromCharCode(13) + ']', 'g'), '');
    if (!hasHeader && line.indexOf('#EXTM3U') === 0) hasHeader = true;
    if (line.indexOf('#EXT-X-STREAM-INF:') === 0) {
      pendingAttrs = parseHlsAttrs(line.substring(line.indexOf(':') + 1));
    } else if (line.length > 0 && line.charAt(0) !== '#') {
      if (pendingAttrs) {
        var res = pendingAttrs['RESOLUTION'] || '';
        variants.push({
          url: resolveUrl(url, line),
          bandwidth: parseInt(pendingAttrs['BANDWIDTH'] || pendingAttrs['AVERAGE-BANDWIDTH'] || '', 10) || null,
          resolution: res,
          label: res ? res.replace('x', 'x') : (pendingAttrs['BANDWIDTH'] ? Math.round(parseInt(pendingAttrs['BANDWIDTH'], 10) / 1000000) + 'Mbps' : 'auto'),
        });
        pendingAttrs = null;
      }
    }
  }
  return { ok: hasHeader, master: variants.length > 0, variants: variants };
}

/** HLS nitelik satiri ayractiricisi (Kotlin parseAttrs cevirisi; regex'siz tarama). */
function parseHlsAttrs(s) {
  var out = {};
  var i = 0;
  while (i < s.length) {
    var eq = s.indexOf('=', i);
    if (eq < 0) break;
    var key = s.substring(i, eq).trim().replace(new RegExp('^,+'), '').trim();
    var quoted = (eq + 1 < s.length && s.charAt(eq + 1) === DQ);
    var start = eq + 1 + (quoted ? 1 : 0);
    var end;
    if (quoted) {
      var e = s.indexOf(DQ, start);
      end = (e < 0) ? s.length : e;
    } else {
      var c = s.indexOf(',', start);
      end = (c < 0) ? s.length : c;
    }
    out[key] = s.substring(start, end).trim();
    i = end + 1;
  }
  return out;
}

// ==========================================================================================
// 5) Nuvio cikti formati + getStreams ana girisi
// ==========================================================================================

function streamHeaders(referer) {
  return {
    'User-Agent': USER_AGENT,
    'Referer': referer || BASE_URL + '/',
    'Origin': BASE_URL,
  };
}

function makeStream(nameSuffix, url, quality, headers, subtitles, title) {
  return {
    name: '⌜ AnimeRank ⌟ | ' + nameSuffix,
    title: title || '',
    url: url,
    quality: quality || 'auto',
    size: 'Unknown',
    headers: headers,
    subtitles: subtitles || [],
  };
}

/** JSON-LD / API altyazi bilgilerini Nuvio bicimine cevirir. */
function formatSubtitles(subs) {
  var out = [];
  if (!subs || typeof subs.length === 'undefined') return out;
  for (var i = 0; i < subs.length; i++) {
    var s = subs[i];
    if (!s) continue;
    if (typeof s === 'string') {
      out.push({ url: s, lang: 'tr', label: 'Turkce' });
    } else if (s.url || s.src || s.file) {
      out.push({ url: s.url || s.src || s.file, lang: s.lang || s.language || 'tr', label: s.label || s.language || 'Turkce' });
    }
  }
  return out;
}

/**
 * getStreams ana girisi.
 * 1) TMDB/IMDB -> AnimeRank eslesmesi (malId)
 * 2) izleme sayfasi analizi: JSON-LD, dogrudan adresler, HLS, stream/info, onizleme
 */
function getStreams(id, mediaType, season, episode) {
  var rid = Math.floor(Math.random() * 900000 + 100000);
  console.log('[AnimeRank][rid:' + rid + '] getStreams start { id: ' + id + ', S: ' + season + ', E: ' + episode + ' }');

  return resolveAnimeRankTitle(id, mediaType || 'tv').then(function (match) {
    var malId = match.malId;
    var slug = match.slug || String(malId);
    var epNum = parseInt(String(episode || 1), 10) || 1;
    console.log('[AnimeRank][rid:' + rid + '] eslesme { malId: ' + malId + ', title: ' + match.title + ', yil: ' + match.year + ' }');

    var watchUrl = BASE_URL + '/watch/' + slug + '/' + epNum;
    var detailTask = apiDetail(malId);
    var episodesTask = apiEpisodes(malId);
    var configTask = playerConfig();
    var watchTask = siteGet(watchUrl, BASE_URL + '/anime/' + slug).catch(function () { return ''; });

    return Promise.all([detailTask, episodesTask, configTask, watchTask]).then(function (arr) {
      var detail = arr[0];
      var episodes = arr[1];
      var config = arr[2] || {};
      var html = arr[3] || '';

      // Bolum dogrulama: sitede bu bolum var mi?
      var epFound = null;
      for (var ei = 0; ei < episodes.length; ei++) {
        var e = episodes[ei];
        if (e && (e.episodeNumber === epNum || e.number === epNum)) { epFound = e; break; }
      }
      if (!epFound && episodes.length) {
        // sezon/numara eslesmesi yoksa: episodeNumber alani iceren ilk kaydi kullan
        for (var ej = 0; ej < episodes.length; ej++) {
          if (episodes[ej] && parseInt(String(episodes[ej].episodeNumber), 10) === epNum) { epFound = episodes[ej]; break; }
        }
      }

      // JSON-LD bolum bilgisi
      var ldEp = html ? (jsonLdByType(html, 'TVEpisode') || jsonLdByType(html, 'VideoObject')) : null;
      var animeTitle = (detail && detail.title && detail.title.romaji) || match.title || '';
      var epTitle = (epFound && (epFound.titleTr || epFound.title)) || (ldEp && ldEp.name) || '';
      var mediaTitle = animeTitle + (epTitle ? ' ' + epNum + '. Bolum ' + epTitle : ' ' + epNum + '. Bolum');

      var streams = [];
      var subtitles = [];

      // Altyazilar: bolum kaydindan (dil bilgisi) — URL alanlari API'de gelmiyorsa bos kalir
      if (epFound && epFound.subtitles && typeof epFound.subtitles.length === 'number') {
        subtitles = formatSubtitles(epFound.subtitles);
      }
      if (!subtitles.length && ldEp && ldEp.subtitleLanguage) {
        // JSON-LD yalniz dil listesi verir; Nuvio icin bilgi amaclı kayit
        subtitles = [];
      }

      // Sayfa basliklarini hazirla
      var pageRefs = html ? collectPageReferences(html) : [];
      var sh = streamHeaders(BASE_URL + '/watch/' + slug + '/' + epNum);

      // 1) Sayfada gecen dogrudan adresler
      for (var pi = 0; pi < pageRefs.length; pi++) {
        var refUrl = pageRefs[pi];
        var isHls = refUrl.indexOf('.m3u8') !== -1;
        streams.push(makeStream('Sayfa kaynagi #' + (pi + 1) + (isHls ? ' | HLS' : ' | MP4'), refUrl, isHls ? 'auto' : guessQualityFromUrl(refUrl), sh, subtitles, mediaTitle));
      }

      // 2) HLS master (config hls=true ise)
      if (config && config.hls === true) {
        streams.push(makeStream('HLS sunucu', BASE_URL + '/hls/' + malId + '/ep' + epNum + '/master.m3u8', 'auto', sh, subtitles, mediaTitle));
      }

      // 3) stream/info (oturum cerezi varsa gercek akis doner)
      return streamInfo(malId, epNum).then(function (si) {
        if (si.ok && si.json) {
          var d = si.json.data || si.json;
          var found = [];
          // yaygin alan adlarini tara
          var candUrls = [];
          if (typeof d.url === 'string' && d.url.indexOf('http') === 0) candUrls.push(d.url);
          if (typeof d.streamUrl === 'string' && d.streamUrl.indexOf('http') === 0) candUrls.push(d.streamUrl);
          if (d.sources && typeof d.sources.length === 'number') {
            for (var qi = 0; qi < d.sources.length; qi++) {
              var src = d.sources[qi];
              if (src && (src.url || src.file || src.src) && String(src.url || src.file || src.src).indexOf('http') === 0) {
                candUrls.push({ url: src.url || src.file || src.src, label: src.label || src.quality || src.name || 'auto' });
              }
            }
          }
          for (var wi = 0; wi < candUrls.length; wi++) {
            var cu = candUrls[wi];
            if (typeof cu === 'string') {
              found.push(makeStream('Premium akis #' + (wi + 1), cu, guessQualityFromUrl(cu), sh, subtitles, mediaTitle));
            } else {
              found.push(makeStream('Premium akis | ' + cu.label, cu.url, guessQualityFromUrl(cu.url), sh, subtitles, mediaTitle));
            }
          }
          // altyazi listesi
          if (d.subtitles && typeof d.subtitles.length === 'number' && !subtitles.length) {
            subtitles = formatSubtitles(d.subtitles);
          }
          for (var fi = 0; fi < found.length; fi++) streams.push(found[fi]);
        }

        // 4) Herkese acik onizleme MP4 (uyelik gerektirmez) — gercek akis bulunamadiysa sun
        if (!streams.length || si.status === 401) {
          var previewUrl = MEDIA_BASE + '/' + malId + '/ep' + epNum + '.onizleme.mp4';
          streams.push(makeStream('Onizleme (kisa klip) | 720p', previewUrl, '720p', sh, [], mediaTitle));
          // Izleme sayfasini embed olarak da sun; uyelikli kullanici tarayicidan izleyebilir
          streams.push({
            name: '⌜ AnimeRank ⌟ | Izleme sayfasi (embed) | premium gerekli',
            title: mediaTitle,
            url: watchUrl,
            quality: 'embed',
            size: 'Unknown',
            headers: sh,
            subtitles: [],
          });
        }

        console.log('[AnimeRank][rid:' + rid + '] tamamlandi: ' + streams.length + ' akis (stream/info HTTP ' + si.status + ')');
        return streams;
      });
    });
  }).catch(function (err) {
    console.log('[AnimeRank][rid:' + rid + '] HATA: ' + (err && err.message ? err.message : err));
    return [];
  });
}

/** URL'den kalite tahmini (Kotlin guessQuality benzeri). */
function guessQualityFromUrl(url) {
  var u = String(url || '');
  var m = u.match(new RegExp('(1080|720|480|360|2160|1440)[pP]?', 'i'));
  if (m) {
    var n = parseInt(m[1], 10);
    if (n >= 2160) return '4K';
    if (n >= 1440) return '1440p';
    return n + 'p';
  }
  if (u.indexOf('.m3u8') !== -1) return 'auto';
  return 'auto';
}

// Nuvio yerel scraper sözleşmesi
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams: getStreams };
}
