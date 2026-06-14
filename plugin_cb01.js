/* CB01 provider - Nuvio plugin
 * Movies and TV series. Searches cb01uno, resolves stayonline.pro AND uprot URLs.
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

          var remaining = streams.length;
          streams.forEach(function (s) {
            var urlToResolve = s.__stayonline || s.__uprot || null;
            if (urlToResolve) {
              resolveUprot(urlToResolve, function (resolved) {
                if (resolved && resolved.url) {
                  s.url = resolved.url;
                  if (s.url.indexOf('.m3u8') !== -1) {
                    s.url = '/nuvio/m3u8-proxy?url=' + encodeURIComponent(s.url) + '&headers=' + encodeURIComponent(JSON.stringify(resolved.headers || {}));
                  }
                } else {
                  s.url = urlToResolve;
                }
                delete s.__stayonline;
                delete s.__uprot;
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

function resolveLinksFromPage(pageUrl, cb) {
  cb01Fetch(pageUrl, function (err, html) {
    if (err || !html) return cb(null);
    var streams = [];
    var seen = {};

    // Find stayonline.pro links
    var soPattern = /https?:\/\/stayonline\.pro\/[A-Za-z0-9_.-]+/gi;
    var soMatch;
    while ((soMatch = soPattern.exec(html)) !== null) {
      var soUrl = soMatch[0];
      if (!seen[soUrl]) {
        seen[soUrl] = true;
        streams.push({ __stayonline: soUrl, name: 'CB01', title: 'Stayonline' });
      }
    }

    // Find uprot links (msf/mse/msfi/msei patterns)
    var uprotPattern = /https?:\/\/uprot\.net\/(?:ms[efi]{2,3})\/[A-Za-z0-9_-]+/gi;
    var uMatch;
    while ((uMatch = uprotPattern.exec(html)) !== null) {
      var uUrl = uMatch[0];
      if (!seen[uUrl]) {
        seen[uUrl] = true;
        streams.push({ __uprot: uUrl, name: 'CB01', title: 'Uprot' });
      }
    }

    // Find mixdrop links
    var mdPattern = /https?:\/\/(?:mixdrop|m1xdrop|mxdrop)\.[a-z]+\/[A-Za-z0-9]+/gi;
    var mdMatch;
    while ((mdMatch = mdPattern.exec(html)) !== null) {
      var mdUrl = mdMatch[0];
      if (!seen[mdUrl]) {
        seen[mdUrl] = true;
        // Return mixdrop URLs directly (handled by server proxy)
        streams.push({
          url: mdUrl,
          name: 'CB01',
          title: 'Mixdrop',
          behaviorHints: { notWebReady: true }
        });
      }
    }

    // Find stayonline in AJAX JS blocks
    var ajaxPattern = /url:\s*["']([^"']+)["'][^}]*type:\s*["']POST["']/gi;
    var aMatch;
    while ((aMatch = ajaxPattern.exec(html)) !== null) {
      var ajaxUrl = aMatch[1];
      if (ajaxUrl.indexOf('stayonline') >= 0 && !seen[ajaxUrl]) {
        seen[ajaxUrl] = true;
        streams.push({ __stayonline: ajaxUrl, name: 'CB01', title: 'Stayonline' });
      }
    }

    cb(streams.length > 0 ? streams : null);
  });
}

function resolveUprot(url, cb) {
  var headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
  };

  // If stayonline URL, POST first
  var doFetch = function (fetchUrl, opts) {
    fetch(fetchUrl, opts)
      .then(function (r) { return r.text(); })
      .then(function (html) {
        if (!html) return cb(null);
        tryResolve(html, fetchUrl, headers, cb);
      })
      .catch(function () { cb(null); });
  };

  if (url.indexOf('stayonline.pro') !== -1) {
    var postData = 'url=' + encodeURIComponent(url);
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    headers['X-Requested-With'] = 'XMLHttpRequest';
    headers['Referer'] = 'https://cb01uno.sbs/';
    doFetch(url, { method: 'POST', headers: headers, body: postData, timeout: 15000 });

    // Also try to fetch stayonline directly with POST
    // and check response for uprot URLs
    fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': 'https://cb01uno.sbs/'
      },
      body: postData,
      timeout: 15000
    })
    .then(function (r) { return r.text(); })
    .then(function (text) {
      // Try JSON (stayonline returns JSON with .link)
      try {
        var data = JSON.parse(text);
        var link = data.link || data.url || '';
        if (link) return resolveUprotLink(link, cb);
      } catch (e) {}

      // Check for uprot in response
      var uprotMatch = text.match(/(https?:\/\/uprot\.net\/(?:ms[efi]{2,3})\/[A-Za-z0-9_-]+)/i);
      if (uprotMatch) return resolveUprotLink(uprotMatch[1], cb);

      // Check for mixdrop
      var mdMatch = text.match(/(https?:\/\/(?:mixdrop|m1xdrop|mxdrop)\.[a-z]+\/[A-Za-z0-9]+)/i);
      if (mdMatch) return cb({ url: mdMatch[1] });

      cb(null);
    })
    .catch(function () { cb(null); });
  } else {
    // Direct uprot URL - fetch and extract
    resolveUprotLink(url, cb);
  }
}

function resolveUprotLink(uprotUrl, cb) {
  var headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': 'https://cb01uno.sbs/'
  };

  fetch(uprotUrl, { headers: headers, timeout: 30000 })
    .then(function (r) { return r.text(); })
    .then(function (html) {
      if (!html) return cb(null);
      tryResolve(html, uprotUrl, headers, cb);
    })
    .catch(function () { cb(null); });
}

function tryResolve(html, sourceUrl, headers, cb) {
  // m3u8
  var m3u8Match = html.match(/https?:\/\/[^"'\s<]*\.m3u8[^"'\s<]*/i);
  if (m3u8Match) return cb({ url: m3u8Match[0], label: 'Maxstream', headers: headers });

  // mp4
  var mp4Match = html.match(/https?:\/\/[^"'\s<]*\.mp4[^"'\s<]*/i);
  if (mp4Match) return cb({ url: mp4Match[0], label: 'Maxstream', headers: headers });

  // iframe
  var iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
  if (iframeMatch) {
    var iframeUrl = iframeMatch[1];
    return resolveUprotLink(iframeUrl, function (r) {
      if (r) return cb(r);
      cb({ url: iframeUrl, label: 'Maxstream', headers: headers });
    });
  }

  // video tag
  var videoMatch = html.match(/<video[^>]+src=["']([^"']+)["']/i);
  if (videoMatch) return cb({ url: videoMatch[1], label: 'Maxstream', headers: headers });

  // sources: [{src:...}] pattern (common in players)
  var sourcesMatch = html.match(/src:\s*["']([^"']+\.m3u8[^"']*)["']/i);
  if (sourcesMatch) return cb({ url: sourcesMatch[1], label: 'Maxstream', headers: headers });

  cb(null);
}

function cleanStreams(streams) {
  return streams.filter(function (s) {
    delete s.__stayonline;
    delete s.__uprot;
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
