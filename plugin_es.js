/* Eurostreaming (es) provider - Nuvio plugin
 * Only TV series. Dynamic domain resolution.
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
      var yearSuffix = year ? '-' + year : '';

      getEsDomain(function (domain) {
        if (!domain) return resolve([]);
        searchSeries(domain, title, seasonNum, function (pageUrl) {
          if (!pageUrl) return resolve([]);
          extractEpisode(domain, pageUrl, seasonNum, episodeNum, function (link) {
            if (!link) return resolve([]);
            var tag = uprotTag(link);
            resolve([{
              name: 'Eurostreaming',
              title: 'Maxstream [' + tag + ']',
              url: link,
              behaviorHints: { notWebReady: true, bingeGroup: 'es-' + imdbId + '-' + seasonNum }
            }]);
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
  // First try dynamic via domains.json on the site
  fetch('https://raw.githubusercontent.com/cabod/domains/refs/heads/main/domains.json', { timeout: 10000 })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var d = data && data.eurostreaming;
      if (d && d.domain) return cb('https://' + d.domain);
      // try easter egg
      var ee = data && data['easter-egg'];
      if (ee && ee.eurostreaming && ee.eurostreaming.domain) return cb('https://' + ee.eurostreaming.domain);
      cb('https://eurostreamings.forum');
    })
    .catch(function () {
      cb('https://eurostreamings.forum');
    });
}

function searchSeries(domain, title, seasonNum, cb) {
  var query = title;
  esFetch(domain + '/?s=' + encodeURIComponent(query), function (err, html) {
    if (err || !html) return cb(null);

    // Match WordPress post entries with proper title link (<h2><a href="...">Title</a></h2>)
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
      // Fallback: find any link with title attribute matching
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

function extractEpisode(domain, pageUrl, seasonNum, episodeNum, cb) {
  esFetch(pageUrl, function (err, html) {
    if (err || !html) return cb(null);

    // Look for season block: look for "Stagione X" or season indicator
    var seasonTag = 'Stagione ' + seasonNum;
    var regexSeasons = html.split(/<div[^>]*class=["'][^"']*tab-content[^"']*["'][^>]*>/i);
    
    // Find the right season tab/panel
    var seasonHtml = html;
    var seasonMatch = html.match(new RegExp('<div[^>]*class="[^"]*tab-content[^"]*"[^>]*id="tab-' + seasonNum + '"[^>]*>([\\s\\S]*?)</div>\\s*</div>', 'i'));
    if (seasonMatch) seasonHtml = seasonMatch[1];

    // Find episode link pattern: "x Episodio" or "Stagione x Episodio y"
    var epPattern = new RegExp('Stagione\\s*' + seasonNum + '\\s*(?:-|x|Episodio)?\\s*' + episodeNum + '[^<]*', 'i');
    var epBlock = seasonHtml.match(epPattern);
    
    if (!epBlock) {
      // Try simpler: find link containing "episode" + episodeNum near "season" + seasonNum
      var lines = seasonHtml.split('\n');
      var found = false;
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].toLowerCase();
        if (line.indexOf('stagione') >= 0 && line.indexOf(String(seasonNum)) >= 0 &&
            String(episodeNum).length <= 2 && line.indexOf(String(episodeNum)) >= 0) {
          // Check following lines for URLs
          for (var j = i; j < Math.min(i + 10, lines.length); j++) {
            var linkMatch = lines[j].match(/(https?:\/\/uprot\.net\/(?:msf|mse)\/[A-Za-z0-9_-]+)/i);
            if (linkMatch) { cb(linkMatch[1]); return; }
          }
        }
      }
      cb(null);
    } else {
      // Found episode block - look for uprot link nearby
      var blockText = epBlock[0];
      var linkMatch = seasonHtml.substring(seasonHtml.indexOf(blockText), seasonHtml.indexOf(blockText) + 500)
                         .match(/(https?:\/\/uprot\.net\/(?:msf|mse)\/[A-Za-z0-9_-]+)/i);
      cb(linkMatch ? linkMatch[1] : null);
    }
  });
}

function uprotTag(url) {
  var m = url.match(/\/\/([^/]+)\/([^/]+)\//);
  return m ? m[2] : 'uprot';
}

module.exports = { getStreams: getStreams };
