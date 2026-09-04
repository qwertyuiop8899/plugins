/* Vidxgo (vd) provider - standalone Nuvio/Stremio plugin
 * Movies and TV series. XOR-decodes blocks to extract a direct master.m3u8 URL.
 * FIXED:
 *  - Use https.get with altadefinizionex.live referer to completely bypass Cloudflare 403
 *  - Execute both XOR patterns in decodeXorBlocks so the stream master.m3u8 is not missed
 *  - Provide direct CDN master URL in streams so video plays directly without local server /clone issues
 */
var Buffer = typeof Buffer !== 'undefined' ? Buffer : require('buffer').Buffer;
var crypto = (function(){ try{ return require('crypto'); }catch(e){ return null; }})();
var https = (function(){ try{ return require('https'); }catch(e){ return null; }})();

var TMDB_API_KEY = '68e094699525b18a70bab2f86b1fa706';
var VD_DOMAIN = 'https://v.vidxgo.co';

var VD_M3U8_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': VD_DOMAIN + '/',
  'Origin': VD_DOMAIN,
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'cross-site'
};

var VD_PAGE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-GPC': '1',
  'Alt-Used': 'v.vidxgo.co',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'iframe',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'DNT': '1',
  'Referer': 'https://altadefinizionex.live/',
  'Priority': 'u=0, i'
};

var _REFRESH_TTL = 30;
var _TOKEN_BUFFER = 30;
var _refreshCache = {};
var _refreshPromise = {};

function _vdTmdbToImdb(tmdbId, type) {
  return new Promise(function (resolve) {
    if (/^tt\d+$/.test(tmdbId)) {
      return resolve(tmdbId);
    }
    var endpoint = type === 'series' || type === 'tv'
      ? 'https://api.themoviedb.org/3/tv/' + tmdbId + '/external_ids?api_key=' + TMDB_API_KEY
      : 'https://api.themoviedb.org/3/movie/' + tmdbId + '?api_key=' + TMDB_API_KEY;

    fetch(endpoint, { timeout: 10000 })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && data.imdb_id) {
          resolve(data.imdb_id);
        } else if (data && data.external_ids && data.external_ids.imdb_id) {
          resolve(data.external_ids.imdb_id);
        } else {
          resolve(null);
        }
      })
      .catch(function () { resolve(null); });
  });
}

function md5hex(str) {
  if (crypto && crypto.createHash) {
    return crypto.createHash('md5').update(str).digest('hex');
  }
  var hash = 0;
  for (var i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}

function getStreams(id, type, season, episode) {
  return new Promise(function (resolve, reject) {
    var cleanId = String(id || '').replace(/^tmdb:/, '');
    var mediaType = String(type || 'movie').toLowerCase();
    var isSeries = mediaType === 'series' || mediaType === 'tv';

    var globalImdbId = (typeof __imdb_id !== 'undefined' && /^tt\d+$/.test(__imdb_id)) ? __imdb_id : null;
    var getImdbIdPromise;

    if (globalImdbId) {
      getImdbIdPromise = Promise.resolve(globalImdbId);
    } else {
      getImdbIdPromise = _vdTmdbToImdb(cleanId, isSeries ? 'series' : 'movie');
    }

    getImdbIdPromise.then(function (imdbId) {
      if (!imdbId) {
        imdbId = cleanId;
      }

      var pageUrl;
      if (isSeries) {
        var seasonNum = Number(season) || 1;
        var episodeNum = Number(episode) || 1;
        pageUrl = VD_DOMAIN + '/' + imdbId + '/' + seasonNum + '/' + episodeNum;
      } else {
        pageUrl = VD_DOMAIN + '/' + imdbId;
      }

      fetchVidxgoPage(pageUrl, function (err, html) {
        if (err || !html) {
          return resolve([]);
        }

        var decoded = decodeXorBlocks(html) || tryFallbackDecode(html);
        if (!decoded) {
          return resolve([]);
        }

        var masterUrl = extractMasterUrl(decoded);
        if (!masterUrl) {
          return resolve([]);
        }

        var subtitles = extractSubtitles(decoded);
        var mediaId = extractVidxgoMediaId(masterUrl);

        resolveVidxgoMasterUrl(masterUrl, mediaId).then(function (resolvedMasterUrl) {
          var finalMaster = resolvedMasterUrl || masterUrl;

          probeMultiAudio(finalMaster).then(function (isMultiAudio) {
            var bgHash = md5hex('vidxgo-' + imdbId).slice(0, 12);
            var bgBase = 'sg-' + bgHash;

            var streams = [];

            // 1. Direct stream verso la CDN (funziona direttamente senza proxy locale)
            var directStream = {
              name: 'Server 12 Direct',
              title: 'Server 12 \u00b7 1080p \u00b7 Direct',
              url: finalMaster,
              quality: "1080",
              _vd_multi: !!isMultiAudio,
              headers: VD_M3U8_HEADERS,
              behaviorHints: {
                notWebReady: true,
                proxyHeaders: { request: VD_M3U8_HEADERS },
                bingeGroup: bgBase + '-direct'
              }
            };
            if (subtitles && subtitles.length > 0) directStream.subtitles = subtitles;
            streams.push(directStream);

            // 2. Clone stream fallback
            var cloneStream = {
              name: 'Server 12 Auto-Refresh',
              title: 'Server 12 \u00b7 1080p \u00b7 Auto Refresh',
              url: buildProxyUrl(finalMaster),
              quality: "1080",
              _vd_multi: !!isMultiAudio,
              headers: VD_M3U8_HEADERS,
              behaviorHints: {
                notWebReady: true,
                proxyHeaders: { request: VD_M3U8_HEADERS },
                bingeGroup: bgBase + '-clone'
              }
            };
            if (subtitles && subtitles.length > 0) cloneStream.subtitles = subtitles;
            streams.push(cloneStream);

            resolve(streams);
          });
        }).catch(function () {
          var fallbackStream = {
            name: 'Server 12 Direct',
            title: 'Server 12 \u00b7 1080p \u00b7 Direct',
            url: masterUrl,
            quality: "1080",
            headers: VD_M3U8_HEADERS,
            behaviorHints: {
              notWebReady: true,
              proxyHeaders: { request: VD_M3U8_HEADERS },
              bingeGroup: 'vidxgo-' + imdbId
            }
          };
          if (subtitles && subtitles.length > 0) fallbackStream.subtitles = subtitles;
          resolve([fallbackStream]);
        });
      });
    });
  });
}

function fetchVidxgoPage(url, cb) {
  if (https && https.get) {
    try {
      https.get(url, { headers: VD_PAGE_HEADERS, timeout: 20000 }, function (res) {
        if (res.statusCode !== 200) {
          return cb(new Error('HTTP ' + res.statusCode), null);
        }
        var chunks = [];
        res.on('data', function (chunk) { chunks.push(chunk); });
        res.on('end', function () {
          var body = Buffer.concat(chunks).toString('utf-8');
          cb(null, body);
        });
      }).on('error', function (err) {
        cb(err, null);
      });
      return;
    } catch (e) {}
  }

  fetch(url, { headers: VD_PAGE_HEADERS, timeout: 20000 })
    .then(function (r) { return r.text(); })
    .then(function (html) { cb(null, html); })
    .catch(function (err) { cb(err, null); });
}

function pageUrlForMediaId(mediaId) {
  var parts = String(mediaId || '').split('/').map(function(p){ return encodeURIComponent(p); }).filter(Boolean);
  if (!parts.length) return null;
  return VD_DOMAIN + '/' + parts.join('/');
}

function tokenExpiry(url) {
  try {
    var parsed = new URL(url);
    var e = parsed.searchParams.get('e');
    if (!e) return null;
    var ms = Number(e);
    if (!isFinite(ms)) return null;
    return ms / 1000;
  } catch(e) { return null; }
}

function extractVidxgoMediaId(masterUrl) {
  try {
    var parsed = new URL(masterUrl);
    var parts = parsed.pathname.split('/').filter(function (part) { return !!part; });
    var hlsIndex = parts.indexOf('hls');
    if (hlsIndex < 0) return null;

    var mediaParts = [];
    for (var i = hlsIndex + 1; i < parts.length; i++) {
      if (parts[i].indexOf('master') !== -1) break;
      mediaParts.push(parts[i]);
    }
    if (mediaParts[0] === 'tv') mediaParts.shift();
    return mediaParts.length > 0 ? mediaParts.join('/') : null;
  } catch (e) {
    return null;
  }
}

function probeVidxgoMaster(masterUrl) {
  return fetchM3u8(masterUrl).then(function (res) {
    if (res.status !== 200 || !res.text) return false;
    return String(res.text || '').trim().indexOf('#EXTM3U') === 0;
  }).catch(function () {
    return false;
  });
}

function fetchM3u8(url) {
  return fetch(url, { headers: VD_M3U8_HEADERS, timeout: 12000 })
    .then(function(r){ return r.ok ? r.text().then(function(t){ return {text:t, status:r.status}; }) : {text:'', status:r.status}; })
    .catch(function(){ return {text:'', status:0}; });
}

function probeMultiAudio(masterUrl) {
  return fetchM3u8(masterUrl).then(function(res){
    if (res.status !== 200 || !res.text) return false;
    var tags = res.text.match(/#EXT-X-MEDIA:TYPE=AUDIO[^\n]*/gi);
    return !!(tags && tags.length > 1);
  }).catch(function(){ return false; });
}

function refreshVidxgoMaster(mediaId) {
  if (!mediaId) return Promise.resolve(null);
  var pageUrl = pageUrlForMediaId(mediaId);
  if (!pageUrl) return Promise.resolve(null);
  pageUrl += '?__toast_refresh=' + Date.now() + Math.random().toString(16).slice(2);
  
  return new Promise(function (resolve) {
    fetchVidxgoPage(pageUrl, function (err, html) {
      if (err || !html) return resolve(null);
      var decoded = decodeXorBlocks(html) || tryFallbackDecode(html);
      if (!decoded) return resolve(null);
      var url = extractMasterUrl(decoded);
      if (!url) return resolve(null);
      resolve(url.replace(/\\/g, ''));
    });
  });
}

function refreshCached(mediaId, force) {
  var now = Date.now() / 1000;
  function usable(entry){
    if (!entry || !entry.url || entry.expiresAt <= now) return null;
    var exp = tokenExpiry(entry.url);
    if (exp !== null && exp - _TOKEN_BUFFER <= now) return null;
    return entry.url;
  }
  var cached = _refreshCache[mediaId];
  var url = usable(cached);
  if (url && !force) return Promise.resolve(url);
  if (_refreshPromise[mediaId]) return _refreshPromise[mediaId];

  var p = refreshVidxgoMaster(mediaId).then(function(freshUrl){
    if (freshUrl) {
      var exp = tokenExpiry(freshUrl);
      var ttl = _REFRESH_TTL;
      if (exp !== null) ttl = Math.max(5, Math.min(ttl, exp - (Date.now()/1000) - _TOKEN_BUFFER));
      _refreshCache[mediaId] = { url: freshUrl, expiresAt: (Date.now()/1000) + ttl };
      return freshUrl;
    }
    return null;
  }).finally(function(){ delete _refreshPromise[mediaId]; });
  _refreshPromise[mediaId] = p;
  return p;
}

function resolveVidxgoMasterUrl(masterUrl, knownMediaId) {
  return probeVidxgoMaster(masterUrl).then(function (isValid) {
    if (isValid) return masterUrl;
    var mediaId = knownMediaId || extractVidxgoMediaId(masterUrl);
    if (!mediaId) return masterUrl;
    return refreshCached(mediaId, false).then(function (freshUrl) {
      return freshUrl || masterUrl;
    });
  });
}

function xorDecode(key, encoded) {
  try {
    var decoded = Buffer.from(encoded, 'base64');
    var out = Buffer.alloc(decoded.length);
    for (var i = 0; i < decoded.length; i++) {
      out[i] = decoded[i] ^ key.charCodeAt(i % key.length);
    }
    return out.toString('utf-8');
  } catch (e) {
    return '';
  }
}

function decodeXorBlocks(html) {
  var results = [];
  var match;

  var blockPattern = /\(function\(\)\{var\s+k=['"]([^'"]+)['"]\s*,\s*d=atob\(['"]([^'"]+)['"]\)/g;
  while ((match = blockPattern.exec(html)) !== null) {
    var key = match[1];
    var encoded = match[2];
    try {
      var decoded = xorDecode(key, encoded);
      if (decoded) results.push(decoded);
    } catch (e) { }
  }

  var blockPattern2 = /var\s+\w+\s*=\s*['"]([^'"]+)['"]\s*,\s*d\s*=\s*atob\(['"]([^'"]+)['"]\)/g;
  while ((match = blockPattern2.exec(html)) !== null) {
    var key2 = match[1];
    var encoded2 = match[2];
    try {
      var decoded2 = xorDecode(key2, encoded2);
      if (decoded2) results.push(decoded2);
    } catch (e) { }
  }

  return results.join('\n');
}

function tryFallbackDecode(html) {
  try {
    var jsonMatch = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>(.*?)<\/script>/s);
    if (jsonMatch) {
      var data = JSON.parse(jsonMatch[1]);
      return JSON.stringify(data);
    }
  } catch (e) { }

  try {
    var m3u8Match = html.match(/https?:\/\/[^"'\s]*master\.m3u8[^"'\s]*/);
    if (m3u8Match) return m3u8Match[0];
  } catch (e) { }

  return null;
}

function extractMasterUrl(decodedJs) {
  var p1 = decodedJs.match(/currentSrc\s*=\s*['"]([^'"]*master\.m3u8[^'"]*)['"]/);
  if (p1) return p1[1].replace(/\\/g, '');

  var p2 = decodedJs.match(/['"](https?:\\?\/\\?\/[^'"]*master\.m3u8[^'"]*)['"]/);
  if (p2) return p2[1].replace(/\\/g, '');

  var p3 = decodedJs.match(/['"](https?:\\?\/\\?\/[^'"]*\.m3u8[^'"]*)['"]/);
  if (p3) return p3[1].replace(/\\/g, '');

  var p4 = decodedJs.match(/https?:\/\/[^"'\]\)\s,]*master\.m3u8[^"'\]\)\s,]*/);
  if (p4) return p4[0].replace(/\\/g, '');

  return null;
}

function extractSubtitles(decodedJs) {
  try {
    var subMatch = decodedJs.match(/window\.__EXTERNAL_SUBS\s+=\s+(\[.*?\]);/s);
    var originMatch = decodedJs.match(/window\.__SUBS_ORIGIN\s+=\s*['"](.*?)['"];/);
    if (!subMatch || !originMatch) return [];

    var rows = JSON.parse(subMatch[1]);
    var origin = originMatch[1].replace(/\\/g, '');

    return rows.map(function (row) {
      if (!row || !row.url) return null;
      var lang = row.lang || row.id || 'sub';
      var id = row.forced ? lang + '-forced' : lang;
      return {
        id: id,
        url: origin + row.url,
        lang: lang
      };
    }).filter(function (s) { return s !== null; });
  } catch (e) {
    return [];
  }
}

function encodeB64Url(str) {
  return Buffer.from(str, 'utf8').toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function buildProxyUrl(masterUrl) {
  return '/clone/manifest.m3u8?d=' + encodeB64Url(masterUrl);
}

module.exports = { getStreams: getStreams };
