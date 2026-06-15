/* Vidxgo (vd) provider - Nuvio plugin
 * Movies and TV series. XOR-decodes blocks to extract master.m3u8 URL.
 */
var Buffer = typeof Buffer !== 'undefined' ? Buffer : require('buffer').Buffer;

var TMDB_API_KEY = '68e094699525b18a70bab2f86b1fa706';

function _vdTmdbToImdb(tmdbId, type) {
  return new Promise(function(resolve) {
    if (/^tt\d+$/.test(tmdbId)) {
      return resolve(tmdbId);
    }
    // If it's a numeric ID, fetch from TMDB
    var endpoint = type === 'series' || type === 'tv'
      ? 'https://api.themoviedb.org/3/tv/' + tmdbId + '/external_ids?api_key=' + TMDB_API_KEY
      : 'https://api.themoviedb.org/3/movie/' + tmdbId + '?api_key=' + TMDB_API_KEY;
      
    fetch(endpoint, { timeout: 10000 })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (data && data.imdb_id) {
          resolve(data.imdb_id);
        } else if (data && data.external_ids && data.external_ids.imdb_id) {
          resolve(data.external_ids.imdb_id);
        } else {
          resolve(null);
        }
      })
      .catch(function() { resolve(null); });
  });
}

function getStreams(id, type, season, episode) {
  try {
    var fs = require('fs');
    var logMsg = new Date().toISOString() + ': getStreams called with id=' + id + ' type=' + type + '\n';
    fs.appendFileSync('vd_run_log.txt', logMsg);
  } catch(e) {}

  return new Promise(function (resolve, reject) {
    try {
      var fs = require('fs');
      fs.appendFileSync('vd_run_log.txt', new Date().toISOString() + ': Promise executor started\n');
    } catch(e) {}

    var cleanId = String(id || '').replace(/^tmdb:/, '');
    var mediaType = String(type || 'movie').toLowerCase();
    var isSeries = mediaType === 'series' || mediaType === 'tv';

    var globalImdbId = (typeof __imdb_id !== 'undefined' && /^tt\d+$/.test(__imdb_id)) ? __imdb_id : null;
    var getImdbIdPromise;
    
    if (globalImdbId) {
      try {
        var fs = require('fs');
        fs.appendFileSync('vd_run_log.txt', new Date().toISOString() + ': Using global __imdb_id: ' + globalImdbId + '\n');
      } catch(e) {}
      getImdbIdPromise = Promise.resolve(globalImdbId);
    } else {
      getImdbIdPromise = _vdTmdbToImdb(cleanId, isSeries ? 'series' : 'movie');
    }

    getImdbIdPromise.then(function(imdbId) {
      if (!imdbId) {
        imdbId = cleanId;
      }
      
      try {
        var fs = require('fs');
        fs.appendFileSync('vd_run_log.txt', new Date().toISOString() + ': Resolved IMDb ID: ' + imdbId + '\n');
      } catch(e) {}

      var vdDomain = 'https://v.vidxgo.co';
      var pageUrl;
      if (isSeries) {
        var seasonNum = Number(season) || 1;
        var episodeNum = Number(episode) || 1;
        pageUrl = vdDomain + '/' + imdbId + '/' + seasonNum + '/' + episodeNum;
      } else {
        pageUrl = vdDomain + '/' + imdbId;
      }

      try {
        var fs = require('fs');
        fs.appendFileSync('vd_run_log.txt', new Date().toISOString() + ': fetchVidxgoPage starting for ' + pageUrl + '\n');
      } catch(e) {}

      fetchVidxgoPage(pageUrl, function (err, html) {
        try {
          var fs = require('fs');
          var logMsg = new Date().toISOString() + ': fetchVidxgoPage finished: err=' + (err ? err.message : 'null') + ' htmlLength=' + (html ? html.length : 0) + ' preview=' + (html ? html.substring(0, 200).replace(/\n/g, ' ') : '') + '\n';
          fs.appendFileSync('vd_run_log.txt', logMsg);
        } catch(e) {}

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
        var streamUrl = buildProxyUrl(masterUrl);

        var stream = {
          name: 'Vidxgo',
          title: 'Vidxgo' + (isSeries ? (' S' + (Number(season) || 1) + 'E' + (Number(episode) || 1)) : ''),
          url: streamUrl,
          behaviorHints: {
            notWebReady: true,
            bingeGroup: 'vidxgo-' + imdbId
          }
        };

        if (subtitles && subtitles.length > 0) {
          stream.subtitles = subtitles;
        }

        resolve([stream]);
      });
    });
  });
}

function fetchVidxgoPage(url, cb) {
  var proxyUrl = 'https://vidclick.leanhhu061208-775.workers.dev/?url=' + encodeURIComponent(url);
  var headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-CH-UA': '"Chromium";v="137", "Google Chrome";v="137", "Not/A)Brand";v="24"',
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': '"Windows"',
    'Sec-CH-UA-Model': '""',
    'Sec-CH-UA-Platform-Version': '"15.0.0"',
    'Sec-CH-UA-Full-Version-List': '"Chromium";v="137.0.7151.104", "Google Chrome";v="137.0.7151.104", "Not/A)Brand";v="24.0.0.0"',
    'Referer': 'https://altadefinizione.you/',
    'Sec-GPC': '1',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'iframe',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'cross-site'
  };
  fetch(proxyUrl, { headers: headers, timeout: 20000 })
    .then(function (r) { return r.text(); })
    .then(function (html) { cb(null, html); })
    .catch(function (err) { cb(err, null); });
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
    } catch (e) {}
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
      } catch (e) {}
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
  } catch (e) {}

  // Look for direct m3u8 URLs in page
  try {
    var m3u8Match = html.match(/https?:\/\/[^"'\s]*master\.m3u8[^"'\s]*/);
    if (m3u8Match) return m3u8Match[0];
  } catch (e) {}

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

function buildProxyUrl(masterUrl) {
  return '/clone/manifest.m3u8?d=' + encodeB64Url(masterUrl);
}

module.exports = { getStreams: getStreams };
