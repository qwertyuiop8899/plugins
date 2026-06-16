var TMDB_API_KEY = '68e094699525b18a70bab2f86b1fa706';

function _cbTmdbMeta(id, type) {
  return new Promise(function(resolve) {
    var cleanId = String(id || '').replace(/^tmdb:/, '');
    if (/^tt\d+$/.test(cleanId)) {
      fetch('https://api.themoviedb.org/3/find/' + cleanId + '?api_key=' + TMDB_API_KEY + '&external_source=imdb_id&language=it-IT', { timeout: 10000 })
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(data) {
          if (!data) return resolve(null);
          if (data.tv_results && data.tv_results.length > 0) {
            var tv = data.tv_results[0];
            return resolve({ name: tv.name || tv.original_name, releaseInfo: String(tv.first_air_date || '').substring(0, 4) });
          }
          if (data.movie_results && data.movie_results.length > 0) {
            var mv = data.movie_results[0];
            return resolve({ name: mv.title || mv.original_title, releaseInfo: String(mv.release_date || '').substring(0, 4) });
          }
          resolve(null);
        })
        .catch(function() { resolve(null); });
    } else if (/^\d+$/.test(cleanId)) {
      var mediaType = String(type || 'movie').toLowerCase();
      var endpoint = (mediaType === 'tv' || mediaType === 'series')
        ? 'https://api.themoviedb.org/3/tv/' + cleanId + '?api_key=' + TMDB_API_KEY + '&language=it-IT'
        : 'https://api.themoviedb.org/3/movie/' + cleanId + '?api_key=' + TMDB_API_KEY + '&language=it-IT';
      fetch(endpoint, { timeout: 10000 })
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(data) {
          if (!data) return resolve(null);
          var title = data.name || data.title || data.original_name || data.original_title;
          var date = data.first_air_date || data.release_date || '';
          resolve({ name: title, releaseInfo: String(date).substring(0, 4) });
        })
        .catch(function() { resolve(null); });
    } else {
      resolve(null);
    }
  });
}

function getStreams(id, type, season, episode) {
  return new Promise(function (resolve, reject) {
    var tmdbId = String(id || '').replace(/^tmdb:/, '');
    var imdbId = (typeof __imdb_id !== 'undefined' ? __imdb_id : tmdbId);
    var mediaType = String(type || 'movie').toLowerCase();
    var cinemetaType = mediaType === 'tv' ? 'series' : mediaType;

    function doSearch(title, year) {
      searchCB01(title, year, mediaType, season, episode, function (pageUrl) {
        if (!pageUrl) return resolve([]);
        extractFromPage(pageUrl, season, episode, function (streams) {
          resolve(streams || []);
        });
      });
    }

    getCinemetaMeta(cinemetaType, imdbId, function (err, meta) {
      if (meta && meta.name) return doSearch(meta.name, meta.releaseInfo || '');
      // Cinemeta failed — try TMDB API
      _cbTmdbMeta(imdbId, mediaType).then(function(tmdbMeta) {
        if (tmdbMeta && tmdbMeta.name) return doSearch(tmdbMeta.name, tmdbMeta.releaseInfo || '');
        resolve([]);
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
  var searchTitles = [title];

  var separatorMatch = title.match(/^([^:\-(]+)/);
  if (separatorMatch) {
    var shortTitle = separatorMatch[1].trim();
    if (shortTitle && shortTitle !== title) searchTitles.push(shortTitle);
  }
  var firstWord = (title || '').split(/\s+/)[0];
  if (firstWord && firstWord !== title && firstWord !== searchTitles[searchTitles.length-1]) {
    searchTitles.push(firstWord);
  }

  var trySearch = function (idx) {
    if (idx >= searchTitles.length) return cb(null);
    var q = searchTitles[idx];
    var searchUrl = 'https://cb01uno.sbs/' + searchPath + '?s=' + encodeURIComponent(q);
    cb01Fetch(searchUrl, function (err, html) {
      if (err || !html) {
        cb01Fetch('https://cb01uno.mom/' + searchPath + '?s=' + encodeURIComponent(q), function (err2, html2) {
          if (err2 || !html2) return trySearch(idx + 1);
          findBestMatch(html2, q, year, function (pageUrl) {
            if (!pageUrl) return trySearch(idx + 1);
            cb(pageUrl);
          });
        });
        return;
      }
      findBestMatch(html, q, year, function (pageUrl) {
        if (!pageUrl) return trySearch(idx + 1);
        cb(pageUrl);
      });
    });
  };
  trySearch(0);
}

function findBestMatch(html, title, year, cb) {
  var lowerTitle = title.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  var titleTokens = lowerTitle.split(/\s+/).filter(Boolean);
  var candidates = [];

  var cardRegex = /<div[^>]+class="[^"]*card-content[^"]*"[\s\S]*?<h3[^>]+class="[^"]*card-title[^"]*"[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  var cardMatch;
  while ((cardMatch = cardRegex.exec(html)) !== null) {
    var href = cardMatch[1];
    var linkText = (cardMatch[2] || '').replace(/<[^>]+>/g, '').toLowerCase().trim();
    var score = 0;
    for (var i = 0; i < titleTokens.length; i++) {
      if (linkText.indexOf(titleTokens[i]) >= 0) score += 3;
    }
    if (year && linkText.indexOf(String(year)) >= 0) score += 5;
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

function extractMixDrop(mdId, quality, cb) {
  var hosts = mdHostCandidates(null);
  var lastErr = null;
  var tryHost = function (idx) {
    if (idx >= hosts.length) {
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
      cb({
        url: streamUrl,
        name: "CB01",
        title: "MixDrop",
        quality: quality || '720p',
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

function isMixDropHost(url) {
  var host = (url || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
  return /m[a-z0-9]{0,3}x[a-z0-9]{0,3}d[a-z0-9]{0,2}r[a-z0-9]{0,2}[oa]?p{0,3}/.test(host);
}

function unwrapStayonline(stayId, cb) {
  var formBody = 'id=' + encodeURIComponent(stayId) + '&ref=';
  fetch('https://stayonline.pro/ajax/linkEmbedView.php', {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Origin': 'https://stayonline.pro',
      'Referer': 'https://stayonline.pro/',
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: formBody,
    timeout: 15000
  })
  .then(function (r) { return r.json(); })
  .then(function (data) {
    var value = (data.data && data.data.value) || data.value || '';
    cb(null, value.trim() || null);
  })
  .catch(function (err) { cb(err, null); });
}

function processStayonlineUrl(stayUrl, quality, cb) {
  var stayIdMatch = stayUrl.match(/\/([e|l])\/([A-Za-z0-9]+)/);
  if (!stayIdMatch) return cb(null);
  unwrapStayonline(stayIdMatch[2], function (err, actualUrl) {
    if (!actualUrl) return cb(null);
    if (!isMixDropHost(actualUrl)) return cb(null);
    var mdIdMatch = actualUrl.match(/\/e\/([A-Za-z0-9]+)/);
    if (!mdIdMatch) return cb(null);
    extractMixDrop(mdIdMatch[1], quality, function (stream) {
      cb(stream);
    });
  });
}

function pad2(n) { n = String(n); return n.length >= 2 ? n : ('0' + n); }

function findEpisodeBlock(html, season, episode) {
  var bodyIdx = html.indexOf('</head>');
  if (bodyIdx >= 0) html = html.substring(bodyIdx);

  // Strip script, style and comment blocks
  html = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  html = html.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
  html = html.replace(/<!--[\s\S]*?-->/g, '');

  var ep2 = pad2(episode);
  var s = String(season);
  var s2 = pad2(season);

  // Build patterns to find episode label
  var epLabels = [
    '(?:' + s + '|' + s2 + ')\\s*(?:x|×|&#215;)\\s*0?' + episode + '(?!\\d)',
    'S0?' + s + 'E' + ep2,
    'STAGIONE\\s+' + season + '\\s*-\\s*EPISODIO\\s+' + episode + '\\b'
  ];

  var epIdx = -1;
  var epMatch = null;

  for (var i = 0; i < epLabels.length && epIdx < 0; i++) {
    var epRe = new RegExp(epLabels[i], 'i');
    var m = epRe.exec(html);
    if (m) {
      epIdx = m.index;
      epMatch = m[0];
    }
  }

  if (epIdx < 0) {
    // Fallback: old accordion format: <div class="sp-head">...STAGIONE N...</div> ... <div class="sp-body">
    var spHeadRe = new RegExp('<div[^>]+class="[^"]*sp-head[^"]*"[^>]*>(?:[\\s\\S]*?)\\bSTAGIONE\\s+0?' + season + '\\b[\\s\\S]*?<div[^>]+class="[^"]*sp-body[^"]*"[^>]*>([\\s\\S]*?)<div[^>]+class="[^"]*spdiv[^"]*"', 'i');
    var spMatch = html.match(spHeadRe);
    return spMatch ? spMatch[1] : null;
  }

  // Find the next episode header after the current one
  var nextEpRe = /S\d+E\d+|S0?\d+E\d+|\d+\s*(?:x|×|&#215;)\s*\d+|<div\s+class="(?:sp-head|spdiv)"/gi;
  var nextIdx = -1;
  var searchStart = epIdx + epMatch.length;

  nextEpRe.lastIndex = searchStart;
  var nextMatch = nextEpRe.exec(html);
  if (nextMatch && nextMatch.index > epIdx) {
    nextIdx = nextMatch.index;
  }

  // Slice the block: from label to next section header (or end of string)
  var epBlock = html.substring(searchStart, nextIdx >= 0 ? nextIdx : html.length).trim();

  // Re-prepend the stream section context: sometimes tables PRECEDE the label
  // Search backwards from epIdx to find the nearest <table cbtable> before the label
  // and include everything from that table forward
  var tableBefore = html.lastIndexOf('<table', epIdx);
  if (tableBefore >= 0) {
    var between = html.substring(tableBefore, epIdx);
    // Only include table before label if it's close (within 200 chars) and contains streaming
    if (between.length < 200 && /streaming/i.test(between)) {
      return html.substring(tableBefore, nextIdx >= 0 ? nextIdx : html.length);
    }
  }

  return epBlock;
}

function extractTables(html) {
  var tables = html.match(/<table[^>]*>[\s\S]*?<\/table>/gi) || [];
  var sections = [];
  var currentQuality = null;

  for (var i = 0; i < tables.length; i++) {
    var lower = tables[i].replace(/<[^>]+>/g, '').toLowerCase().trim();
    if (lower.indexOf('streaming') >= 0) {
      if (lower.indexOf('hd') >= 0) {
        currentQuality = '1080p';
      } else {
        currentQuality = '720p';
      }
      continue;
    }
    if (currentQuality && tables[i].indexOf('tableinside') >= 0) {
      var linkMatch = tables[i].match(/<a[^>]+href="([^"]*stayonline\.pro[^"]*)"/i);
      if (linkMatch) {
        sections.push({ url: linkMatch[1], quality: currentQuality });
      }
    }
  }
  return sections;
}

function extractFromPage(pageUrl, season, episode, cb) {
  cb01Fetch(pageUrl, function (err, html) {
    if (err || !html) return cb([]);

    var isSeries = (season !== undefined && season > 0) || (episode !== undefined && episode > 0);
    var targetHtml = html;
    var block = null;

    if (isSeries) {
      block = findEpisodeBlock(html, season, episode);
      if (block) {
        targetHtml = block;
      }
    }

    var sections = extractTables(targetHtml);

    if (sections.length === 0 && isSeries && targetHtml !== html) {
      // Fallback: try full page for older format
      sections = extractTables(html);
    }

    if (sections.length === 0) {
      // Fallback: extract all stayonline links directly from block/html (accordion/vecchio formato)
      var linkRe = /href=["'](https?:\/\/[^"']*stayonline\.pro\/[^"']*)["']/gi;
      var match;
      var seen = {};
      var defaultQuality = '720p';
      var blockUpper = (block || html).toUpperCase();
      if (blockUpper.indexOf('STREAMING HD:') >= 0 || html.toUpperCase().indexOf('STAGIONE ' + season + ' - ITA - HD') >= 0 || html.toUpperCase().indexOf('STAGIONE ' + season + ' - SUB - HD') >= 0) {
        defaultQuality = '1080p';
      }

      while ((match = linkRe.exec(targetHtml)) !== null) {
        var u = match[1];
        if (!seen[u]) {
          seen[u] = true;
          sections.push({ url: u, quality: defaultQuality });
        }
      }
    }

    if (sections.length === 0) return cb([]);

    var results = [];
    var pending = sections.length;

    sections.forEach(function (section) {
      processStayonlineUrl(section.url, section.quality, function (stream) {
        if (stream) results.push(stream);
        pending--;
        if (pending === 0) cb(results.length > 0 ? results : []);
      });
    });
  });
}

module.exports = { getStreams: getStreams };
