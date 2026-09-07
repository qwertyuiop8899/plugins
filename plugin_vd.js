/* Vidxgo (vd) provider - standalone Nuvio/Stremio plugin
 * Movies and TV series. XOR-decodes blocks to extract direct master.m3u8 URL.
 * Routes to local /clone/manifest.m3u8 for auto-refresh and token lifecycle.
 */
var Buffer = typeof Buffer !== 'undefined' ? Buffer : require('buffer').Buffer;
var crypto = (function () {
  try { if (typeof crypto !== 'undefined' && crypto && crypto.createHash) return crypto; } catch (e) {}
  try { return require('crypto'); } catch (e) { return null; }
})();

var TMDB_API_KEY = '68e094699525b18a70bab2f86b1fa706';
var VD_DOMAIN = 'https://v.vidxgo.co';

var VD_M3U8_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
  'Referer': VD_DOMAIN + '/',
  'Origin': VD_DOMAIN,
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'cross-site'
};

var VD_PAGE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
  'Referer': VD_DOMAIN + '/',
  'Sec-GPC': '1',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'iframe',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-Storage-Access': 'active',
  'DNT': '1'
};

var VD_CIPHERS = [
  'TLS_AES_128_GCM_SHA256',
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-CHACHA20-POLY1305',
  'ECDHE-RSA-CHACHA20-POLY1305',
  'ECDHE-RSA-AES128-SHA',
  'ECDHE-RSA-AES256-SHA',
  'AES128-GCM-SHA256',
  'AES256-GCM-SHA384',
  'AES128-SHA',
  'AES256-SHA'
].join(':');

function _vdTmdbToImdb(tmdbId, type) {
  return new Promise(function (resolve) {
    if (!tmdbId) return resolve(null);
    if (/^tt\d+$/.test(tmdbId)) {
      return resolve(tmdbId);
    }
    var endpoint = (type === 'series' || type === 'tv')
      ? 'https://api.themoviedb.org/3/tv/' + tmdbId + '/external_ids?api_key=' + TMDB_API_KEY
      : 'https://api.themoviedb.org/3/movie/' + tmdbId + '?api_key=' + TMDB_API_KEY;

    var https = (function () {
      try { if (typeof https !== 'undefined' && https && https.get) return https; } catch (e) {}
      try { return require('https'); } catch (e) { return null; }
    })();
    if (https && https.get) {
      try {
        https.get(endpoint, { timeout: 8000 }, function (res) {
          if (res.statusCode === 200) {
            var buf = '';
            res.on('data', function (d) { buf += d; });
            res.on('end', function () {
              try {
                var data = JSON.parse(buf);
                var imdb = data && (data.imdb_id || (data.external_ids && data.external_ids.imdb_id));
                if (imdb && /^tt\d+$/.test(imdb)) return resolve(imdb);
              } catch (e) { }
              fallbackFetch();
            });
            return;
          }
          fallbackFetch();
        }).on('error', fallbackFetch);
        return;
      } catch (e) { }
    }
    fallbackFetch();

    function fallbackFetch() {
      if (typeof fetch !== 'undefined') {
        fetch(endpoint, { timeout: 8000 })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (data) {
            var imdb = data && (data.imdb_id || (data.external_ids && data.external_ids.imdb_id));
            resolve(imdb || null);
          })
          .catch(function () { resolve(null); });
      } else {
        resolve(null);
      }
    }
  });
}

function md5hex(str) {
  if (crypto && crypto.createHash) {
    try { return crypto.createHash('md5').update(str, 'utf8').digest('hex'); } catch (e) { }
  }
  var hash = 0;
  for (var i = 0; i < str.length; i++) hash = ((hash << 5) - hash) + str.charCodeAt(i) | 0;
  var hex = (hash >>> 0).toString(16);
  while (hex.length < 8) hex = '0' + hex;
  return (hex + hex + hex + hex).slice(0, 32);
}

function getStreams(id, type, season, episode) {
  return new Promise(function (resolve) {
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
        var finalMaster = masterUrl;
        var streamUrl = buildProxyUrl(finalMaster);
        var bgHash = md5hex('vidxgo-' + imdbId).slice(0, 12);
        var bgBase = 'sg-' + bgHash;

        var directStream = {
          name: 'Server 12 Direct',
          title: 'Server 12 \u00b7 direct \u00b7 auto refresh',
          url: streamUrl,
          quality: '1080',
          _vd_multi: true,
          headers: VD_M3U8_HEADERS,
          behaviorHints: {
            notWebReady: true,
            proxyHeaders: { request: VD_M3U8_HEADERS },
            bingeGroup: bgBase + '-direct'
          }
        };
        if (subtitles && subtitles.length > 0) directStream.subtitles = subtitles;

        resolve([directStream]);
      });
    });
  });
}

function fetchVidxgoPage(url, cb) {
  var https = (function () {
    try { if (typeof https !== 'undefined' && https && https.get) return https; } catch (e) {}
    try { return require('https'); } catch (e) { return null; }
  })();
  if (https && https.get) {
    try {
      https.get(url, { headers: VD_PAGE_HEADERS, ciphers: VD_CIPHERS, minVersion: 'TLSv1.2', timeout: 15000 }, function (res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          var nextUrl = res.headers.location;
          if (nextUrl.startsWith('/')) nextUrl = VD_DOMAIN + nextUrl;
          return fetchVidxgoPage(nextUrl, cb);
        }
        if (res.statusCode !== 200) return tryFetchFallback(url, cb);
        var data = [];
        res.on('data', function (c) { data.push(c); });
        res.on('end', function () { cb(null, Buffer.concat(data).toString('utf-8')); });
      }).on('error', function () { tryFetchFallback(url, cb); });
      return;
    } catch (e) { }
  }
  tryFetchFallback(url, cb);
}

function tryFetchFallback(url, cb) {
  if (typeof fetch !== 'undefined') {
    fetch(url, { headers: VD_PAGE_HEADERS, timeout: 20000 })
      .then(function (r) { return r.text(); })
      .then(function (html) { cb(null, html); })
      .catch(function (err) { cb(err, null); });
  } else {
    cb(new Error('No fetch or https available'), null);
  }
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

  var blockPattern3 = /var\s+\w+\s*=\s*['"]([^'"]+)['"]\s*,\s*\w+\s*=\s*atob\(['"]([^'"]+)['"]\)/g;
  while ((match = blockPattern3.exec(html)) !== null) {
    var key3 = match[1];
    var encoded3 = match[2];
    try {
      var decoded3 = xorDecode(key3, encoded3);
      if (decoded3) results.push(decoded3);
    } catch (e) { }
  }

  return results.length > 0 ? results.join('\n') : null;
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
