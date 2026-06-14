/* Filmez provider - Nuvio plugin
 * Only movies. Searches filmez.club, extracts uprot links.
 */
function getStreams(id, type, season, episode) {
  return new Promise(function (resolve, reject) {
    if (String(type || '').toLowerCase() !== 'movie') return resolve([]);
    var tmdbId = String(id || '').replace(/^tmdb:/, '');
    var imdbId = (typeof __imdb_id !== 'undefined' ? __imdb_id : tmdbId);

    getCinemetaMeta('movie', imdbId, function (err, meta) {
      var title = meta && meta.name ? meta.name : '';
      var year = meta && meta.releaseInfo ? meta.releaseInfo : '';
      if (!title) return resolve([]);

      searchFilmez(title, year, function (pageUrl) {
        if (!pageUrl) return resolve([]);
        extractUprotFromPage(pageUrl, function (uprotUrl) {
          if (!uprotUrl) return resolve([]);
          var tag = uprotTag(uprotUrl);
          resolve([{
            name: 'Filmez',
            title: 'Maxstream [' + tag + ']',
            url: uprotUrl,
            behaviorHints: { notWebReady: true, bingeGroup: 'filmez-' + imdbId }
          }]);
        });
      });
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

function filmezFetch(url, cb) {
  var headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': 'https://filmez.club/'
  };
  fetch(url, { headers: headers, timeout: 15000 })
    .then(function (r) { return r.text(); })
    .then(function (html) { cb(null, html); })
    .catch(function (err) { cb(err, null); });
}

function searchFilmez(title, year, cb) {
  var query = title + (year ? ' ' + year : '');
  filmezFetch('https://filmez.club/?s=' + encodeURIComponent(query), function (err, html) {
    if (err || !html) return cb(null);

    var hrefMatch = html.match(/<a[^>]+href=["'](https?:\/\/filmez\.club\/film\/[^"']+\/)["'][^>]*>/gi);
    if (!hrefMatch) return cb(null);

    var candidates = [];
    var seen = {};
    hrefMatch.forEach(function (a) {
      var m = a.match(/href=["']([^"']+)["']/);
      if (m && !seen[m[1]]) { seen[m[1]] = true; candidates.push(m[1]); }
    });

    if (candidates.length === 0) return cb(null);

    // Check first candidate - search for uprot links
    cb(candidates[0]);
  });
}

function extractUprotFromPage(pageUrl, cb) {
  filmezFetch(pageUrl, function (err, html) {
    if (err || !html) return cb(null);
    var m = html.match(/https?:\/\/uprot\.net\/(?:msf|mse)\/[A-Za-z0-9_-]+/i);
    cb(m ? m[0] : null);
  });
}

function uprotTag(url) {
  var m = url.match(/\/\/([^/]+)\/([^/]+)\//);
  return m ? m[2] : 'uprot';
}

module.exports = { getStreams: getStreams };
