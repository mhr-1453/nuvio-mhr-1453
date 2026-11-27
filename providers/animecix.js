// ==========================================================================================
// AnimeciX Scraper for Nuvio Local Scrapers
// ------------------------------------------------------------------------------------------
// Kaynak: AnimecixScraper-1.kt (tek dosya Kotlin scraper) birebir JavaScript'ye cevirilmistir.
//
// Site : https://animecix.tv  (Angular + Laravel; icerik API'si /secure/... ve x-e-h basligi)
//
// API HARITASI
//   GET /secure/search/{query}?page=&per_page= ........... arama
//   GET /secure/titles/{id}?titleId=&seasonNumber=&titleName=&page= ... detay/bolumler
//   GET /secure/episode-videos-points?titleId=&season=&episode= ...... bolumun TUM kaynaklari
//   GET /secure/translators ........................... cevirmen (fansub) listesi
//   GET https://tau-video.xyz/api/video/{embedId} .... dogrudan MP4 adresleri
//
// x-e-h BASLIGI (her istekte uretilir)
//   AES-256-GCM, anahtar "i4C7R2fXGocdYgFLzCbDlsJjukf8G58b",
//   acik metin = "{version}" + sorgu dizesi,
//   deger = base64(ciphertext+tag) + "." + base64(iv)
//   (Saf JS AES-GCM uygulanmistir; Hermes'te Node crypto / WebCrypto bulunmaz.)
//
// Nuvio sozlesmesi: module.exports = { getStreams }
//   getStreams(id, mediaType, season, episode) -> Promise<[{name,title,url,quality,size,headers,subtitles}]>
//   id: TMDB id (sayi) veya IMDB id ("tt1234567") | mediaType: "movie" | "tv"
//
// HAYATA GERCEK ORTAMDA CALISMAZ ISE (Hermes): async/await YOK — tamami Promise zinciri,
// ES5 sintaksidir. Duzenleme yaparken async/await kullanmayin.
// ==========================================================================================
'use strict';

var BASE_URL = 'https://animecix.tv';
var TAU_API = 'https://tau-video.xyz/api/video/';
var EH_KEY = 'i4C7R2fXGocdYgFLzCbDlsJjukf8G58b';
var EH_PREFIX = '{version}';

var USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

var TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
var TMDB_BASE_URL = 'https://api.themoviedb.org/3';
var CINEMETA_URL = 'https://v3-cinemeta.strem.io/meta/';

var BASE_HEADERS = {
  'User-Agent': USER_AGENT,
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
  'Referer': BASE_URL + '/',
  'Origin': BASE_URL,
};

// ==========================================================================================
// 1) Saf JavaScript AES-256-GCM (yalnizca sifreleme)
//    Node crypto ile byte-byte dogrulanmistir (scripts/test-aesgcm.js).
// ==========================================================================================

var SBOX_HEX =
  '637c777bf26b6fc53001672bfed7ab76' +
  'ca82c97dfa5947f0add4a2af9ca472c0' +
  'b7fd9326363ff7cc34a5e5f171d83115' +
  '04c723c31896059a071280e2eb27b275' +
  '09832c1a1b6e5aa0523bd6b329e32f84' +
  '53d100ed20fcb15b6acbbe394a4c58cf' +
  'd0efaafb434d338545f9027f503c9fa8' +
  '51a3408f929d38f5bcb6da2110fff3d2' +
  'cd0c13ec5f974417c4a77e3d645d1973' +
  '60814fdc222a908846eeb814de5e0bdb' +
  'e0323a0a4906245cc2d3ac629195e479' +
  'e7c8376d8dd54ea96c56f4ea657aae08' +
  'ba78252e1ca6b4c6e8dd741f4bbd8b8a' +
  '703eb5664803f60e613557b986c11d9e' +
  'e1f8981169d98e949b1e87e9ce5528df' +
  '8ca1890dbfe6426841992d0fb054bb16';

var SBOX = (function () {
  var t = [];
  for (var i = 0; i < 256; i++) t.push(parseInt(SBOX_HEX.substr(i * 2, 2), 16));
  return t;
})();

function strToUtf8Bytes(str) {
  var out = [];
  for (var i = 0; i < str.length; i++) {
    var code = str.charCodeAt(i);
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code < 0xdc00 && i + 1 < str.length) {
      var lo = str.charCodeAt(i + 1);
      code = 0x10000 + ((code - 0xd800) << 10) + (lo - 0xdc00);
      out.push(
        0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f)
      );
      i++;
    } else {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return out;
}

function base64Encode(bytes) {
  var ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var out = '';
  var i = 0;
  while (i < bytes.length) {
    var b0 = bytes[i] & 0xff;
    var b1 = i + 1 < bytes.length ? bytes[i + 1] & 0xff : 0;
    var b2 = i + 2 < bytes.length ? bytes[i + 2] & 0xff : 0;
    var triple = (b0 << 16) | (b1 << 8) | b2;
    out += ALPHABET[(triple >> 18) & 0x3f];
    out += ALPHABET[(triple >> 12) & 0x3f];
    out += i + 1 < bytes.length ? ALPHABET[(triple >> 6) & 0x3f] : '=';
    out += i + 2 < bytes.length ? ALPHABET[triple & 0x3f] : '=';
    i += 3;
  }
  return out;
}

function keyExpansion(key) {
  var nk = 8, nr = 14;
  var w = new Array(4 * (nr + 1));
  var rcon = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40];
  var i, t;
  for (i = 0; i < nk; i++) {
    w[i] = [key[4 * i] & 0xff, key[4 * i + 1] & 0xff, key[4 * i + 2] & 0xff, key[4 * i + 3] & 0xff];
  }
  for (i = nk; i < 4 * (nr + 1); i++) {
    t = w[i - 1].slice();
    if (i % nk === 0) {
      t = [SBOX[t[1]], SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]];
      t[0] ^= rcon[i / nk - 1];
    } else if (i % nk === 4) {
      t = [SBOX[t[0]], SBOX[t[1]], SBOX[t[2]], SBOX[t[3]]];
    }
    var nw = new Array(4);
    for (var k = 0; k < 4; k++) nw[k] = (w[i - nk][k] ^ t[k]) & 0xff;
    w[i] = nw;
  }
  return w;
}

function xorRoundKey(state, w, round) {
  // state duz yerlesim: index = 4*sutun + satir
  for (var c = 0; c < 4; c++) {
    for (var r = 0; r < 4; r++) {
      state[c * 4 + r] ^= w[round * 4 + c][r];
    }
  }
}

function subBytes(state) {
  for (var i = 0; i < 16; i++) state[i] = SBOX[state[i]];
}

function shiftRows(state) {
  var t;
  t = state[1]; state[1] = state[5]; state[5] = state[9]; state[9] = state[13]; state[13] = t;
  t = state[2]; state[2] = state[10]; state[10] = t;
  t = state[6]; state[6] = state[14]; state[14] = t;
  t = state[3]; state[3] = state[15]; state[15] = state[11]; state[11] = state[7]; state[7] = t;
}

function xtime(a) {
  return ((a << 1) ^ ((a & 0x80) ? 0x1b : 0)) & 0xff;
}

function mixColumns(state) {
  for (var c = 0; c < 4; c++) {
    var a0 = state[c * 4], a1 = state[c * 4 + 1], a2 = state[c * 4 + 2], a3 = state[c * 4 + 3];
    state[c * 4] = (xtime(a0) ^ (a1 ^ xtime(a1)) ^ a2 ^ a3) & 0xff;
    state[c * 4 + 1] = (a0 ^ xtime(a1) ^ (a2 ^ xtime(a2)) ^ a3) & 0xff;
    state[c * 4 + 2] = (a0 ^ a1 ^ xtime(a2) ^ (a3 ^ xtime(a3))) & 0xff;
    state[c * 4 + 3] = ((a0 ^ xtime(a0)) ^ a1 ^ a2 ^ xtime(a3)) & 0xff;
  }
}

function encryptBlock(block, w) {
  var state = block.slice(0, 16);
  xorRoundKey(state, w, 0);
  for (var round = 1; round <= 13; round++) {
    subBytes(state);
    shiftRows(state);
    mixColumns(state);
    xorRoundKey(state, w, round);
  }
  subBytes(state);
  shiftRows(state);
  xorRoundKey(state, w, 14);
  return state;
}

function ghashMul(x, y) {
  // GF(2^128) carpma, bayt dizileri uzerinde (NIST SP 800-38D alg. 1)
  var z = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  var v = y.slice(0, 16);
  for (var i = 0; i < 128; i++) {
    var bit = (x[i >> 3] >> (7 - (i & 7))) & 1;
    if (bit) {
      for (var k = 0; k < 16; k++) z[k] ^= v[k];
    }
    var lsb = v[15] & 1;
    for (var j = 15; j > 0; j--) {
      v[j] = ((v[j] >> 1) | (v[j - 1] << 7)) & 0xff;
    }
    v[0] = (v[0] >> 1) & 0xff;
    if (lsb) v[0] ^= 0xe1;
  }
  return z;
}

function inc32(counterBytes) {
  var c = ((counterBytes[12] << 24) | (counterBytes[13] << 16) | (counterBytes[14] << 8) | counterBytes[15]) >>> 0;
  c = (c + 1) >>> 0;
  counterBytes[12] = (c >>> 24) & 0xff;
  counterBytes[13] = (c >>> 16) & 0xff;
  counterBytes[14] = (c >>> 8) & 0xff;
  counterBytes[15] = c & 0xff;
}

/** AES-256-GCM sifreleme. Donus: ciphertext || tag (16 bayt). */
function aesGcmEncrypt(keyBytes, ivBytes, plaintext) {
  var data = strToUtf8Bytes(plaintext);
  var w = keyExpansion(keyBytes);
  var H = encryptBlock([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], w);
  var j0 = ivBytes.slice(0, 12).concat([0, 0, 0, 1]);

  var ct = [];
  var cb = j0.slice();
  var off, b;
  for (off = 0; off < data.length; off += 16) {
    inc32(cb);
    var ks = encryptBlock(cb, w);
    var chunkLen = Math.min(16, data.length - off);
    for (b = 0; b < chunkLen; b++) ct.push((data[off + b] ^ ks[b]) & 0xff);
  }

  var ghash = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (off = 0; off < ct.length; off += 16) {
    var blk = [];
    var n = Math.min(16, ct.length - off);
    for (b = 0; b < n; b++) blk.push(ct[off + b]);
    while (blk.length < 16) blk.push(0);
    var x = [];
    for (b = 0; b < 16; b++) x.push(ghash[b] ^ blk[b]);
    ghash = ghashMul(x, H);
  }
  var bitLen = ct.length * 8;
  var lenBlk = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    (bitLen >>> 24) & 0xff, (bitLen >>> 16) & 0xff, (bitLen >>> 8) & 0xff, bitLen & 0xff];
  var x2 = [];
  for (b = 0; b < 16; b++) x2.push(ghash[b] ^ lenBlk[b]);
  ghash = ghashMul(x2, H);

  var tag = encryptBlock(j0, w);
  for (b = 0; b < 16; b++) tag[b] ^= ghash[b];

  return ct.concat(tag);
}

function randomIv() {
  var iv = [];
  for (var i = 0; i < 12; i++) iv.push(Math.floor(Math.random() * 256) & 0xff);
  return iv;
}

/** AnimeciX x-e-h basligini sorgu dizesi icin uretir. */
function generateEhHeader(query) {
  var iv = randomIv();
  var keyBytes = strToUtf8Bytes(EH_KEY);
  var out = aesGcmEncrypt(keyBytes, iv, EH_PREFIX + query);
  return base64Encode(out) + '.' + base64Encode(iv);
}

// ==========================================================================================
// 2) Ag katmani (fetch + x-e-h)
// ==========================================================================================

/** Kotlin `prepare()` ile birebir ayni sorgu dizesi (encodeURIComponent). Parametre sirasi korunur. */
function buildQuery(params) {
  var parts = [];
  for (var i = 0; i < params.length; i++) {
    if (params[i][1] === null || typeof params[i][1] === 'undefined') continue;
    parts.push(encodeURIComponent(String(params[i][0])) + '=' + encodeURIComponent(String(params[i][1])));
  }
  return parts.join('&');
}

function fetchText(url, headers, options) {
  var merged = {};
  for (var k in BASE_HEADERS) merged[k] = BASE_HEADERS[k];
  for (var k2 in (headers || {})) merged[k2] = headers[k2];
  merged['x-e-h'] = generateEhHeader('');
  var opts = Object.assign({ method: 'GET', headers: merged }, options || {});
  if (opts.method === 'POST') {
    opts.headers = Object.assign({}, opts.headers, { 'Content-Type': 'application/x-www-form-urlencoded' });
  }
  return fetch(url, opts).then(function (response) {
    if (!response.ok && response.status !== 302) {
      throw new Error('HTTP ' + response.status + ': ' + url);
    }
    return response.text().then(function (body) {
      if (body.indexOf('Attention Required') !== -1) {
        throw new Error('Cloudflare engeli (403): ' + url);
      }
      if (!body) throw new Error('Bos yanit: ' + url);
      return body;
    });
  });
}

/** AnimeciX /secure JSON ucu. `path` '/secure/...'; params [ [ad, deger], ... ] sirasiyla. */
function apiGet(path, params) {
  var query = buildQuery(params || []);
  var url = query ? BASE_URL + path + '?' + query : BASE_URL + path;
  return fetch(url, {
    method: 'GET',
    headers: Object.assign({}, BASE_HEADERS, { 'x-e-h': generateEhHeader(query) }),
  }).then(function (response) {
    if (!response.ok) {
      throw new Error('HTTP ' + response.status + ': ' + url);
    }
    return response.text();
  }).then(function (body) {
    try {
      return JSON.parse(body);
    } catch (e) {
      throw new Error('JSON parse hatasi: ' + url);
    }
  });
}

/** Harici host GET (x-e-h bos sorguyla gonderilir; zararsiz). */
function externalGet(url, headers, attempts) {
  var n = attempts || 3;
  function tryOnce(attempt) {
    return fetchText(url, headers).catch(function (err) {
      if (attempt + 1 < n) {
        return new Promise(function (resolve) {
          setTimeout(resolve, 800 * (attempt + 1));
        }).then(function () { return tryOnce(attempt + 1); });
      }
      throw err;
    });
  }
  return tryOnce(0);
}

// ==========================================================================================
// 3) AnimeciX API uclari
// ==========================================================================================

function apiSearch(query, perPage) {
  var path = '/secure/search/' + encodeURIComponent(query);
  return apiGet(path, [['page', 1], ['per_page', perPage || 20]]);
}

function apiTitle(id, seasonNumber, titleName, page) {
  var params = [['titleId', id]];
  if (seasonNumber !== null && typeof seasonNumber !== 'undefined') params.push(['seasonNumber', seasonNumber]);
  if (titleName) params.push(['titleName', titleName]);
  if (page !== null && typeof page !== 'undefined') params.push(['page', page]);
  return apiGet('/secure/titles/' + id, params);
}

function apiEpisodeVideos(titleId, season, episode) {
  return apiGet('/secure/episode-videos-points', [
    ['titleId', titleId], ['season', season], ['episode', episode],
  ]);
}

var translatorCache = null;
function apiTranslators() {
  if (translatorCache) return Promise.resolve(translatorCache);
  return apiGet('/secure/translators', []).then(function (list) {
    var map = {};
    var arr = (list && Object.prototype.toString.call(list) === '[object Array]') ? list : [];
    for (var i = 0; i < arr.length; i++) {
      var t = arr[i];
      if (t && typeof t.id !== 'undefined') {
        map[t.id] = t.full_name || t.name || ('Cevirmen #' + t.id);
      }
    }
    translatorCache = map;
    return map;
  }).catch(function () {
    translatorCache = {};
    return {};
  });
}

// ==========================================================================================
// 4) Baslik esleme yardimcilari (TMDB/Cinemeta -> AnimeciX)
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

/** "One Piece: Film Gold" -> "one-piece-film-gold" (apiTitle titleName parametresi icin) */
function slugify(name) {
  var s = String(name || '')
    .replace(/ı/g, 'i').replace(/İ/g, 'i')
    .replace(/ş/g, 's').replace(/Ş/g, 's')
    .replace(/ğ/g, 'g').replace(/Ğ/g, 'g')
    .replace(/ü/g, 'u').replace(/Ü/g, 'u')
    .replace(/ö/g, 'o').replace(/Ö/g, 'o')
    .replace(/ç/g, 'c').replace(/Ç/g, 'c')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s;
}

function yearOf(dateStr) {
  if (!dateStr) return null;
  var m = String(dateStr).match(/(\d{4})/);
  return m ? parseInt(m[1], 10) : null;
}

/** TMDB meta (ad + yil) */
function fetchTmdbMeta(id, mediaType) {
  var kind = mediaType === 'movie' ? 'movie' : 'tv';
  var url = TMDB_BASE_URL + '/' + kind + '/' + id + '?api_key=' + TMDB_API_KEY + '&language=tr-TR';
  return externalGet(url).then(function (body) {
    return JSON.parse(body);
  }).then(function (data) {
    var year = yearOf(data.first_air_date || data.release_date);
    return {
      names: [data.original_name || data.original_title, data.name || data.title],
      year: year,
      kind: kind,
    };
  });
}

/** IMDB ("tt...") meta — Cinemeta uzerinden */
function fetchCinemetaMeta(imdbId) {
  var url = CINEMETA_URL + 'series/' + imdbId + '.json';
  return externalGet(url).then(function (body) {
    return JSON.parse(body);
  }).then(function (data) {
    var meta = data.meta || {};
    return {
      names: [meta.name, meta.originalName],
      year: yearOf(meta.released),
      kind: 'tv',
    };
  }).catch(function () {
    // film olabilir
    return externalGet(CINEMETA_URL + 'movie/' + imdbId + '.json').then(function (body) {
      var meta = (JSON.parse(body).meta) || {};
      return {
        names: [meta.name, meta.originalName],
        year: yearOf(meta.released),
        kind: 'movie',
      };
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
    if (map[bg2]) {
      map[bg2]--;
      hits++;
    }
  }
  return (2 * hits) / (a.length - 1 + b.length - 1);
}

/**
 * Arama sonucu listesinden hedef basligi bulur.
 * Oncelik: birebir eslesme (100) > icerme (80) > benzerlik >= 0.7 (70).
 * Yil eslesmesi ek puan verir (eslesen yil +20, ±1 yil +10).
 */
function pickBestMatch(results, names, year) {
  var best = null;
  var bestScore = -1;
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    if (!r || typeof r.id === 'undefined') continue;
    var candidates = [r.name, r.name_romanji, r.name_english, r.original_title];
    var nameScore = 0;
    for (var c = 0; c < candidates.length; c++) {
      var a = normalizeTitle(candidates[c]);
      if (!a) continue;
      for (var n = 0; n < names.length; n++) {
        var b = normalizeTitle(names[n]);
        if (!b) continue;
        if (a === b) nameScore = Math.max(nameScore, 100);
        else if (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) nameScore = Math.max(nameScore, 80);
        else if (diceSimilarity(a, b) >= 0.7) nameScore = Math.max(nameScore, 70);
      }
    }
    if (nameScore === 0) continue;
    var yearScore = 0;
    var rYear = parseInt(r.year, 10);
    if (!isNaN(rYear) && year) {
      if (rYear === year) yearScore = 20;
      else if (Math.abs(rYear - year) <= 1) yearScore = 10;
    }
    var score = nameScore + yearScore;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return bestScore >= 70 ? best : null;
}

/** TMDB/IMDB kimligini AnimeciX basligina cevirir. */
function resolveAnimecixTitle(id, mediaType) {
  var metaTask = (typeof id === 'string' && id.indexOf('tt') === 0)
    ? fetchCinemetaMeta(id)
    : fetchTmdbMeta(id, mediaType);

  return metaTask.then(function (meta) {
    var names = [];
    for (var i = 0; i < meta.names.length; i++) {
      if (meta.names[i]) names.push(meta.names[i]);
    }
    if (!names.length) throw new Error('Baslik adi bulunamadi (id: ' + id + ')');

    // Aday adlarla sirayla ara; ilk basarili eslesmede don.
    var tryIndex = 0;
    function tryNext() {
      if (tryIndex >= names.length) {
        // hicbiri eslesmedi: ilk adla yapilan aramanin en iyi sonucunu kullanmaya calis
        return apiSearch(names[0]).then(function (json) {
          var fallback = pickBestMatch(json && json.results ? json.results : [], names, meta.year);
          if (!fallback) throw new Error('AnimeciX uzerinde bulunamadi: ' + names.join(' / '));
          return fallback;
        });
      }
      var query = names[tryIndex++];
      return apiSearch(query).then(function (json) {
        var match = pickBestMatch(json && json.results ? json.results : [], names, meta.year);
        if (match) return match;
        return tryNext();
      });
    }
    return tryNext();
  });
}

// ==========================================================================================
// 5) Kaynak cozumleyiciler (Kotlin resolvers birebir)
// ==========================================================================================

function extractMediaCandidates(html) {
  var result = [];
  // 1) sources: [{file:"...",label:"..."}, ...]
  var srcMatch = html.match(/sources\s*[:=]\s*\[([\s\S]+?)\]/);
  if (srcMatch) {
    var block = srcMatch[1];
    var fileRe = /file\s*:\s*["']([^"']+)["']/g;
    var fm;
    while ((fm = fileRe.exec(block)) !== null) {
      var url = fm[1];
      if (url.indexOf('.m3u8') !== -1 || url.indexOf('.mp4') !== -1) {
        var lm = block.match(/label\s*:\s*["']([^"']+)["']/);
        result.push({ label: lm ? lm[1] : guessQuality(url), url: url });
      }
    }
  }
  // 2) file: "..."
  var fileRe2 = /file\s*:\s*["']([^"']+)["']/g;
  while ((fm = fileRe2.exec(html)) !== null) {
    var u = fm[1];
    if (u.indexOf('.m3u8') !== -1 || u.indexOf('.mp4') !== -1) {
      result.push({ label: guessQuality(u), url: u });
    }
  }
  // 3) dogrudan medya adresleri
  var reM3u8 = /["'](https?:\/\/[^"'\s]+?\.m3u8[^"'\s]*)["']/g;
  var reMp4 = /["'](https?:\/\/[^"'\s]+?\.mp4[^"'\s]*)["']/g;
  var m;
  while ((m = reM3u8.exec(html)) !== null) result.push({ label: guessQuality(m[1]), url: m[1] });
  while ((m = reMp4.exec(html)) !== null) result.push({ label: guessQuality(m[1]), url: m[1] });

  // URL'e gore tekillestir
  var seen = {};
  var out = [];
  for (var i = 0; i < result.length; i++) {
    if (!seen[result[i].url]) {
      seen[result[i].url] = true;
      out.push(result[i]);
    }
  }
  return out;
}

function guessQuality(url) {
  var m = url.match(/(\d{3,4})[pP]/);
  if (m) return m[1] + 'p';
  if (url.indexOf('1080') !== -1) return '1080p';
  if (url.indexOf('720') !== -1) return '720p';
  if (url.indexOf('480') !== -1) return '480p';
  return 'auto';
}

function qualityRank(label) {
  var m = String(label || '').match(/\d+/);
  return m ? parseInt(m[0], 10) : 0;
}

function hostOf(url) {
  var m = String(url).match(/^https?:\/\/([^/]+)/i);
  return m ? m[1].toLowerCase() : String(url).toLowerCase();
}

function embedHeaders(embedUrl) {
  return {
    'User-Agent': USER_AGENT,
    'Referer': embedUrl,
    'Accept-Encoding': 'identity',
  };
}

/** m3u8 master dosyasindan kaliteleri (RESOLUTION) okur. */
function parseMasterPlaylist(master) {
  var lines = master.split('\n');
  var result = [];
  var label = null;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var res = line.match(/RESOLUTION=(\d+)x(\d+)/);
    if (res) {
      label = res[2] + 'p';
    } else if (line.indexOf('#EXTINF') === 0 && label === null) {
      label = 'auto';
    } else if (line && line.charAt(0) !== '#') {
      result.push({ label: label || 'auto', url: line.trim() });
      label = null;
    }
  }
  return result;
}

/** Dean Edwards packer cozumleyici (Uqload icin). */
function deanUnpack(html) {
  var MARKER = 'eval(function(p,a,c,k,e,d)';
  var searchFrom = 0;
  while (true) {
    var start = html.indexOf(MARKER, searchFrom);
    if (start < 0) return null;
    var args = deanParseArgs(html, start);
    if (args) {
      var result = deanUnpackArgs(args);
      if (result.indexOf('jwplayer') !== -1 || result.indexOf('sources') !== -1) return result;
    }
    searchFrom = start + MARKER.length;
  }
}

function deanParseArgs(html, markerIndex) {
  var bodyStart = html.indexOf('{', markerIndex);
  if (bodyStart < 0) return null;
  var depth = 0, bodyEnd = -1, i = bodyStart;
  while (i < html.length) {
    if (html.charAt(i) === '{') depth++;
    else if (html.charAt(i) === '}') {
      depth--;
      if (depth === 0) bodyEnd = i;
    }
    if (bodyEnd >= 0) break;
    i++;
  }
  if (bodyEnd < 0) return null;

  var cursor = bodyEnd + 1;
  while (cursor < html.length && /\s/.test(html.charAt(cursor))) cursor++;
  if (html.charAt(cursor) !== '(') return null;
  cursor++;

  var payload = deanReadArg(html, cursor);
  if (!payload) return null;
  cursor = payload[1];
  if (html.charAt(cursor) !== ',') return null;
  cursor++;
  var radix = deanReadNum(html, cursor);
  if (!radix) return null;
  cursor = radix[1];
  if (html.charAt(cursor) !== ',') return null;
  cursor++;
  var count = deanReadNum(html, cursor);
  if (!count) return null;
  cursor = count[1];
  if (html.charAt(cursor) !== ',') return null;
  cursor++;
  var keys = deanReadArg(html, cursor);
  if (!keys) return null;

  return { payload: payload[0], radix: radix[0], count: count[0], keys: keys[0].split('|') };
}

function deanReadArg(html, start) {
  var i = start;
  while (i < html.length && /\s/.test(html.charAt(i))) i++;
  if (html.charAt(i) === '\\' && html.charAt(i + 1) === '\'') {
    var end = html.indexOf("\\'", i + 2);
    if (end < 0) return null;
    return [html.substring(i + 2, end), end + 2];
  }
  if (html.charAt(i) === '\'') {
    var sb = '';
    var j = i + 1;
    while (j < html.length) {
      var ch = html.charAt(j);
      if (ch === '\\' && j + 1 < html.length) {
        sb += html.charAt(j + 1);
        j += 2;
        continue;
      }
      if (ch === '\'') return [sb, j + 1];
      sb += ch;
      j++;
    }
  }
  return null;
}

function deanReadNum(html, start) {
  var i = start;
  while (i < html.length && /\s/.test(html.charAt(i))) i++;
  var begin = i;
  while (i < html.length && html.charAt(i) >= '0' && html.charAt(i) <= '9') i++;
  if (i === begin) return null;
  return [parseInt(html.substring(begin, i), 10), i];
}

function toRadix(value, radix) {
  if (value === 0) return '0';
  var digits = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  var rest = value, sb = '';
  while (rest > 0) {
    sb = digits.charAt(rest % radix) + sb;
    rest = Math.floor(rest / radix);
  }
  return sb;
}

function deanUnpackArgs(args) {
  var result = args.payload;
  for (var index = args.count - 1; index >= 0; index--) {
    if (index < args.keys.length && args.keys[index]) {
      var token = toRadix(index, args.radix);
      result = result.replace(new RegExp('\\b' + token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g'), args.keys[index]);
    }
  }
  return result;
}

// ---- tekil cozumleyiciler: her biri Promise<[{label,url,size?}]> doner ----

function resolveTau(embedUrl, headersRef) {
  var m = embedUrl.match(/tau-video\.[a-z]+\/embed\/([A-Za-z0-9_-]+)/);
  if (!m) return Promise.resolve([]);
  return externalGet(TAU_API + m[1]).then(function (body) {
    var json;
    try { json = JSON.parse(body); } catch (e) { return []; }
    var urls = json && json.urls ? json.urls : [];
    var out = [];
    for (var i = 0; i < urls.length; i++) {
      if (urls[i] && urls[i].url) {
        out.push({
          label: urls[i].label || 'auto',
          url: urls[i].url,
          size: urls[i].size || null,
          headers: { 'User-Agent': USER_AGENT, 'Referer': BASE_URL + '/' },
        });
      }
    }
    return out;
  }).catch(function () { return []; });
}

function resolveSibnet(embedUrl) {
  return externalGet(embedUrl, embedHeaders(embedUrl)).then(function (html) {
    var urls = [];
    var re = /"(?:file_loc|file_link)"\s*:\s*"([^"]+)"/g;
    var m;
    while ((m = re.exec(html)) !== null) urls.push(m[1]);
    var cands = extractMediaCandidates(html);
    for (var i = 0; i < cands.length; i++) urls.push(cands[i].url);
    var seen = {}, out = [];
    for (var j = 0; j < urls.length; j++) {
      var url = urls[j];
      if (url.charAt(0) === '/') url = 'https://video.sibnet.ru' + url;
      if (!seen[url]) {
        seen[url] = true;
        out.push({
          label: guessQuality(url),
          url: url,
          headers: embedHeaders(embedUrl),
        });
      }
    }
    return out;
  }).catch(function () { return []; });
}

function resolveOkru(embedUrl) {
  var m = embedUrl.match(/(?:videoembed|video)\/(\d+)/);
  if (!m) return Promise.resolve([]);
  return externalGet('https://ok.ru/videoembed/' + m[1], embedHeaders(embedUrl)).then(function (html) {
    var urls = [];
    var re1 = /\\\\"movie\\\\"\s*:\s*\{[^}]*?\\\\"url\\\\"\s*:\s*\\\\"([^\\\\"]+)/g;
    var re2 = /\\\\"videos\\\\"\s*:\s*\[\s*\{[^}]*?\\\\"url\\\\"\s*:\s*\\\\"([^\\\\"]+)/g;
    var mm;
    while ((mm = re1.exec(html)) !== null) urls.push(mm[1]);
    while ((mm = re2.exec(html)) !== null) urls.push(mm[1]);
    var cands = extractMediaCandidates(html);
    for (var i = 0; i < cands.length; i++) urls.push(cands[i].url);
    var seen = {}, out = [];
    for (var j = 0; j < urls.length; j++) {
      if (!seen[urls[j]]) {
        seen[urls[j]] = true;
        out.push({ label: guessQuality(urls[j]), url: urls[j], headers: embedHeaders(embedUrl) });
      }
    }
    return out;
  }).catch(function () { return []; });
}

function resolveDailymotion(embedUrl) {
  var m = embedUrl.match(/\/(?:embed\/)?video\/([A-Za-z0-9]+)/);
  if (!m) return Promise.resolve([]);
  return externalGet('https://www.dailymotion.com/player/metadata/video/' + m[1]).then(function (body) {
    var json;
    try { json = JSON.parse(body); } catch (e) { return []; }
    var qualities = json && json.qualities ? json.qualities : {};
    var out = [];
    for (var key in qualities) {
      var arr = qualities[key];
      if (!arr || !arr.length) continue;
      var item = arr[0];
      if (item && item.url) {
        out.push({
          label: key === 'auto' ? 'auto' : key + 'p',
          url: item.url,
          headers: embedHeaders(embedUrl),
        });
      }
    }
    return out;
  }).catch(function () { return []; });
}

function resolveGoogleDrive(embedUrl) {
  var m = embedUrl.match(/\/file\/d\/([A-Za-z0-9_-]{10,})/);
  if (!m) return Promise.resolve([]);
  var fileId = m[1];
  var direct = 'https://drive.usercontent.google.com/download?id=' + fileId + '&export=download';
  return externalGet(direct, embedHeaders(embedUrl)).then(function (body) {
    var fm = body.match(/action="([^"]*confirm=[^"]*)"/);
    return fm ? fm[1].replace(/&amp;/g, '&') : ('https://drive.google.com/uc?export=download&id=' + fileId);
  }).then(function (url) {
    return [{ label: 'auto', url: url, headers: embedHeaders(embedUrl) }];
  }).catch(function () {
    return [{ label: 'auto', url: 'https://drive.google.com/uc?export=download&id=' + fileId, headers: embedHeaders(embedUrl) }];
  });
}

function extractDoodUrl(body) {
  var m = body.match(/"data"\s*:\s*"([^"]+)/);
  if (m) return m[1];
  m = body.match(/"url"\s*:\s*"([^"]+)/);
  if (m) return m[1];
  m = body.match(/(?:file|video_url|quality)\s*[=:]\s*["']([^"']+)["']/);
  if (m) return m[1];
  m = body.match(/https?:\/\/[^"'\s]+?\.(?:m3u8|mp4)[^"'\s]*/);
  return m ? m[0] : null;
}

function doodPost(url, referer, form) {
  var headers = { 'Referer': referer };
  if (form) {
    var parts = [];
    for (var k in form) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(form[k]));
    return fetch(url, { method: 'POST', headers: headers, body: parts.join('&') })
      .then(function (r) { return r.ok ? r.text() : null; })
      .catch(function () { return null; });
  }
  return fetch(url, { method: 'GET', headers: headers })
    .then(function (r) { return r.ok ? r.text() : null; })
    .catch(function () { return null; });
}

function resolveDoodstream(embedUrl) {
  return externalGet(embedUrl, embedHeaders(embedUrl)).then(function (html) {
    // bazi surumlerde hazir medya adresi sayfada gelir
    var ready = extractMediaCandidates(html);
    if (ready.length) {
      return [{
        label: ready[0].label,
        url: ready[0].url,
        headers: embedHeaders(embedUrl),
      }];
    }
    var idm = embedUrl.match(/\/e\/([A-Za-z0-9_-]+)/) || html.match(/\/e\/([A-Za-z0-9_-]+)/);
    if (!idm) return [];
    var id = idm[1];
    var host = hostOf(embedUrl).replace(/^www\./, '');
    var headers = { 'User-Agent': USER_AGENT, 'Referer': BASE_URL + '/' };

    // 1) eski /f/<token> akisi
    var tm = html.match(/\/f\/([A-Za-z0-9]{6,})/);
    var firstTry = tm
      ? doodPost('https://' + host + '/f/' + tm[1], embedUrl, null)
      : Promise.resolve(null);
    return firstTry.then(function (body) {
      if (body) {
        var url = extractDoodUrl(body);
        if (url) return [{ label: guessQuality(url), url: url, headers: embedHeaders(embedUrl) }];
      }
      // 2) passphrase/custom ile POST
      var pm = html.match(/passphrase\s*[:=]\s*["']([^"']+)["']/);
      var cm = html.match(/(?:hash|custom)\s*[:=]\s*["']([^"']+)["']/);
      if (!pm && !cm) return [];
      var form = {};
      if (pm) form['passphrase'] = pm[1];
      if (cm) form['custom'] = cm[1];
      return doodPost('https://' + host + '/f/' + id, embedUrl, form).then(function (body2) {
        if (!body2) return [];
        var url2 = extractDoodUrl(body2);
        return url2 ? [{ label: guessQuality(url2), url: url2, headers: embedHeaders(embedUrl) }] : [];
      });
    });
  }).catch(function () { return []; });
}

function resolveStreamtape(embedUrl) {
  return externalGet(embedUrl, embedHeaders(embedUrl)).then(function (html) {
    var urls = [];
    var re1 = /robotlink["']?\s*[:=]\s*["']([^"']+)/g;
    var re2 = /videoLink["']?\s*[:=]\s*["']([^"']+)/g;
    var m;
    while ((m = re1.exec(html)) !== null) urls.push(m[1]);
    while ((m = re2.exec(html)) !== null) urls.push(m[1]);
    var cands = extractMediaCandidates(html);
    for (var i = 0; i < cands.length; i++) urls.push(cands[i].url);
    var seen = {}, out = [];
    for (var j = 0; j < urls.length; j++) {
      if (!seen[urls[j]]) {
        seen[urls[j]] = true;
        out.push({ label: guessQuality(urls[j]), url: urls[j], headers: embedHeaders(embedUrl) });
      }
    }
    return out;
  }).catch(function () { return []; });
}

function resolveVidmoly(embedUrl) {
  var chain = function (current, remaining) {
    return externalGet(current, embedHeaders(current)).then(function (body) {
      var next = body.match(/window\.location\.replace\(['"]([^'"]+)['"]\)/) ||
        body.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/);
      if (next && remaining > 0) {
        return chain(next[1], remaining - 1);
      }
      return body;
    }).catch(function () { return null; });
  };
  return chain(embedUrl, 4).then(function (page) {
    if (!page) return [];
    var links = extractMediaCandidates(page);
    return links.map(function (c) {
      return { label: c.label, url: c.url, headers: embedHeaders(embedUrl) };
    });
  });
}

function resolveUqload(embedUrl) {
  return externalGet(embedUrl, embedHeaders(embedUrl)).then(function (html) {
    var unpacked = deanUnpack(html);
    if (!unpacked) return [];
    var master = (unpacked.match(/sources:\s*\[\s*\{\s*file\s*:\s*"([^"]+)"/) || [])[1];
    if (!master) return [];
    var headers = embedHeaders(embedUrl);
    return externalGet(master, headers).then(function (playlist) {
      var variants = parseMasterPlaylist(playlist);
      if (variants.length) {
        return variants.map(function (v) {
          return { label: v.label, url: v.url, headers: headers };
        });
      }
      return [{ label: 'auto', url: master, headers: headers }];
    }).catch(function () {
      return [{ label: 'auto', url: master, headers: headers }];
    });
  }).catch(function () { return []; });
}

function resolveGenericHtml(embedUrl) {
  var host = hostOf(embedUrl);
  return externalGet(embedUrl, {
    'User-Agent': USER_AGENT,
    'Accept': '*/*',
    'Origin': 'https://' + host,
    'Referer': 'https://' + host + '/',
    'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
  }).then(function (html) {
    var candidates = extractMediaCandidates(html);
    var headers = embedHeaders(embedUrl);
    return candidates.map(function (c) {
      return { label: c.label, url: c.url, headers: headers };
    });
  }).catch(function () { return []; });
}

function resolveYouTube(embedUrl) {
  var m = embedUrl.match(/youtube\.com\/embed\/([A-Za-z0-9_-]{6,})/) ||
    embedUrl.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/);
  if (!m) return Promise.resolve([]);
  return Promise.resolve([{ label: 'auto', url: 'https://www.youtube.com/watch?v=' + m[1], headers: embedHeaders(embedUrl) }]);
}

/** Embed adresini dogrudan akislara cevirir (Kotlin resolver zinciri). */
function resolveEmbed(embedUrl) {
  if (embedUrl.indexOf('tau-video.') !== -1 && embedUrl.indexOf('/embed/') !== -1) return resolveTau(embedUrl);
  if (hostOf(embedUrl).indexOf('sibnet.ru') !== -1) return resolveSibnet(embedUrl);
  if (hostOf(embedUrl) === 'ok.ru' || hostOf(embedUrl) === 'odnoklassniki.ru') return resolveOkru(embedUrl);
  if (hostOf(embedUrl).indexOf('dailymotion.com') !== -1) return resolveDailymotion(embedUrl);
  if (hostOf(embedUrl).indexOf('google.com') !== -1 && embedUrl.indexOf('/file/d/') !== -1) return resolveGoogleDrive(embedUrl);
  if (embedUrl.indexOf('doodstream') !== -1 || embedUrl.indexOf('playmogo') !== -1 || embedUrl.indexOf('dssib') !== -1) return resolveDoodstream(embedUrl);
  if (hostOf(embedUrl).indexOf('streamtape') !== -1) return resolveStreamtape(embedUrl);
  if (hostOf(embedUrl).indexOf('vidmoly') !== -1) return resolveVidmoly(embedUrl);
  if (hostOf(embedUrl).indexOf('uqload') !== -1) return resolveUqload(embedUrl);
  if (embedUrl.indexOf('youtube.com/embed/') !== -1 || embedUrl.indexOf('youtu.be/') !== -1) return resolveYouTube(embedUrl);
  return resolveGenericHtml(embedUrl);
}

// ==========================================================================================
// 6) Nuvio cikti formati + getStreams ana girisi
// ==========================================================================================

function formatBytes(size) {
  if (!size && size !== 0) return 'Unknown';
  var gb = size / 1073741824;
  if (gb >= 1) return gb.toFixed(2) + ' GB';
  var mb = size / 1048576;
  if (mb >= 1) return mb.toFixed(1) + ' MB';
  return size + ' B';
}

/**
 * Bir video kaynagini (AnimeciX `videos[]` ogesi) Nuvio akis listesine cevirir.
 * Kotlin: streams()/resolveSource() birebir.
 */
function formatSourceLinks(sourceName, fansub, resolved, embedUrl, mediaTitle) {
  var links = [];
  var serverLabel = fansub ? fansub : (sourceName || 'Server');
  for (var i = 0; i < resolved.length; i++) {
    var r = resolved[i];
    var quality = r.label || 'auto';
    var displayName = '⌜ AnimeciX ⌟ | ' + serverLabel + ' | ' + quality;
    links.push({
      name: displayName,
      title: mediaTitle || '',
      url: r.url,
      quality: quality,
      size: formatBytes(r.size),
      headers: r.headers || { 'User-Agent': USER_AGENT, 'Referer': BASE_URL + '/' },
      subtitles: [],
    });
  }
  if (!links.length) {
    // Cozulemeyen kaynak kaybolmasin: embed olarak sunulur (Kotlin allSources davranisi)
    links.push({
      name: '⌜ AnimeciX ⌟ | ' + serverLabel + ' | embed',
      title: mediaTitle || '',
      url: embedUrl,
      quality: 'embed',
      size: 'Unknown',
      headers: { 'User-Agent': USER_AGENT, 'Referer': BASE_URL + '/' },
      subtitles: [],
    });
  }
  return links;
}

/** Kaynak listesini (titleId, season, episode) -> [{source obj}] */
function fetchSources(titleId, season, episode) {
  return apiEpisodeVideos(titleId, season, episode).then(function (json) {
    var videos = json && json.videos ? json.videos : [];
    var translatorPoints = json && json.translatorPoints ? json.translatorPoints : {};
    return apiTranslators().then(function (translators) {
      var sources = [];
      for (var i = 0; i < videos.length; i++) {
        var v = videos[i];
        if (!v || !v.url) continue;
        var fansubId = v.template;
        var fansub = null;
        if (fansubId && translators[fansubId]) fansub = translators[fansubId];
        var score = null;
        if (fansubId && translatorPoints[fansubId] !== undefined) score = translatorPoints[fansubId];
        sources.push({
          id: v.id || null,
          name: v.name || null,
          embedUrl: v.url,
          type: v.type || null,
          quality: v.quality || null,
          language: v.language || null,
          category: v.category || null,
          fansub: fansub,
          fansubId: fansubId || null,
          score: score,
        });
      }
      // puanli kaynaklari one al (Kotlin: site onceligi + puan)
      sources.sort(function (a, b) {
        var sa = a.score || 0, sb = b.score || 0;
        return sb - sa;
      });
      return sources;
    });
  });
}

/**
 * NUVIO ANA GIRIS.
 * id: TMDB id (sayi/string) veya IMDB id ("tt...") | mediaType: "movie" | "tv"
 * AnimeciX Turkce anime katalogu oldugu icin baslik eslemesi TMDB/Cinemeta uzerinden yapilir.
 */
function getStreams(id, mediaType, season, episode) {
  if (mediaType !== 'tv' && mediaType !== 'movie') return Promise.resolve([]);

  var rid = String(Math.floor(Math.random() * 900000) + 100000);
  function log(msg, extra) {
    try {
      if (typeof extra !== 'undefined') console.log('[AnimeciX][rid:' + rid + '] ' + msg, extra);
      else console.log('[AnimeciX][rid:' + rid + '] ' + msg);
    } catch (e) { }
  }
  log('getStreams start', { id: id, S: season, E: episode });

  var wantSeason = parseInt(season, 10) || 1;
  var wantEpisode = parseInt(episode, 10) || 1;
  var matchedTitle = null;
  var mediaTitleBase = '';

  // (S,E) adaylari: once istenen, sonra sezon 1, movie icin S1E1
  var candidates = [];
  if (mediaType === 'movie') {
    candidates.push([1, 1], [0, 1]);
  } else {
    candidates.push([wantSeason, wantEpisode], [1, wantEpisode], [1, 1]);
  }

  function tryCandidate(idx) {
    if (idx >= candidates.length) {
      log('hicbir kaynak bulunamadi');
      return Promise.resolve([]);
    }
    var c = candidates[idx];
    return fetchSources(matchedTitle.id, c[0], c[1]).then(function (sources) {
      if (sources.length) {
        log('kaynaklar bulundu S' + c[0] + 'E' + c[1] + ' (' + sources.length + ')');
        return runResolvers(sources, c);
      }
      return tryCandidate(idx + 1);
    });
  }

  function runResolvers(sources, usedSE) {
    // Tum kaynaklari paralel coz; bozuk olanlar sessizce elenir (Kotlin runCatching davranisi)
    var tasks = sources.map(function (source) {
      return resolveEmbed(source.embedUrl)
        .then(function (resolved) { return { source: source, resolved: resolved }; })
        .catch(function () { return { source: source, resolved: [] }; });
    });
    return Promise.all(tasks).then(function (results) {
      var links = [];
      for (var i = 0; i < results.length; i++) {
        var r = results[i];
        var fansub = r.source.fansub || (r.source.fansubId ? 'Cevirmen #' + r.source.fansubId : null);
        var mediaTitle = mediaTitleBase + ' S' + usedSE[0] + 'E' + usedSE[1];
        links = links.concat(
          formatSourceLinks(r.source.name, fansub, r.resolved, r.source.embedUrl, mediaTitle)
        );
      }
      // URL'e gore tekillestir + kaliteye gore sirala (Kotlin streams())
      var seen = {};
      var unique = [];
      for (var j = 0; j < links.length; j++) {
        if (!seen[links[j].url]) {
          seen[links[j].url] = true;
          unique.push(links[j]);
        }
      }
      unique.sort(function (a, b) { return qualityRank(b.quality) - qualityRank(a.quality); });
      log('done', { streams: unique.length });
      return unique;
    });
  }

  return resolveAnimecixTitle(id, mediaType)
    .then(function (match) {
      if (!match) throw new Error('Eslesme bulunamadi');
      matchedTitle = match;
      mediaTitleBase = match.name || match.name_romanji || 'Anime';
      log('eslesme', { id: match.id, name: match.name, yil: match.year });
      return tryCandidate(0);
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
  global.AnimeciXScraperModule = { getStreams: getStreams };
}

