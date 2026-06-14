/* Eurostreaming (es) provider - Nuvio plugin
 * Only TV series. Extracts uprot and mixdrop links from episode pages.
 */
function getStreams(id, type, season, episode) {
  return new Promise(function (resolve, reject) {
    var tmdbId = String(id || '').replace(/^tmdb:/, '');
    var imdbId = (typeof __imdb_id !== 'undefined' ? __imdb_id : tmdbId);
    var mediaType = String(type || 'movie').toLowerCase();

    if (mediaType !== 'series' && mediaType !== 'tv') return resolve([]);

    getCinemetaMeta('series', imdbId, function (err, meta) {
      if (!meta || !meta.name) return resolve([]);
      var title = meta.name;
      var seasonNum = Number(season) || 1;
      var episodeNum = Number(episode) || 1;
      var year = meta.releaseInfo || '';

      getEsDomain(function (domain) {
        if (!domain) return resolve([]);
        searchSeries(domain, title, seasonNum, function (pageUrl) {
          if (!pageUrl) return resolve([]);
          extractLinksFromPage(domain, pageUrl, seasonNum, episodeNum, function (streams) {
            resolve(streams || []);
          });
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

function esFetch(url, cb) {
  var headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': 'https://eurostreamings.forum/'
  };
  fetch(url, { headers: headers, timeout: 15000 })
    .then(function (r) { return r.text(); })
    .then(function (text) { cb(null, text); })
    .catch(function (err) { cb(err, null); });
}

function getEsDomain(cb) {
  // Try cabod domain list, fallback to hardcoded
  fetch('https://raw.githubusercontent.com/cabod/domains/refs/heads/main/domains.json', { timeout: 10000 })
    .then(function (r) { return r.text(); })
    .then(function (data) {
      try {
        var json = JSON.parse(data);
        var d = json && json.eurostreaming;
        if (d && d.domain) return cb('https://' + d.domain);
        var ee = json && json['easter-egg'];
        if (ee && ee.eurostreaming && ee.eurostreaming.domain) return cb('https://' + ee.eurostreaming.domain);
      } catch(e) {
        // Maybe it's a text file, try alternative format
        var lines = data.split('\n');
        for (var i = 0; i < lines.length; i++) {
          if (lines[i].indexOf('eurostreaming') >= 0) {
            var parts = lines[i].split('=');
            if (parts.length > 1 && parts[1].trim()) {
              var dom = parts[1].trim();
              if (!dom.startsWith('http')) dom = 'https://' + dom;
              return cb(dom);
            }
          }
        }
      }
      cb('https://eurostreamings.forum');
    })
    .catch(function () { cb('https://eurostreamings.forum'); });
}

function searchSeries(domain, title, seasonNum, cb) {
  var query = title;
  esFetch(domain + '/?s=' + encodeURIComponent(query), function (err, html) {
    if (err || !html) return cb(null);

    var entryPattern = /<li[^>]+id=["']post-(\d+)["'][^>]*class=["'][^"]*post[^"]*["'][^>]*>[\s\S]*?<h\d[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h\d>[\s\S]*?<\/li>/gi;
    var match;
    var candidates = [];
    var seen = {};
    var lowerTitle = title.toLowerCase();
    while ((match = entryPattern.exec(html)) !== null) {
      var href = match[2];
      var linkText = (match[3] || '').replace(/<[^>]+>/g, '').toLowerCase();
      if (!seen[href] && linkText.indexOf(lowerTitle) >= 0) {
        seen[href] = true;
        candidates.push(href);
      }
    }

    if (candidates.length === 0) {
      var allLinks = html.match(/<a[^>]+href=["']([^"']+)["'][^>]*title=["']([^"']+)["'][^>]*>/gi);
      if (allLinks) {
        allLinks.forEach(function (a) {
          var m = a.match(/href=["']([^"']+)["']/);
          var t = a.match(/title=["']([^"']+)["']/i);
          if (m && t && !seen[m[1]] && t[1].toLowerCase().indexOf(lowerTitle) >= 0) {
            seen[m[1]] = true;
            candidates.push(m[1]);
          }
        });
      }
    }

    cb(candidates.length > 0 ? candidates[0] : null);
  });
}

function extractLinksFromPage(domain, pageUrl, seasonNum, episodeNum, cb) {
  esFetch(pageUrl, function (err, html) {
    if (err || !html) return cb(null);
    var streams = [];
    var seen = {};

    var seasonMatch = html.match(new RegExp('<div[^>]*class="[^"]*tab-content[^"]*"[^>]*id="tab-' + seasonNum + '"[^>]*>([\\s\\S]*?)</div>\\s*</div>', 'i'));
    var seasonHtml = seasonMatch ? seasonMatch[1] : html;

    // Find uprot links near the episode
    var epPattern = new RegExp('Stagione\\s*' + seasonNum + '\\s*(?:-|x|Episodio)?\\s*' + episodeNum + '[^<]*', 'i');
    var epBlock = seasonHtml.match(epPattern);
    var blockToSearch = '';

    if (epBlock) {
      var blockStart = seasonHtml.indexOf(epBlock[0]);
      blockToSearch = seasonHtml.substring(blockStart, blockStart + 800);
    } else {
      var lines = seasonHtml.split('\n');
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].toLowerCase();
        if (line.indexOf('stagione') >= 0 && line.indexOf(String(seasonNum)) >= 0 &&
            String(episodeNum).length <= 2 && line.indexOf(String(episodeNum)) >= 0) {
          for (var j = i; j < Math.min(i + 15, lines.length); j++) {
            blockToSearch += lines[j] + '\n';
          }
          break;
        }
      }
    }

    // Extract uprot URLs from the block
    var uprotMatch = blockToSearch.match(/(https?:\/\/uprot\.net\/(?:ms[efi]{2,3})\/[A-Za-z0-9_-]+)/gi);
    if (uprotMatch) {
      uprotMatch.forEach(function (u) {
        if (!seen[u]) {
          seen[u] = true;
          streams.push({
            url: u,
            name: 'Eurostreaming',
            title: 'MaxStream [uprot]',
            behaviorHints: { notWebReady: true }
          });
        }
      });
    }

    // Also search for mixdrop links in the same block
    var mdRegex = /https?:\/\/(?:mixdrop|m1xdrop|mxdrop)\.[a-z]+\/[A-Za-z0-9]+/gi;
    var mdMatch;
    while ((mdMatch = mdRegex.exec(blockToSearch)) !== null) {
      var mdUrl = mdMatch[0];
      if (!seen[mdUrl]) {
        seen[mdUrl] = true;
        streams.push({
          url: mdUrl,
          name: 'Eurostreaming',
          title: 'MixDrop',
          behaviorHints: { notWebReady: true }
        });
      }
    }

    // Also search the entire page for mixdrop
    var mdGlobalReg = /https?:\/\/(?:mixdrop|m1xdrop|mxdrop)\.[a-z]+\/[A-Za-z0-9]+/gi;
    while ((mdMatch = mdGlobalReg.exec(html)) !== null) {
      var mdGUrl = mdMatch[0];
      if (!seen[mdGUrl]) {
        seen[mdGUrl] = true;
        streams.push({
          url: mdGUrl,
          name: 'Eurostreaming',
          title: 'MixDrop',
          behaviorHints: { notWebReady: true }
        });
      }
    }

    // Search for mixdrop URLs inside JavaScript strings/arrays
    var jsMdMatch = html.match(/["'](https?:\/\/(?:mixdrop|m1xdrop|mxdrop)\.[a-z]+\/[A-Za-z0-9]+)["']/gi);
    if (jsMdMatch) {
      jsMdMatch.forEach(function (m) {
        var url = m.replace(/["']/g, '');
        if (!seen[url]) {
          seen[url] = true;
          streams.push({
            url: url,
            name: 'Eurostreaming',
            title: 'MixDrop',
            behaviorHints: { notWebReady: true }
          });
        }
      });
    }

    cb(streams.length > 0 ? streams : null);
  });
}

module.exports = { getStreams: getStreams };
