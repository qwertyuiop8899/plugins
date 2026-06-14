/* Vidxgo (vd) provider - Nuvio plugin
 * Movies and TV series. XOR-decodes blocks to extract master.m3u8 URL.
 * Stream URL proxied through m3u8-proxy for playlist rewriting and segment proxying.
 */
function getStreams(id, type, season, episode) {
  return new Promise(function (resolve, reject) {
    var tmdbId = String(id || '').replace(/^tmdb:/, '');
    var imdbId = tmdbId;
    var mediaType = String(type || 'movie').toLowerCase();
    var isSeries = mediaType === 'series' || mediaType === 'tv';
    var vdId = imdbId;

    // Build vidxgo page URL (Vidxgo uses TMDB IDs directly)
    var vdDomain = 'https://v.vidxgo.co';
    var pageUrl;
    if (isSeries) {
      var seasonNum = Number(season) || 1;
      var episodeNum = Number(episode) || 1;
      pageUrl = vdDomain + '/' + vdId + '/' + seasonNum + '/' + episodeNum;
    } else {
      pageUrl = vdDomain + '/' + vdId;
    }

    fetchVidxgoPage(pageUrl, function (err, html) {
        if (err || !html) return resolve([]);

        var decoded = decodeXorBlocks(html);
        if (!decoded) return resolve([]);

        var masterUrl = extractMasterUrl(decoded);
        if (!masterUrl) return resolve([]);

        var subtitles = extractSubtitles(decoded);

        // Create stream URL via m3u8-proxy
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
}

function getCinemetaMeta(type, imdbId, cb) {
  var url = 'https://v3-cinemeta.strem.io/meta/' + type + '/' + imdbId + '.json';
  fetch(url, { timeout: 10000 })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) { cb(null, data && data.meta ? data.meta : null); })
    .catch(function () { cb(null, null); });
}

function fetchVidxgoPage(url, cb) {
  var headers = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://altadefinizione.you/',
    'Sec-GPC': '1',
    'DNT': '1'
  };
  fetch(url, { headers: headers, timeout: 20000 })
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

function buildProxyUrl(masterUrl) {
  // Use the m3u8-proxy endpoint for playlist rewriting and segment proxying
  // This URL will be processed by our server's /nuvio/m3u8-proxy handler
  var headers = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://v.vidxgo.co/',
    'Origin': 'https://v.vidxgo.co',
    'DNT': '1'
  };
  var headersB64 = Buffer.from(JSON.stringify(headers)).toString('base64');
  return '/nuvio/m3u8-proxy?url=' + encodeURIComponent(masterUrl) + '&headers=' + encodeURIComponent(JSON.stringify(headers));
}

module.exports = { getStreams: getStreams };
