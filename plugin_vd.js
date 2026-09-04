/* Vidxgo (vd) provider - standalone Nuvio/Stremio plugin
 * Movies and TV series. XOR-decodes blocks to extract a direct master.m3u8 URL.
 * ROBUST VERSION:
 *  - Native https.get with altadefinizionex.live referer to bypass Cloudflare 403
 *  - Multi-tier TMDb -> IMDb resolution (https.get + fetch + Cinemeta fallback)
 *  - Automatic redirect following (301/302/307/308)
 *  - Detailed [VidXgo] logging visible in server logs
 *  - Direct CDN master URL for 0% VPS bandwidth
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

function _vdLog() {
  try {
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[VidXgo]');
    console.log.apply(console, args);
  } catch (e) {}
}

function _vdTmdbToImdb(tmdbId, type) {
  return new Promise(function (resolve) {
    if (!tmdbId) return resolve(null);
    if (/^tt\d+$/.test(tmdbId)) {
      return resolve(tmdbId);
    }

    var isSeries = type === 'series' || type === 'tv';
    var tmdbUrl = isSeries
      ? 'https://api.themoviedb.org/3/tv/' + tmdbId + '/external_ids?api_key=' + TMDB_API_KEY
      : 'https://api.themoviedb.org/3/movie/' + tmdbId + '?api_key=' + TMDB_API_KEY;

    // 1. Try https.get first
    if (https && https.get) {
      try {
        https.get(tmdbUrl, { timeout: 8000 }, function (res) {
          if (res.statusCode === 200) {
            var d = '';
            res.on('data', function (c) { d += c; });
            res.on('end', function () {
              try {
                var j = JSON.parse(d);
                var imdb = j.imdb_id || (j.external_ids && j.external_ids.imdb_id);
                if (imdb && /^tt\d+$/.test(imdb)) return resolve(imdb);
              } catch (pe) {}
              tryFetchOrCinemeta();
            });
            return;
          }
          tryFetchOrCinemeta();
        }).on('error', function () {
          tryFetchOrCinemeta();
        });
        return;
      } catch (e) {}
    }

    tryFetchOrCinemeta();

    function tryFetchOrCinemeta() {
      // 2. Try fetch()
      if (typeof fetch !== 'undefined') {
        fetch(tmdbUrl, { timeout: 8000 })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (data) {
            var imdb = data && (data.imdb_id || (data.external_ids && data.external_ids.imdb_id));
            if (imdb && /^tt\d+$/.test(imdb)) {
              return resolve(imdb);
            }
            tryCinemetaFallback();
          })
          .catch(function () {
            tryCinemetaFallback();
          });
      } else {
        tryCinemetaFallback();
      }
    }

    function tryCinemetaFallback() {
      // 3. Cinemeta fallback
      var metaType = isSeries ? 'series' : 'movie';
      var cinemetaUrl = 'https://v3-cinemeta.strem.io/meta/' + metaType + '/' + tmdbId + '.json';
      if (typeof fetch !== 'undefined') {
        fetch(cinemetaUrl, { timeout: 6000 })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (metaData) {
            var imdb = metaData && metaData.meta && metaData.meta.imdb_id;
            if (imdb && /^tt\d+$/.test(imdb)) return resolve(imdb);
            resolve(null);
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
    try {
      return crypto.createHash('md5').update(str).digest('hex');
    } catch (e) {}
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
    _vdLog('getStreams invoked with id=' + id + ' type=' + type + ' s=' + season + ' e=' + episode);

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
      _vdLog('Target IMDb ID resolved to:', imdbId);

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
          _vdLog('Failed to fetch embed page:', err ? err.message : 'no html');
          return resolve([]);
        }

        var decoded = decodeXorBlocks(html) || tryFallbackDecode(html);
        if (!decoded) {
          _vdLog('Failed to XOR-decode page blocks');
          return resolve([]);
        }

        var masterUrl = extractMasterUrl(decoded);
        if (!masterUrl) {
          _vdLog('No master.m3u8 URL found in decoded JS');
          return resolve([]);
        }
        _vdLog('Extracted raw masterUrl:', masterUrl);

        var subtitles = extractSubtitles(decoded);

        resolveMasterRedirect(masterUrl).then(function (finalMaster) {
          _vdLog('Final resolved master URL:', finalMaster);
          var mediaId = extractVidxgoMediaId(finalMaster) || (isSeries ? (imdbId + '/' + season + '/' + episode) : imdbId);
          var bgBase = 'vidxgo-' + md5hex(mediaId).slice(0, 12);

          fetchMasterPlaylist(finalMaster).then(function (m3u8Content) {
            var isMultiAudio = false;
            if (m3u8Content) {
              isMultiAudio = hasMultipleAudioTracks(m3u8Content);
            }

            var streams = [];

            // Direct CDN stream (Primary - 0% VPS traffic)
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

            // Proxy / clone fallback
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

            _vdLog('Returning ' + streams.length + ' stream(s) for ' + imdbId);
            resolve(streams);
          });
        }).catch(function (resErr) {
          _vdLog('resolveMasterRedirect fallback due to error:', resErr ? resErr.message : '');
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

function fetchVidxgoPage(url, cb, redirects) {
  if (redirects === undefined) redirects = 3;
  _vdLog('Fetching page:', url);

  if (https && https.get) {
    try {
      https.get(url, { headers: VD_PAGE_HEADERS, timeout: 20000 }, function (res) {
        _vdLog('HTTP response code:', res.statusCode);
        // Follow 3xx redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          var nextUrl = res.headers.location;
          if (nextUrl.startsWith('/')) {
            try {
              var u = new URL(url);
              nextUrl = u.protocol + '//' + u.host + nextUrl;
            } catch (e) {}
          }
          _vdLog('Redirecting to:', nextUrl);
          return fetchVidxgoPage(nextUrl, cb, redirects - 1);
        }

        if (res.statusCode !== 200) {
          _vdLog('Non-200 code from https.get, trying fetch fallback...');
          return tryFetchFallback(url, cb);
        }

        var chunks = [];
        res.on('data', function (chunk) { chunks.push(chunk); });
        res.on('end', function () {
          var body = Buffer.concat(chunks).toString('utf-8');
          cb(null, body);
        });
      }).on('error', function (err) {
        _vdLog('https.get error:', err.message, 'trying fetch fallback...');
        tryFetchFallback(url, cb);
      });
      return;
    } catch (e) {
      _vdLog('https.get exception:', e.message);
    }
  }

  tryFetchFallback(url, cb);
}

function tryFetchFallback(url, cb) {
  if (typeof fetch === 'undefined') return cb(new Error('Neither https nor fetch is available'), null);
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
    return mediaParts.join('/');
  } catch (e) {
    return null;
  }
}

function resolveMasterRedirect(url) {
  return new Promise(function (resolve) {
    fetch(url, {
      method: 'GET',
      headers: VD_M3U8_HEADERS,
      redirect: 'follow',
      timeout: 15000
    }).then(function (r) {
      resolve(r.url || url);
    }).catch(function () {
      resolve(url);
    });
  });
}

function fetchMasterPlaylist(url) {
  return new Promise(function (resolve) {
    fetch(url, {
      headers: VD_M3U8_HEADERS,
      timeout: 10000
    }).then(function (r) {
      if (!r.ok) return resolve(null);
      return r.text();
    }).then(function (text) {
      resolve(text || null);
    }).catch(function () {
      resolve(null);
    });
  });
}

function hasMultipleAudioTracks(m3u8Text) {
  if (!m3u8Text) return false;
  var audioGroupMatches = m3u8Text.match(/#EXT-X-MEDIA:TYPE=AUDIO/g);
  if (audioGroupMatches && audioGroupMatches.length > 1) {
    return true;
  }
  var audioMatches = m3u8Text.match(/#EXT-X-STREAM-INF:[^\n]*AUDIO="([^"]+)"/g);
  if (audioMatches && audioMatches.length > 1) {
    var groups = {};
    for (var i = 0; i < audioMatches.length; i++) {
      var m = audioMatches[i].match(/AUDIO="([^"]+)"/);
      if (m && m[1]) groups[m[1]] = true;
    }
    return Object.keys(groups).length > 1;
  }
  return false;
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
  try {
    var results = [];
    var match;

    var p1 = /\(function\(\)\{var\s+k=['"]([^'"]+)['"]\s*,\s*d=atob\(['"]([^'"]+)['"]\)/g;
    while ((match = p1.exec(html)) !== null) {
      var d1 = xorDecode(match[1], match[2]);
      if (d1) results.push(d1);
    }

    var p2 = /var\s+\w+\s*=\s*['"]([^'"]+)['"]\s*,\s*d\s*=\s*atob\(['"]([^'"]+)['"]\)/g;
    while ((match = p2.exec(html)) !== null) {
      var d2 = xorDecode(match[1], match[2]);
      if (d2) results.push(d2);
    }

    var p3 = /var\s+\w+\s*=\s*['"]([^'"]+)['"]\s*,\s*\w+\s*=\s*atob\(['"]([^'"]+)['"]\)/g;
    while ((match = p3.exec(html)) !== null) {
      var d3 = xorDecode(match[1], match[2]);
      if (d3) results.push(d3);
    }

    if (results.length > 0) {
      return results.join('\n');
    }
  } catch (e) { }
  return null;
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
