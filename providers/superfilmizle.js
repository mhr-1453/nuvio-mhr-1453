// ==========================================================================================
// SuperFilmIzle Scraper for Nuvio Local Scrapers
// ------------------------------------------------------------------------------------------
// Kaynak: SuperFilmizleScraper-1.kt (tek dosya Kotlin scraper) birebir JavaScript'e cevirilmistir.
//
// Site : https://superfilmizle2.icu  (film / dizi / anime, Turkce)
//
// AKIS HARITASI
//   GET /ara?q=<query> ..................... arama (Turkce karakter ASCII katlama fallback'i)
//   GET /<dizi-slug>/[?sezon=N] ............ dizi sayfasi + bolum listesi
//   GET <izleme-url> | <izleme-url>/izle/ .. oynatici sayfasi (film icin /izle/ eklenir)
//   GET <player-host>/assets/js/s.php?s=<slug> .. pilavyer oynaticisi (data-pv veya embed slug)
//   Player JSON: window.__PLAYER__ = { stream: m3u8, subs: [{src,lang,label}], title, poster, dur }
//
// OYNATICI KAYNAGI ORIGIN KILIDI: player m3u8 istekleri "Referer/Origin: <site origin>"
// ile yapilmalidir (tarayici iframe'i site icinde gomdugu icin boyle gelir).
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

var BASE_URL = 'https://superfilmizle2.icu';
var SITE_ORIGIN = BASE_URL;

var USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

var TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
var TMDB_BASE_URL = 'https://api.themoviedb.org/3';
var CINEMETA_URL = 'https://v3-cinemeta.strem.io/meta/';

var BASE_HEADERS = {
  'User-Agent': USER_AGENT,
  'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
  'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
};

// Kacisiz regex kurulumu icin yardimcilar
var WS_CHARS = String.fromCharCode(9, 10, 11, 12, 13, 32, 160); // bosluk karakterleri
var APOS = String.fromCharCode(39); // tek tirnak
var WS_CLASS = '[' + WS_CHARS + ']';
var WS_RE = new RegExp(WS_CLASS);
var WS_PLUS_G = new RegExp(WS_CLASS + '+', 'g');

/** Site icin GET; Kotlin Fetcher.get ile ayni basliklar, 3 deneme + geri cekilme. */
function siteGet(url, referer) {
  var headers = {};
  for (var k in BASE_HEADERS) headers[k] = BASE_HEADERS[k];
  if (referer) {
    headers['Referer'] = referer;
    var ref = referer;
    if (ref.slice(-1) === '/') ref = ref.slice(0, -1);
    headers['Origin'] = ref;
  }
  function tryOnce(attempt) {
    return fetch(url, { method: 'GET', headers: headers }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + url);
      return response.text();
    }).then(function (body) {
      if (!body) throw new Error('Bos yanit: ' + url);
      return body;
    });
  }
  function attempt(attemptNo) {
    return tryOnce(attemptNo).catch(function (err) {
      if (attemptNo + 1 < 3) {
        return new Promise(function (resolve) {
          setTimeout(resolve, 400 * (attemptNo + 1));
        }).then(function () { return attempt(attemptNo + 1); });
      }
      throw err;
    });
  }
  return attempt(0);
}

/** Harici host GET (TMDB / Cinemeta). */
function externalGet(url, attempts) {
  var n = attempts || 3;
  function tryOnce(attempt) {
    return fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + url);
      return response.text();
    });
  }
  function attempt(attemptNo) {
    return tryOnce(attemptNo).catch(function (err) {
      if (attemptNo + 1 < n) {
        return new Promise(function (resolve) {
          setTimeout(resolve, 800 * (attemptNo + 1));
        }).then(function () { return attempt(attemptNo + 1); });
      }
      throw err;
    });
  }
  return attempt(0);
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(new RegExp('&#([0-9]+);', 'g'), function (m, d) {
      return String.fromCharCode(parseInt(d, 10));
    })
    .replace(/&hellip;/g, '…');
}

// ==========================================================================================
// 1) Arama ve kart ayristirma
// ==========================================================================================

/** Turkce karakterleri ASCII'ye katlar (site Turkce aramada hata veriyor). */
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

function searchUrl(q) {
  return BASE_URL + '/ara?q=' + encodeURIComponent(q);
}

/** Kart ayristirma: <a href="..." class="group block"> ... <h3>baslik</h3> ... */
function parseCards(html) {
  var out = [];
  var seen = {};
  var cardRe = new RegExp('<a href="(https?://[^"]+)" class="group block">([^]*?)</a>', 'g');
  var m;
  while ((m = cardRe.exec(html)) !== null) {
    var url = m[1];
    if (url.indexOf(BASE_URL) !== 0) continue;
    if (seen[url]) continue;
    seen[url] = true;
    var block = m[2];
    var titleMatch = block.match(new RegExp('<h3[^>]*>([^<]+)</h3>'));
    if (!titleMatch) continue;
    var posterMatch = block.match(new RegExp('<img src="([^"]+)"'));
    var yearMatch = block.match(new RegExp('text-xs text-content-muted">([^<]+)<'));
    var ratingMatch = block.match(new RegExp('badge badge-rating">[^]*?</svg>' + WS_CLASS + '*([0-9]+([.][0-9]+)?)'));
    var badgeMatch = block.match(new RegExp('badge badge-([a-zA-Z]+)"'));
    out.push({
      title: decodeEntities(titleMatch[1].trim()),
      url: url,
      poster: posterMatch ? posterMatch[1] : '',
      year: yearMatch ? yearMatch[1].trim() : '',
      rating: ratingMatch ? ratingMatch[1] : '',
      type: badgeMatch ? badgeMatch[1].toLowerCase() : '',
    });
  }
  // Canli kanallar farkli kart yapisi kullanir
  var liveRe = new RegExp('<a href="(https?://[^"]*canli-diziler/[^"]+)"[^>]*title="([^"]+)"', 'g');
  while ((m = liveRe.exec(html)) !== null) {
    if (seen[m[1]]) continue;
    seen[m[1]] = true;
    var tail = html.substring(m.index, Math.min(html.length, m.index + 900));
    var p = tail.match(new RegExp('<img src="([^"]+)"'));
    out.push({ title: decodeEntities(m[2]), url: m[1], poster: p ? p[1] : '', year: '', rating: '', type: 'canli' });
  }
  return out;
}

/**
 * Arama: once dogrudan, sonra ASCII katlanmis, sonra slug bicimi ("kirmizi hat" -> "kirmizi-hat").
 * Donus: Promise<cards[]> (hangi denemenin dondurdugune bakilmeksizin en iyi sonuc).
 */
function searchSite(query) {
  return siteGet(searchUrl(query)).then(function (html) {
    var direct = parseCards(html);
    if (direct.length) return direct;
    return '';
  }).catch(function () { return ''; }).then(function (firstHtmlOrEmpty) {
    if (typeof firstHtmlOrEmpty === 'object') return firstHtmlOrEmpty;
    // ilk istek basarisiz/ bos olduysa bile katlanmis aramalari dene
    return tryFolded();
    function tryFolded() {
      var folded = asciiFold(query);
      if (!folded || folded === query) return trySlug('');
      return siteGet(searchUrl(folded)).then(function (html) {
        var cards = parseCards(html);
        if (cards.length) return cards;
        return trySlug(folded);
      }).catch(function () { return trySlug(folded); });
    }
    function trySlug(prev) {
      var slug = asciiFold(query).trim().replace(WS_PLUS_G, '-');
      if (!slug || slug === prev || slug === query) return [];
      return siteGet(searchUrl(slug)).then(function (html) {
        return parseCards(html);
      }).catch(function () { return []; });
    }
  });
}

// ==========================================================================================
// 2) Baslik esleme yardimcilari (TMDB/Cinemeta -> Superfilmizle)
// ==========================================================================================

function normalizeTitle(s) {
  if (!s) return '';
  return String(s)
    .toLowerCase()
    .replace(/ı/g, 'i').replace(/İ/g, 'i')
    .replace(/ş/g, 's').replace(/Ş/g, 's')
    .replace(/ğ/g, 'g').replace(/Ğ/g, 'g')
    .replace(/ü/g, 'u').replace(/Ü/g, 'u')
    .replace(/ö/g, 'o').replace(/Ö/g, 'o')
    .replace(/ç/g, 'c').replace(/Ç/g, 'c')
    .replace(/[^a-z0-9]/g, '');
}

function yearOf(dateStr) {
  if (!dateStr) return null;
  var m = String(dateStr).match(new RegExp('([0-9]{4})'));
  return m ? parseInt(m[1], 10) : null;
}

function fetchTmdbMeta(id, mediaType) {
  var kind = mediaType === 'movie' ? 'movie' : 'tv';
  var url = TMDB_BASE_URL + '/' + kind + '/' + id + '?api_key=' + TMDB_API_KEY + '&language=tr-TR';
  return externalGet(url).then(function (body) {
    return JSON.parse(body);
  }).then(function (data) {
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
    // film olabilir
    return externalGet(CINEMETA_URL + 'movie/' + imdbId + '.json').then(function (body) {
      var meta = (JSON.parse(body).meta) || {};
      return { names: [meta.name, meta.originalName], year: yearOf(meta.released), kind: 'movie' };
    });
  });
}

/** Iki normalize edilmis ad arasindaki Dice katsayisi (bigram benzerligi, 0-1). */
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

/** Kart listesinden hedef basligi bulur (birebir > icerme > benzerlik; yil ek puan). */
function pickBestCard(cards, names, year) {
  var best = null;
  var bestScore = -1;
  for (var i = 0; i < cards.length; i++) {
    var card = cards[i];
    var a = normalizeTitle(card.title);
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
    var yearScore = 0;
    var cardYear = parseInt(card.year, 10);
    if (!isNaN(cardYear) && year) {
      if (cardYear === year) yearScore = 20;
      else if (Math.abs(cardYear - year) <= 1) yearScore = 10;
    }
    var score = nameScore + yearScore;
    if (score > bestScore) { bestScore = score; best = card; }
  }
  return bestScore >= 70 ? best : null;
}

/** TMDB/IMDB kimligini Superfilmizle kartina cevirir. */
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

    var tryIndex = 0;
    function tryNext() {
      if (tryIndex >= names.length) {
        // hicbiri eslesmedi: ilk adla yapilan aramanin en iyi sonucunu kullanmaya calis
        return searchSite(names[0]).then(function (cards) {
          var fallback = pickBestCard(cards, names, meta.year);
          if (!fallback) throw new Error('Superfilmizle uzerinde bulunamadi: ' + names.join(' / '));
          return fallback;
        });
      }
      var query = names[tryIndex++];
      return searchSite(query).then(function (cards) {
        var match = pickBestCard(cards, names, meta.year);
        if (match) return match;
        return tryNext();
      });
    }
    return tryNext();
  });
}

// ==========================================================================================
// 3) Bolumler
// ==========================================================================================

/** /anime/<slug>/sezon-N/bolum-M/  ve  /bolum/<slug>-N-sezon-M-bolum/ */
function parseEpisodeUrl(url) {
  var m = url.match(new RegExp('/sezon-([0-9]+)/bolum-([0-9]+)'));
  if (m) return [parseInt(m[1], 10), parseInt(m[2], 10)];
  m = url.match(new RegExp('/bolum/[a-z0-9-]*?-([0-9]+)-sezon-([0-9]+)-bolum'));
  if (m) return [parseInt(m[2], 10), parseInt(m[1], 10)];
  return null;
}

/** Dizi sayfasindaki bolum linklerini toplar (Kotlin collectEpisodes). */
function collectEpisodes(html, blocks) {
  var re = new RegExp('<a href="(https?://[^"]*bolum[^"]*)"[^>]*>([^]*?)</a>', 'g');
  var m;
  while ((m = re.exec(html)) !== null) {
    var url = m[1];
    if (url.indexOf(BASE_URL) !== 0) continue;
    if (!parseEpisodeUrl(url)) continue;
    var block = m[2];
    var prev = blocks[url];
    if (!prev || (prev.indexOf('<img') === -1 && block.indexOf('<img') !== -1)) blocks[url] = block;
  }
}

/** Tum sezonlarin bolumlerini toplar; donus: Promise<[{season, number, url, title}]> */
function fetchEpisodes(seriesUrl) {
  var sep = seriesUrl.indexOf('?') !== -1 ? '&' : '?';
  return siteGet(seriesUrl).then(function (first) {
    var seasonNos = {};
    var re = new RegExp('[?&]sezon=([0-9]+)', 'g');
    var m;
    while ((m = re.exec(first)) !== null) seasonNos[m[1]] = true;
    var seasonList = [];
    for (var s in seasonNos) {
      var n = parseInt(s, 10);
      if (!isNaN(n)) seasonList.push(n);
    }
    if (!seasonList.length) seasonList.push(1);

    var blocks = {};
    collectEpisodes(first, blocks);
    var idx = 0;
    function fetchRest() {
      if (idx >= seasonList.length) return Promise.resolve(null);
      var sn = seasonList[idx++];
      if (sn === 1) return fetchRest();
      return siteGet(seriesUrl + sep + 'sezon=' + sn).then(function (html) {
        collectEpisodes(html, blocks);
        return fetchRest();
      }).catch(function () { return fetchRest(); });
    }
    return fetchRest().then(function () {
      var eps = [];
      for (var url in blocks) {
        var se = parseEpisodeUrl(url);
        if (!se) continue;
        var block = blocks[url];
        var t = block.match(new RegExp('<h3[^>]*>([^<]+)</h3>')) ||
          block.match(new RegExp('<p[^>]*class="[^"]*font-semibold[^"]*"[^>]*>([^<]+)</p>')) ||
          block.match(new RegExp('<img[^>]*alt="([^"]+)"'));
        eps.push({
          season: se[0],
          number: se[1],
          url: url,
          title: t ? decodeEntities(t[1].trim()) : '',
        });
      }
      eps.sort(function (a, b) {
        return (a.season - b.season) || (a.number - b.number);
      });
      return eps;
    });
  });
}

// ==========================================================================================
// 4) Oynatici kaynaklari
// ==========================================================================================

/** window.__PLAYER__ = { ... } JSON'ini HTML'den ayiklar (string derinligi dengeli). */
function extractPlayerJson(html) {
  var idx = html.indexOf('window.__PLAYER__');
  if (idx < 0) return null;
  var i = html.indexOf('=', idx);
  if (i < 0) return null;
  i++;
  while (i < html.length && WS_RE.test(html[i])) i++;
  if (i >= html.length || html[i] !== '{') return null;
  var depth = 0, inStr = false, esc = false;
  var start = i;
  while (i < html.length) {
    var c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === String.fromCharCode(92)) esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    i++;
  }
  try {
    var parsed = JSON.parse(html.substring(start, i));
    var out = {};
    for (var k in parsed) out[k] = parsed[k];
    var empty = true;
    for (var k2 in out) { empty = false; break; }
    return empty ? null : out;
  } catch (e) {
    return null;
  }
}

/** Izleme sayfasindaki oynatici adaylari (Kotlin playerCandidates birebir). */
function playerCandidates(html) {
  var out = [];
  var seen = {};
  var coreHosts = [];
  var coreRe = new RegExp('src="(https?://[^/?"]+)/(?:e/c|assets/js/core)[.]js', 'g');
  var m;
  while ((m = coreRe.exec(html)) !== null) coreHosts.push(m[1]);

  var pvRe = new RegExp('data-pv="([^"]+)"', 'g');
  while ((m = pvRe.exec(html)) !== null) {
    var slug = m[1];
    for (var i = 0; i < coreHosts.length; i++) {
      var u = coreHosts[i] + '/assets/js/s.php?s=' + encodeURIComponent(slug);
      if (!seen[u]) { seen[u] = true; out.push({ kind: 'pilavyer', host: coreHosts[i], pageUrl: u }); }
    }
  }

  var iframeRe = new RegExp('<iframe[^>]*src="(https?://[^"]+/embed/[^"]+)"', 'g');
  while ((m = iframeRe.exec(html)) !== null) {
    var src = m[1];
    var hostMatch = src.match(new RegExp('^(https?://[^/]+)'));
    var host = hostMatch ? hostMatch[1] : '';
    if (!seen[src]) {
      seen[src] = true;
      out.push({ kind: host.indexOf('lucifer') !== -1 ? 'lucifer' : 'embed', host: host, pageUrl: src });
    }
    var slug2 = src.split('/').pop().split('?')[0];
    var alt = host + '/assets/js/s.php?s=' + encodeURIComponent(slug2);
    if (!seen[alt]) { seen[alt] = true; out.push({ kind: 'pilavyer', host: host, pageUrl: alt }); }
  }

  var ytRe = new RegExp('<iframe[^>]*src="(https?://(?:www[.])?youtube[.]com/embed/[^"]+)"', 'g');
  while ((m = ytRe.exec(html)) !== null) {
    if (!seen[m[1]]) {
      seen[m[1]] = true;
      out.push({ kind: 'youtube', host: 'https://www.youtube.com', pageUrl: m[1] });
    }
  }
  return out;
}

/** Izleme sayfasini getirir; film sayfalarinda /izle/ ekleyerek tekrar dener. */
function fetchWatchPage(watchUrl) {
  return siteGet(watchUrl, SITE_ORIGIN + '/').then(function (html) {
    if (playerCandidates(html).length) return { finalUrl: watchUrl, html: html };
    var trimmed = watchUrl;
    if (trimmed.slice(-1) === '/') trimmed = trimmed.slice(0, -1);
    var alt = trimmed + '/izle/';
    if (alt !== watchUrl) {
      return siteGet(alt, SITE_ORIGIN + '/').then(function (html2) {
        if (playerCandidates(html2).length) return { finalUrl: alt, html: html2 };
        return { finalUrl: watchUrl, html: html };
      }).catch(function () {
        return { finalUrl: watchUrl, html: html };
      });
    }
    return { finalUrl: watchUrl, html: html };
  });
}

/** HTML icerisinde dogrudan m3u8 adresi var mi (player JSON yoksa fallback). */
var M3U8_RE = new RegExp('(https?://[^"' + APOS + WS_CHARS + ']+?[.]m3u8[^"' + APOS + WS_CHARS + ']*)');
function findDirectM3u8(html) {
  var m = html.match(M3U8_RE);
  return m ? m[1] : null;
}

/** Bagil adresleri mutlak hale getirir. */
function resolveUrl(url, baseUrl) {
  if (url.indexOf('http://') === 0 || url.indexOf('https://') === 0) return url;
  if (url.indexOf('//') === 0) return 'https:' + url;
  if (url.indexOf('/') === 0) {
    var schemeEnd = baseUrl.indexOf('://');
    var pathStart = baseUrl.indexOf('/', schemeEnd + 3);
    var origin = pathStart === -1 ? baseUrl : baseUrl.slice(0, pathStart);
    return origin + url;
  }
  return baseUrl.slice(0, baseUrl.lastIndexOf('/') + 1) + url;
}

/** Bir oynatici adayini cozer: player JSON -> { stream, subs, title } (yoksa null). */
function resolveCandidate(cand) {
  if (cand.kind === 'youtube') return Promise.resolve(null); // canli kanallar; akis yok
  return siteGet(cand.pageUrl, SITE_ORIGIN).then(function (body) {
    var json = extractPlayerJson(body);
    if (json && json.stream) {
      return { stream: json.stream, subs: json.subs || [], title: json.title || '', playerUrl: cand.pageUrl, kind: cand.kind };
    }
    var direct = findDirectM3u8(body);
    if (direct) {
      return { stream: direct, subs: [], title: '', playerUrl: cand.pageUrl, kind: cand.kind };
    }
    return null;
  }).catch(function () {
    return null;
  });
}

/** Master playlist'teki en yuksek cozunurluk etiketi (basarisizsa 'auto'). */
function masterQualityLabel(playlistUrl) {
  return siteGet(playlistUrl, SITE_ORIGIN).then(function (text) {
    var re = new RegExp('RESOLUTION=([0-9]+)x([0-9]+)', 'g');
    var best = 0, m;
    while ((m = re.exec(text)) !== null) {
      var h = parseInt(m[2], 10);
      if (!isNaN(h) && h > best) best = h;
    }
    return best ? best + 'p' : 'auto';
  }).catch(function () {
    return 'auto';
  });
}

/** Player JSON "subs" dizisini Nuvio altyazi bicimine cevirir. */
function formatSubtitles(subs, playlistUrl) {
  var out = [];
  if (!subs || typeof subs.length === 'undefined') return out;
  for (var i = 0; i < subs.length; i++) {
    var s = subs[i];
    if (!s || !s.src) continue;
    out.push({
      url: resolveUrl(s.src, playlistUrl),
      lang: s.lang || 'tr',
      label: s.label || s.lang || 'Turkce',
    });
  }
  return out;
}

// ==========================================================================================
// 5) Nuvio cikti formati + getStreams ana girisi
// ==========================================================================================

function qualityRank(label) {
  var m = String(label || '').match(new RegExp('([0-9]+)p'));
  if (m) return parseInt(m[1], 10);
  if (label === 'auto') return 100; // master: varyantlar oyuncuda secilir, one al
  return 0;
}

function formatSourceLinks(sourceName, resolved, mediaTitle) {
  var label = (sourceName || 'Kaynak');
  var headers = {
    'User-Agent': USER_AGENT,
    'Referer': SITE_ORIGIN + '/',
    'Origin': SITE_ORIGIN,
  };
  if (resolved) {
    return [{
      name: '⌜ SuperFilmIzle ⌟ | ' + label + ' | ' + (resolved.quality || 'auto'),
      title: mediaTitle || '',
      url: resolved.stream,
      quality: resolved.quality || 'auto',
      size: 'Unknown',
      headers: headers,
      subtitles: resolved.subtitles || [],
    }];
  }
  // Cozulemeyen kaynak kaybolmasin: player sayfasi embed olarak sunulur
  return [{
    name: '⌜ SuperFilmIzle ⌟ | ' + label + ' | embed',
    title: mediaTitle || '',
    url: sourceName || '',
    quality: 'embed',
    size: 'Unknown',
    headers: headers,
    subtitles: [],
  }];
}

/**
 * Bir izleme URL'inin tum oynaticilarini cozer ve Nuvio akis listesine cevirir.
 * Kotlin sources()+video() davranisi: her aday denenir; cozulene akis, cozulmeyene embed.
 */
function buildStreamsForWatchPage(watchUrl, mediaTitle) {
  return fetchWatchPage(watchUrl).then(function (page) {
    var cands = playerCandidates(page.html);
    if (!cands.length) return [];
    var tasks = cands.map(function (cand) {
      return resolveCandidate(cand).then(function (resolved) {
        return { cand: cand, resolved: resolved };
      });
    });
    return Promise.all(tasks).then(function (results) {
      var streamTasks = [];
      var embedLinks = [];
      for (var i = 0; i < results.length; i++) {
        (function (r) {
          if (r.resolved) {
            var resolvedRef = r.resolved;
            streamTasks.push(
              masterQualityLabel(resolvedRef.stream).then(function (q) {
                return { res: resolvedRef, q: q };
              })
            );
          } else if (r.cand.kind !== 'youtube') {
            embedLinks.push({ cand: r.cand });
          }
        })(results[i]);
      }
      return Promise.all(streamTasks).then(function (streamResults) {
        var links = [];
        for (var j = 0; j < streamResults.length; j++) {
          var sr = streamResults[j];
          links = links.concat(formatSourceLinks(
            sr.res.title || sr.res.kind,
            { stream: sr.res.stream, quality: sr.q, subtitles: formatSubtitles(sr.res.subs, sr.res.stream) },
            mediaTitle
          ));
        }
        for (var k = 0; k < embedLinks.length; k++) {
          links = links.concat(formatSourceLinks(embedLinks[k].cand.pageUrl, null, mediaTitle));
        }
        // URL'e gore tekillestir + kaliteye gore sirala
        var seenUrls = {};
        var unique = [];
        for (var u = 0; u < links.length; u++) {
          if (links[u].url && !seenUrls[links[u].url]) {
            seenUrls[links[u].url] = true;
            unique.push(links[u]);
          }
        }
        unique.sort(function (a, b) { return qualityRank(b.quality) - qualityRank(a.quality); });
        return unique;
      });
    });
  });
}

/**
 * NUVIO ANA GIRIS.
 * id: TMDB id (sayi/string) veya IMDB id ("tt...") | mediaType: "movie" | "tv"
 * Superfilmizle Turkce film/dizi/anime katalogu; esleme TMDB/Cinemeta uzerinden yapilir.
 */
function getStreams(id, mediaType, season, episode) {
  if (mediaType !== 'tv' && mediaType !== 'movie') return Promise.resolve([]);

  var rid = String(Math.floor(Math.random() * 900000) + 100000);
  function log(msg, extra) {
    try {
      if (typeof extra !== 'undefined') console.log('[SuperFilmIzle][rid:' + rid + '] ' + msg, extra);
      else console.log('[SuperFilmIzle][rid:' + rid + '] ' + msg);
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
      return buildStreamsForWatchPage(card.url, mediaTitleBase);
    }

    // Dizi/anime: hedef sezon+bolum sayfasini bul
    return fetchEpisodes(card.url).then(function (eps) {
      if (!eps.length) {
        log('bolum bulunamadi, kart sayfasi denenecek');
        return buildStreamsForWatchPage(card.url, mediaTitleBase);
      }
      var target = null;
      for (var i = 0; i < eps.length; i++) {
        if (eps[i].season === wantSeason && eps[i].number === wantEpisode) { target = eps[i]; break; }
      }
      if (!target) {
        // ayni bolum numarasinin ilk sezonunu dene, sonra S1E<episode>
        for (var j = 0; j < eps.length; j++) {
          if (eps[j].season === 1 && eps[j].number === wantEpisode) { target = eps[j]; break; }
        }
      }
      if (!target) {
        log('S' + wantSeason + 'E' + wantEpisode + ' bulunamadi, ilk bolum denenecek');
        target = eps[0];
      }
      log('bolum secildi S' + target.season + 'E' + target.number);
      var title = mediaTitleBase + ' S' + target.season + 'E' + target.number;
      return buildStreamsForWatchPage(target.url, title);
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
  global.SuperFilmIzleScraperModule = { getStreams: getStreams };
}
