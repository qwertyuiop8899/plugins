/* CB01 provider - Nuvio plugin
 * Movies and TV series. Searches cb01uno, extracts MixDrop links only.
 */
function getStreams(id, type, season, episode) {
  return new Promise(function (resolve, reject) {
    var tmdbId = String(id || '').replace(/^tmdb:/, '');
    var imdbId = (typeof __imdb_id !== 'undefined' ? __imdb_id : tmdbId);
    var mediaType = String(type || 'movie').toLowerCase();

    var cinemetaType = mediaType === 'tv' ? 'series' : mediaType;
    getCinemetaMeta(cinemetaType, imdbId, function (err, meta) {
      if (!meta || !meta.name) return resolve([]);
      var title = meta.name;
      var year = meta.releaseInfo || '';

      searchCB01(title, year, mediaType, season, episode, meta, function (pageUrl) {
        if (!pageUrl) return resolve([]);
        extractMixDropFromPage(pageUrl, function (streams) {
          resolve(streams || []);
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

function cb01Fetch(url, cb) {
  var headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': 'https://cb01uno.sbs/'
  };
  fetch(url, { headers: headers, timeout: 15000 })
    .then(function (r) { return r.text(); })
    .then(function (html) { cb(null, html); })
    .catch(function (err) { cb(err, null); });
}

function searchCB01(title, year, mediaType, season, episode, meta, cb) {
  var isSeries = mediaType === 'series' || mediaType === 'tv';
  var searchPath = isSeries ? 'serietv/' : '';
  var searchUrl = 'https://cb01uno.sbs/' + searchPath + '?s=' + encodeURIComponent(title);
  
  cb01Fetch(searchUrl, function (err, html) {
    if (err || !html) {
      cb01Fetch('https://cb01uno.mom/' + searchPath + '?s=' + encodeURIComponent(title), function (err2, html2) {
        if (err2 || !html2) return cb(null);
        findBestMatch(html2, title, year, mediaType, cb);
      });
      return;
    }
    findBestMatch(html, title, year, mediaType, cb);
  });
}

function findBestMatch(html, title, year, mediaType, cb) {
  var entryPattern = /<article[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/article>/gi;
  var match;
  var candidates = [];
  var lowerTitle = title.toLowerCase();

  while ((match = entryPattern.exec(html)) !== null) {
    var href = match[1];
    var linkText = (match[2] || '').replace(/<[^>]+>/g, '').toLowerCase();
    var text = (linkText + ' ' + match[0].toLowerCase());
    
    var score = 0;
    if (text.indexOf(lowerTitle) >= 0) score += 10;
    if (year && text.indexOf(String(year)) >= 0) score += 5;
    
    if (score > 0) {
      candidates.push({ url: href, score: score });
    }
  }

  if (candidates.length === 0) {
    var allLinks = html.match(/<a[^>]+href=["'](https?:\/\/cb01uno[^"']+\/\d+\/[^"']+)["'][^>]*>/gi);
    if (allLinks) {
      allLinks.forEach(function (a) {
        var m = a.match(/href=["']([^"']+)["']/);
        var text = a.toLowerCase();
        var score = 0;
        if (text.indexOf(lowerTitle) >= 0) score += 10;
        if (year && text.indexOf(String(year)) >= 0) score += 5;
        if (score > 0) {
          candidates.push({ url: m[1], score: score });
        }
      });
    }
  }

  if (candidates.length === 0) return cb(null);
  candidates.sort(function (a, b) { return b.score - a.score; });
  cb(candidates[0].url);
}

function extractMixDropFromPage(pageUrl, cb) {
  cb01Fetch(pageUrl, function (err, html) {
    if (err || !html) return cb(null);
    var streams = [];
    var seen = {};

    // Find mixdrop links
    var mdPattern = /https?:\/\/(?:mixdrop|m1xdrop|mxdrop)\.[a-z]+\/[A-Za-z0-9]+/gi;
    var mdMatch;
    while ((mdMatch = mdPattern.exec(html)) !== null) {
      var mdUrl = mdMatch[0];
      if (!seen[mdUrl]) {
        seen[mdUrl] = true;
        streams.push({
          url: mdUrl,
          name: 'CB01',
          title: 'MixDrop',
          behaviorHints: { notWebReady: true }
        });
      }
    }

    // Also find mixdrop in script blocks / data attributes
    var mdDataPattern = /["'](https?:\/\/(?:mixdrop|m1xdrop|mxdrop)\.[a-z]+\/[A-Za-z0-9]+)["']/gi;
    var mdDataMatch;
    while ((mdDataMatch = mdDataPattern.exec(html)) !== null) {
      var mdDataUrl = mdDataMatch[1];
      if (!seen[mdDataUrl]) {
        seen[mdDataUrl] = true;
        streams.push({
          url: mdDataUrl,
          name: 'CB01',
          title: 'MixDrop',
          behaviorHints: { notWebReady: true }
        });
      }
    }

    cb(streams.length > 0 ? streams : null);
  });
}

module.exports = { getStreams: getStreams };
