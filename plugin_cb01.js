/* CB01 provider - Nuvio plugin
 * Movies and TV series. Searches cb01uno, resolves stayonline.pro links.
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
        resolveLinksFromPage(pageUrl, function (streams) {
          if (!streams || streams.length === 0) return resolve([]);

          // For each stream that has a stayonline URL, resolve it
          var remaining = streams.length;
          streams.forEach(function (s) {
            if (s.__stayonline) {
              resolveStayonline(s.__stayonline, 'CB01', meta, mediaType, season, episode, function (resolvedUrl) {
                s.url = resolvedUrl || s.__stayonline;
                delete s.__stayonline;
                remaining--;
                if (remaining <= 0) resolve(cleanStreams(streams));
              });
            } else {
              remaining--;
              if (remaining <= 0) resolve(cleanStreams(streams));
            }
          });
          if (remaining <= 0) resolve(cleanStreams(streams));
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
  // Determine search path
  var isSeries = mediaType === 'series' || mediaType === 'tv';
  var searchPath = isSeries ? 'serietv/' : '';
  var searchUrl = 'https://cb01uno.sbs/' + searchPath + '?s=' + encodeURIComponent(title);
  
  cb01Fetch(searchUrl, function (err, html) {
    if (err || !html) {
      // Try fallback domain
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
  // Extract article links with titles
  var entryPattern = /<article[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/article>/gi;
  var match;
  var candidates = [];
  var lowerTitle = title.toLowerCase();

  while ((match = entryPattern.exec(html)) !== null) {
    var href = match[1];
    var linkText = (match[2] || '').replace(/<[^>]+>/g, '').toLowerCase();
    var text = (linkText + ' ' + match[0].toLowerCase());
    
    // Score: title match + year match
    var score = 0;
    if (text.indexOf(lowerTitle) >= 0) score += 10;
    if (year && text.indexOf(String(year)) >= 0) score += 5;
    
    if (score > 0) {
      candidates.push({ url: href, score: score });
    }
  }

  // Also try to find links in post entries
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

function resolveLinksFromPage(pageUrl, cb) {
  cb01Fetch(pageUrl, function (err, html) {
    if (err || !html) return cb(null);
    var streams = [];
    var seen = {};

    // Find stayonline.pro links (the AJAX endpoint cb01 uses)
    var soPattern = /https?:\/\/stayonline\.pro\/[A-Za-z0-9_.-]+/gi;
    var soMatch;
    while ((soMatch = soPattern.exec(html)) !== null) {
      var soUrl = soMatch[0];
      if (!seen[soUrl]) {
        seen[soUrl] = true;
        streams.push({ __stayonline: soUrl });
      }
    }

    // If no stayonline, look for direct uprot/mixdrop links
    if (streams.length === 0) {
      var directPattern = /https?:\/\/(?:uprot\.net\/(?:msf|mse)\/[A-Za-z0-9_-]+|mixdrop\.[a-z]+\/[A-Za-z0-9]+)/gi;
      var dMatch;
      while ((dMatch = directPattern.exec(html)) !== null) {
        var url = dMatch[0];
        if (!seen[url]) {
          seen[url] = true;
          var isMixdrop = url.indexOf('mixdrop') >= 0;
          streams.push({
            url: isMixdrop ? '' : url,
            __mixdrop: isMixdrop ? url : null,
            title: isMixdrop ? 'Mixdrop' : 'Maxstream'
          });
        }
      }
    }

    // Also find links from stayonline post-requests (embedded in JS)
    var ajaxPattern = /url:\s*["']([^"']+)["'][^}]*type:\s*["']POST["']/gi;
    var aMatch;
    while ((aMatch = ajaxPattern.exec(html)) !== null) {
      var ajaxUrl = aMatch[1];
      if (ajaxUrl.indexOf('stayonline') >= 0 && !seen[ajaxUrl]) {
        seen[ajaxUrl] = true;
        streams.push({ __stayonline: ajaxUrl });
      }
    }

    cb(streams.length > 0 ? streams : null);
  });
}

function resolveStayonline(soUrl, provider, meta, mediaType, season, episode, cb) {
  // stayonline.pro expects a POST with the URL and returns playback links
  var postData = 'url=' + encodeURIComponent(soUrl);
  
  var headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept': '*/*',
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': 'https://cb01uno.sbs/'
  };

  fetch(soUrl, {
    method: 'POST',
    headers: headers,
    body: postData,
    timeout: 15000
  })
    .then(function (r) { return r.text(); })
    .then(function (text) {
      // stayonline returns a JSON or redirect with links
      try {
        var data = JSON.parse(text);
        var link = data.link || data.url || '';
        if (link) return cb(link);
      } catch (e) {}
      
      // Check for uprot/mixdrop in response
      var uprotMatch = text.match(/(https?:\/\/uprot\.net\/(?:msf|mse)\/[A-Za-z0-9_-]+)/i);
      if (uprotMatch) return cb(uprotMatch[1]);
      
      var mdMatch = text.match(/(https?:\/\/mixdrop\.[a-z]+\/[A-Za-z0-9]+)/i);
      if (mdMatch) return cb(mdMatch[1]);
      
      cb(null);
    })
    .catch(function () { cb(null); });
}

function cleanStreams(streams) {
  return streams.filter(function (s) {
    delete s.__stayonline;
    delete s.__mixdrop;
    if (!s.url) return false;
    return true;
  }).map(function (s) {
    if (!s.name) s.name = 'CB01';
    if (!s.title) s.title = 'Stream';
    if (!s.behaviorHints) s.behaviorHints = {};
    return s;
  });
}

module.exports = { getStreams: getStreams };
