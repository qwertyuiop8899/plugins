/* Filmez provider - Nuvio plugin
 * Only movies. Searches filmez.club, resolves uprot links to actual streams.
 */
function getStreams(id, type, season, episode) {
  console.log("[Filmez-DEBUG] getStreams id=" + id + " type=" + type + " __imdb_id=" + (typeof __imdb_id !== 'undefined' ? __imdb_id : 'undef'));
  return new Promise(function (resolve, reject) {
    if (String(type || '').toLowerCase() !== 'movie') return resolve([]);
    var tmdbId = String(id || '').replace(/^tmdb:/, '');
    var imdbId = (typeof __imdb_id !== 'undefined' ? __imdb_id : tmdbId);

    console.log("[Filmez-DEBUG] fetching Cinemeta for " + imdbId);
    getCinemetaMeta('movie', imdbId, function (err, meta) {
      if (err) console.log("[Filmez-DEBUG] Cinemeta err: " + err);
      if (!meta || !meta.name) {
        console.log("[Filmez-DEBUG] Cinemeta no meta: " + JSON.stringify(meta));
        return resolve([]);
      }
      console.log("[Filmez-DEBUG] Cinemeta OK: " + meta.name + " (" + meta.releaseInfo + ")");
      var title = meta.name;
      var year = meta.releaseInfo || '';

      console.log("[Filmez-DEBUG] searching filmez for: " + title + " " + year);
      searchFilmez(title, year, function (pageUrl) {
        if (!pageUrl) {
          console.log("[Filmez-DEBUG] searchFilmez returned null");
          return resolve([]);
        }
        console.log("[Filmez-DEBUG] found page: " + pageUrl);
        extractUprotFromPage(pageUrl, function (uprotUrl) {
          if (!uprotUrl) {
            console.log("[Filmez-DEBUG] no uprot URL on page");
            return resolve([]);
          }
          console.log("[Filmez-DEBUG] found uprot: " + uprotUrl);
          resolveUprot(uprotUrl, function (resolved) {
            if (!resolved || !resolved.url) {
              console.log("[Filmez-DEBUG] resolveUprot failed, fallback to raw uprot");
              var tag = uprotTag(uprotUrl);
              return resolve([{
                name: 'Filmez',
                title: 'Maxstream [' + tag + ']',
                url: uprotUrl,
                behaviorHints: { notWebReady: true, bingeGroup: 'filmez-' + imdbId }
              }]);
            }
            console.log("[Filmez-DEBUG] resolved URL: " + resolved.url);
            var streamUrl = resolved.url;
            if (streamUrl.indexOf('.m3u8') !== -1) {
              streamUrl = '/nuvio/m3u8-proxy?url=' + encodeURIComponent(streamUrl) + '&headers=' + encodeURIComponent(JSON.stringify(resolved.headers || {}));
            }
            resolve([{
              name: 'Filmez',
              title: resolved.label || 'Maxstream',
              url: streamUrl,
              behaviorHints: { notWebReady: true, bingeGroup: 'filmez-' + imdbId }
            }]);
          });
        });
      });
    });
  });
}

function getCinemetaMeta(type, imdbId, cb) {
  var url = 'https://v3-cinemeta.strem.io/meta/' + type + '/' + imdbId + '.json';
  fetch(url, { timeout: 15000 })
    .then(function (r) { console.log("[Filmez-DEBUG] Cinemeta status: " + r.status); return r.ok ? r.json() : null; })
    .then(function (data) { cb(null, data && data.meta ? data.meta : null); })
    .catch(function (e) { console.log("[Filmez-DEBUG] Cinemeta fetch error: " + (e && e.message ? e.message : e)); cb(null, null); });
}

function filmezFetch(url, cb) {
  var headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': 'https://filmez.club/'
  };
  fetch(url, { headers: headers, timeout: 20000 })
    .then(function (r) { return r.text(); })
    .then(function (html) { cb(null, html); })
    .catch(function (err) { console.log("[Filmez-DEBUG] fetch error for " + url + ": " + (err && err.message ? err.message : err)); cb(err, null); });
}

function searchFilmez(title, year, cb) {
  var query = title + (year ? ' ' + year : '');
  console.log("[Filmez-DEBUG] searchFilmez query: " + query);
  filmezFetch('https://filmez.club/?s=' + encodeURIComponent(query), function (err, html) {
    if (err || !html) {
      console.log("[Filmez-DEBUG] searchFilmez fetch returned err=" + !!err + " html=" + (html ? html.length : 0));
      return cb(null);
    }
    console.log("[Filmez-DEBUG] search response length: " + html.length);

    var hrefMatch = html.match(/<a[^>]+href=["'](https?:\/\/filmez\.club\/film\/[^"']+\/)["'][^>]*>/gi);
    if (!hrefMatch) {
      console.log("[Filmez-DEBUG] no film links found, trying alternate pattern");
      var altMatch = html.match(/href=["'](https?:\/\/filmez\.club\/[^"']+\/)["']/gi);
      if (altMatch) console.log("[Filmez-DEBUG] alt links: " + altMatch.length);
      return cb(null);
    }
    console.log("[Filmez-DEBUG] found " + hrefMatch.length + " candidate links");

    var candidates = [];
    var seen = {};
    hrefMatch.forEach(function (a) {
      var m = a.match(/href=["']([^"']+)["']/);
      if (m && !seen[m[1]]) { seen[m[1]] = true; candidates.push(m[1]); }
    });
    if (candidates.length === 0) return cb(null);
    console.log("[Filmez-DEBUG] using candidate: " + candidates[0]);
    cb(candidates[0]);
  });
}

function extractUprotFromPage(pageUrl, cb) {
  filmezFetch(pageUrl, function (err, html) {
    if (err || !html) return cb(null);
    var m = html.match(/https?:\/\/uprot\.net\/(?:msf|mse)\/[A-Za-z0-9_-]+/i);
    console.log("[Filmez-DEBUG] uprot found: " + (m ? m[0] : "none"));
    cb(m ? m[0] : null);
  });
}

function resolveUprot(uprotUrl, cb) {
  var headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': 'https://filmez.club/'
  };
  fetch(uprotUrl, { headers: headers, timeout: 30000 })
    .then(function (r) { return r.text(); })
    .then(function (html) {
      if (!html) return cb(null);
      var m3u8Match = html.match(/https?:\/\/[^"'\s<]*\.m3u8[^"'\s<]*/i);
      if (m3u8Match) return cb({ url: m3u8Match[0], label: 'Maxstream', headers: headers });
      var mp4Match = html.match(/https?:\/\/[^"'\s<]*\.mp4[^"'\s<]*/i);
      if (mp4Match) return cb({ url: mp4Match[0], label: 'Maxstream', headers: headers });
      var iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
      if (iframeMatch) {
        return resolveUprot(iframeMatch[1], function (result) {
          if (result) return cb(result);
          cb({ url: iframeMatch[1], label: 'Maxstream', headers: headers });
        });
      }
      cb(null);
    })
    .catch(function () { cb(null); });
}

function uprotTag(url) {
  var m = url.match(/\/\/([^/]+)\/([^/]+)\//);
  return m ? m[2] : 'uprot';
}

module.exports = { getStreams: getStreams };
