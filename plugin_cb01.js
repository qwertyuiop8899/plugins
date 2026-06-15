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
      searchCB01(title, year, mediaType, season, episode, function (pageUrl) {
        if (!pageUrl) return resolve([]);
        extractFromPage(pageUrl, season, episode, function (streams) {
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

var USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146.0.0.0 Safari/537.36';

function cb01Fetch(url, cb) {
  var headers = {
    'User-Agent': USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': 'https://cb01uno.sbs/'
  };
  fetch(url, { headers: headers, timeout: 15000 })
    .then(function (r) { return r.text(); })
    .then(function (html) { cb(null, html); })
    .catch(function (err) { cb(err, null); });
}

function searchCB01(title, year, mediaType, season, episode, cb) {
  var isSeries = mediaType === 'series' || mediaType === 'tv';
  var searchPath = isSeries ? 'serietv/' : '';
  var searchUrl = 'https://cb01uno.sbs/' + searchPath + '?s=' + encodeURIComponent(title);
  cb01Fetch(searchUrl, function (err, html) {
    if (err || !html) {
      cb01Fetch('https://cb01uno.mom/' + searchPath + '?s=' + encodeURIComponent(title), function (err2, html2) {
        if (err2 || !html2) return cb(null);
        findBestMatch(html2, title, year, function (pageUrl) {
          if (!pageUrl) return cb(null);
          cb(pageUrl);
        });
      });
      return;
    }
    findBestMatch(html, title, year, function (pageUrl) {
      if (!pageUrl) return cb(null);
      cb(pageUrl);
    });
  });
}

function findBestMatch(html, title, year, cb) {
  var lowerTitle = title.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  var candidates = [];

  var cardRegex = /<div[^>]*class="[^"]*card-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
  var cardMatch;
  while ((cardMatch = cardRegex.exec(html)) !== null) {
    var cardHtml = cardMatch[1];
    var linkMatch = cardHtml.match(/<h3[^>]*class="[^"]*card-title[^"]*"[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    var href = linkMatch[1];
    var linkText = (linkMatch[2] || '').replace(/<[^>]+>/g, '').toLowerCase().trim();
    var text = linkText + ' ' + cardHtml.toLowerCase();
    var score = 0;
    var titleTokens = lowerTitle.split(/\s+/).filter(Boolean);
    for (var i = 0; i < titleTokens.length; i++) {
      if (text.indexOf(titleTokens[i]) >= 0) score += 3;
    }
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
        var aText = a.toLowerCase();
        var score = 0;
        for (var i = 0; i < titleTokens.length; i++) {
          if (aText.indexOf(titleTokens[i]) >= 0) score += 3;
        }
        if (year && aText.indexOf(String(year)) >= 0) score += 5;
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

var MD_HOSTS = [
  'miixdrop.net', 'm1xdrop.net', 'mxdrop.net',
  'mixdrop.ag', 'mixdrop.co', 'mixdrop.sb', 'mixdrop.is',
  'mixdrop.club', 'mixdrop.to', 'mixdrop.vip',
  'm1xdrop.bz', 'mixdrop.ch', 'mixdrop.ps'
];

function normalizeHost(h) {
  if (!h) return null;
  h = h.replace(/^https?:\/\//i, '').replace(/\/$/, '').trim();
  return h && /^[a-z0-9.-]+$/i.test(h) ? h : null;
}

function mdHostCandidates(preferred) {
  var out = [];
  var seen = {};
  function push(h) {
    var n = normalizeHost(h);
    if (n && !seen[n.toLowerCase()]) { seen[n.toLowerCase()] = true; out.push(n); }
  }
  push(preferred);
  for (var i = 0; i < MD_HOSTS.length; i++) push(MD_HOSTS[i]);
  return out;
}

function unpackPackedJs(packed) {
  var m = packed.match(/eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\(\s*'((?:\\.|[^'\\])*)'\s*,\s*(\d+|\[\])\s*,\s*(\d+)\s*,\s*'((?:\\.|[^'\\])*)'\s*\.split\(['"]\|['"]\)/);
  if (!m) {
    m = packed.match(/\}\(\s*'((?:\\.|[^'\\])*)'\s*,\s*(\d+|\[\])\s*,\s*(\d+)\s*,\s*'((?:\\.|[^'\\])*)'\s*\.split\(['"]\|['"]\)/);
  }
  if (!m) return null;

  var p = m[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  var a = m[2] === "[]" ? 62 : parseInt(m[2], 10);
  var c = parseInt(m[3], 10);
  var k = m[4].split("|");

  var ALPHA = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  function toBaseN(n) {
    if (n < a) return ALPHA[n];
    return toBaseN(Math.floor(n / a)) + ALPHA[n % a];
  }
  var dict = {};
  for (var i = 0; i < c; i++) {
    var key = toBaseN(i);
    dict[key] = (k[i] && k[i].length) ? k[i] : key;
  }
  return p.replace(/\b(\w+)\b/g, function (_, w) { return dict[w] !== undefined ? dict[w] : w; });
}

var MD_URL_PATTERNS = [
  /(?:MDCore|vsConfig)\.wurl\s*=\s*["']([^"']+)["']/,
  /wurl\s*[:=]\s*["']([^"']+)["']/,
  /<source\s+[^>]*src=["']([^"']+)["']/i,
  /file\s*:\s*["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/,
  /["'](https?:\/\/[^\s"']+\.(?:mp4|m3u8)[^\s"']*)["']/,
  /["'](\/\/[^\s"']+\.(?:mp4|m3u8)[^\s"']*)["']/
];

function extractMdStream(text) {
  for (var i = 0; i < MD_URL_PATTERNS.length; i++) {
    var m = text.match(MD_URL_PATTERNS[i]);
    if (m && m[1]) {
      var u = m[1].trim();
      if (u.startsWith("//")) u = "https:" + u;
      return u;
    }
  }
  return null;
}

function mdFetch(host, path, cb) {
  var headers = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "Accept-Encoding": "identity",
    "Cache-Control": "no-cache",
    "Referer": "https://" + host + "/"
  };
  var url = "https://" + host + path;
  fetch(url, { headers: headers, timeout: 15000 })
    .then(function (r) { return r.text(); })
    .then(function (html) { cb(null, html, url); })
    .catch(function (err) { cb(err, null, url); });
}

function extractMixDrop(mdId, cb) {
  var hosts = mdHostCandidates(null);
  var lastErr = null;
  var tryHost = function (idx) {
    if (idx >= hosts.length) {
      console.log("[CB01] MixDrop all hosts failed: " + (lastErr || "unknown"));
      return cb(null);
    }
    var host = hosts[idx];
    mdFetch(host, "/e/" + mdId, function (err, html, url) {
      if (err || !html || html.length < 1000) {
        lastErr = err ? err.message : "bad response len=" + (html ? html.length : 0);
        return tryHost(idx + 1);
      }
      var combined = html;
      var packerRegex = /eval\(function\(p,a,c,k,e,d\)[\s\S]*?\}\([\s\S]*?\.split\(['"]\|['"]\)[\s\S]*?\)\s*\)/g;
      var packerMatch;
      while ((packerMatch = packerRegex.exec(html)) !== null) {
        var unpacked = unpackPackedJs(packerMatch[0]);
        if (unpacked) combined += "\n" + unpacked;
      }
      var streamUrl = extractMdStream(combined);
      if (!streamUrl) {
        var hasPacker = /eval\(function\(p,a,c,k,e,d\)/.test(html);
        lastErr = "stream url not found (host=" + host + " hasPacker=" + hasPacker + " len=" + html.length + ")";
        return tryHost(idx + 1);
      }
      console.log("[CB01] MixDrop stream: " + streamUrl);
      cb({
        url: streamUrl,
        name: "CB01",
        title: "MixDrop",
        behaviorHints: { notWebReady: true },
        headers: {
          "User-Agent": USER_AGENT,
          "Referer": "https://" + host + "/"
        }
      });
    });
  };
  tryHost(0);
}

function extractFromPage(pageUrl, season, episode, cb) {
  cb01Fetch(pageUrl, function (err, html) {
    if (err || !html) return cb([]);
    var streams = [];
    var seen = {};

    var iframeMatch = html.match(/<div[^>]+id=["']iframen2["'][^>]*data-src=["']([^"']+)["']/i);
    var mdUrl = iframeMatch ? iframeMatch[1] : null;

    if (!mdUrl) {
      iframeMatch = html.match(/<div[^>]+id=["']iframen1["'][^>]*data-src=["']([^"']+)["']/i);
      mdUrl = iframeMatch ? iframeMatch[1] : null;
    }

    if (mdUrl) {
      var mdIdMatch = mdUrl.match(/\/e\/([A-Za-z0-9]+)/);
      if (mdIdMatch) {
        extractMixDrop(mdIdMatch[1], function (stream) {
          if (stream) streams.push(stream);
          cb(streams.length > 0 ? streams : null);
        });
      } else {
        cb(null);
      }
    } else {
      cb(null);
    }
  });
}

module.exports = { getStreams: getStreams };
