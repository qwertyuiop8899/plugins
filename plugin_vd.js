/* Vidxgo (vd) provider - Nuvio plugin
 * Movies and TV series. XOR-decodes blocks to extract master.m3u8 URL.
 */
var Buffer = typeof Buffer !== 'undefined' ? Buffer : require('buffer').Buffer;

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
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': VD_DOMAIN + '/',
  'Sec-GPC': '1',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'iframe',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'same-origin',
  'DNT': '1'
};

function getVidxgoHostUrl(explicitHost) {
  var value = explicitHost || '';
  if (!value && typeof globalThis !== 'undefined') {
    value = globalThis.HOST_URL || globalThis.host_url || '';
  }
  if (!value && typeof process !== 'undefined' && process.env) {
    value = process.env.HOST_URL || '';
  }
  return String(value || 'https://toastflix.stremio-italia.eu').replace(/\/+$/, '');
}

function _vdTmdbToImdb(tmdbId, type) {
  return new Promise(function (resolve) {
    if (/^tt\d+$/.test(tmdbId)) {
      return resolve(tmdbId);
    }
    // If it's a numeric ID, fetch from TMDB
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

function getStreams(id, type, season, episode, hostUrl) {
  return new Promise(function (resolve, reject) {
    var cloneHost = getVidxgoHostUrl(hostUrl);
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

        resolveVidxgoMasterUrl(masterUrl).then(function (resolvedMasterUrl) {
          var streamUrl = buildProxyUrl(resolvedMasterUrl || masterUrl, cloneHost);

          var stream = {
            name: 'Vidxgo',
            title: 'Vidxgo' + (isSeries ? (' S' + (Number(season) || 1) + 'E' + (Number(episode) || 1)) : ''),
            url: streamUrl,
            quality: "1080",
            behaviorHints: {
              notWebReady: true,
              proxyHeaders: { request: VD_M3U8_HEADERS },
              bingeGroup: 'vidxgo-' + imdbId
            }
          };

          if (subtitles && subtitles.length > 0) {
            stream.subtitles = subtitles;
          }

          resolve([stream]);
        }).catch(function () {
          // Preserve the previous output as a last-resort fallback. The clone
          // endpoint may still be able to refresh the media ID server-side.
          var fallbackStream = {
            name: 'Vidxgo',
            title: 'Vidxgo' + (isSeries ? (' S' + (Number(season) || 1) + 'E' + (Number(episode) || 1)) : ''),
            url: buildProxyUrl(masterUrl, cloneHost),
            quality: "1080",
            behaviorHints: {
              notWebReady: true,
              proxyHeaders: { request: VD_M3U8_HEADERS },
              bingeGroup: 'vidxgo-' + imdbId
            }
          };
          if (subtitles && subtitles.length > 0) {
            fallbackStream.subtitles = subtitles;
          }
          resolve([fallbackStream]);
        });
      });
    });
  });
}

function fetchVidxgoPage(url, cb) {
  fetch(url, { headers: VD_PAGE_HEADERS, timeout: 20000 })
    .then(function (r) { return r.text(); })
    .then(function (html) { cb(null, html); })
    .catch(function (err) { cb(err, null); });
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
  return fetch(masterUrl, {
    headers: VD_M3U8_HEADERS,
    timeout: 12000
  }).then(function (response) {
    if (!response.ok) return false;
    return response.text().then(function (text) {
      return String(text || '').trim().indexOf('#EXTM3U') === 0;
    });
  }).catch(function () {
    // Includes TLS/certificate failures from obsolete Vidxgo proxy hosts.
    return false;
  });
}

function refreshVidxgoMaster(mediaId) {
  if (!mediaId) return Promise.resolve(null);

  var refreshUrl = VD_DOMAIN + '/t/' + mediaId;
  var headers = Object.assign({}, VD_M3U8_HEADERS, {
    'Referer': refreshUrl,
    'Sec-Fetch-Site': 'same-origin'
  });

  return fetch(refreshUrl, {
    headers: headers,
    timeout: 12000
  }).then(function (response) {
    if (!response.ok) return null;
    return response.json().then(function (data) {
      if (!data || !data.url) return null;
      return String(data.url).replace(/\\/g, '');
    }).catch(function () {
      return null;
    });
  }).catch(function () {
    return null;
  });
}

function resolveVidxgoMasterUrl(masterUrl) {
  return probeVidxgoMaster(masterUrl).then(function (isValid) {
    if (isValid) return masterUrl;

    var mediaId = extractVidxgoMediaId(masterUrl);
    if (!mediaId) return masterUrl;

    return refreshVidxgoMaster(mediaId).then(function (freshUrl) {
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
  // Pattern 1: (function(){var k='KEY',d=atob('ENCODED')
  var blockPattern = /\(function\(\)\{var\s+k=['"]([^'"]+)['"]\s*,\s*d=atob\(['"]([^'"]+)['"]\)/g;
  var match;
  var results = [];

  while ((match = blockPattern.exec(html)) !== null) {
    var key = match[1];
    var encoded = match[2];
    try {
      var decoded = xorDecode(key, encoded);
      if (decoded) results.push(decoded);
    } catch (e) { }
  }

  // Pattern 2: var XXX='KEY',d=atob('ENCODED')
  if (results.length === 0) {
    var blockPattern2 = /var\s+\w+\s*=\s*['"]([^'"]+)['"]\s*,\s*d\s*=\s*atob\(['"]([^'"]+)['"]\)/g;
    while ((match = blockPattern2.exec(html)) !== null) {
      var key2 = match[1];
      var encoded2 = match[2];
      try {
        var decoded2 = xorDecode(key2, encoded2);
        if (decoded2) results.push(decoded2);
      } catch (e) { }
    }
  }

  return results.join('\n');
}

function tryFallbackDecode(html) {
  // Try to find inline JSON with stream data
  try {
    var jsonMatch = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>(.*?)<\/script>/s);
    if (jsonMatch) {
      var data = JSON.parse(jsonMatch[1]);
      return JSON.stringify(data);
    }
  } catch (e) { }

  // Look for direct m3u8 URLs in page
  try {
    var m3u8Match = html.match(/https?:\/\/[^"'\s]*master\.m3u8[^"'\s]*/);
    if (m3u8Match) return m3u8Match[0];
  } catch (e) { }

  return null;
}

function extractMasterUrl(decodedJs) {
  // Pattern 1: currentSrc='...master.m3u8...'
  var p1 = decodedJs.match(/currentSrc\s*=\s*['"]([^'"]*master\.m3u8[^'"]*)['"]/);
  if (p1) return p1[1].replace(/\\/g, '');

  // Pattern 2: escaped URL with master.m3u8
  var p2 = decodedJs.match(/['"](https?:\\?\/\\?\/[^'"]*master\.m3u8[^'"]*)['"]/);
  if (p2) return p2[1].replace(/\\/g, '');

  // Pattern 3: any m3u8 URL
  var p3 = decodedJs.match(/['"](https?:\\?\/\\?\/[^'"]*\.m3u8[^'"]*)['"]/);
  if (p3) return p3[1].replace(/\\/g, '');

  // Pattern 4: direct m3u8 URL without quotes
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

function buildProxyUrl(masterUrl, hostUrl) {
  return getVidxgoHostUrl(hostUrl) + '/clone/manifest.m3u8?d=' + encodeB64Url(masterUrl);
}

module.exports = { getStreams: getStreams };
