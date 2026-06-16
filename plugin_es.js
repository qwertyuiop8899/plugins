/* Eurostreaming (es) provider - Nuvio plugin
 * Only TV series. Extracts mixdrop, turbovid, deltabit streams
 * with clicka.cc captcha OCR resolution (no npm dependencies).
 */

var _originalFetch = fetch;
fetch = function(url, options) {
  var targetUrl = url;
  if (typeof url === 'string') {
    if (url.indexOf('turbovid') >= 0 || url.indexOf('deltabit') >= 0) {
      if (url.indexOf('workers.dev') < 0) {
        targetUrl = 'https://vidclick.leanhhu061208-775.workers.dev/?url=' + encodeURIComponent(url);
      }
    }
  }
  return _originalFetch(targetUrl, options);
};

// =========================================================================
// CONFIGURATION
// =========================================================================
var ES_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

if (typeof URL === 'undefined') {
  URL = function(uri, base) {
    var resolved = uri;
    if (base) {
      if (uri.indexOf('://') < 0) {
        var baseParts = base.match(/^(https?:\/\/[^\/]+)(.*)$/);
        var baseOrigin = baseParts ? baseParts[1] : '';
        var basePath = baseParts ? baseParts[2] : '';
        if (uri.startsWith('//')) {
          resolved = (base.startsWith('https') ? 'https:' : 'http:') + uri;
        } else if (uri.startsWith('/')) {
          resolved = baseOrigin + uri;
        } else {
          var dir = basePath.substring(0, basePath.lastIndexOf('/') + 1);
          resolved = baseOrigin + dir + uri;
        }
      }
    }
    var m = resolved.match(/^(https?):\/\/([^\/?:#]+)(?::(\d+))?([^?#]*)(\?[^#]*)?(#.*)?$/);
    if (!m) throw new Error('Invalid URL: ' + resolved);
    this.href = resolved;
    this.protocol = m[1] + ':';
    this.hostname = m[2];
    this.port = m[3] || '';
    this.host = this.hostname + (this.port ? ':' + this.port : '');
    this.pathname = m[4] || '/';
    this.search = m[5] || '';
    this.hash = m[6] || '';
    this.origin = m[1] + '://' + this.host;
  };
}

var MD_HOSTS = [
  'mixdrop.vip', 'mixdrop.ps', 'mixdrop.ch', 'mixdrop.to', 'mixdrop.club',
  'mixdrop.is', 'mixdrop.sb', 'mixdrop.co', 'mixdrop.ag', 'mixdrop.net',
  'm1xdrop.net', 'mxdrop.net', 'miixdrop.net'
];

// Relaxed MixDrop hostname pattern (covers mi×drop, m1x_drop, etc.)
var MD_PAT = 'm[i1!ì]{1,2}[x×][ _-]?d[r]{1,2}[o0ø][ _-]?p';

// =========================================================================
// HELPERS
// =========================================================================
function _decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/&quot;/g, '"').replace(/&#0?34;/g, '"')
    .replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function _resolveUrl(href, base) {
  try { return new URL(href, base).href; } catch(e) { return null; }
}

function _buildProxyUrl(rawUrl, referer, ua, origin) {
  try {
    var urlObj = new URL(rawUrl);
    var destOrigin = urlObj.origin;
    var pathnameAndSearch = urlObj.pathname + urlObj.search;
    var opts = 'd=' + encodeURIComponent(destOrigin) +
               '&h=' + encodeURIComponent('User-Agent:' + (ua || ES_UA)) +
               '&h=' + encodeURIComponent('Referer:' + referer);
    if (origin) {
      opts += '&h=' + encodeURIComponent('Origin:' + origin);
    }
    return '/proxy/' + opts + pathnameAndSearch;
  } catch(e) { return rawUrl; }
}

function _sleep(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}

function _isDigit(s) { return /^\d+$/.test(s); }

// =========================================================================
// COOKIE JAR
// =========================================================================
var _cookieJar = {};

function _jarSet(url, setCookieHeader, jar) {
  if (!setCookieHeader) return;
  var parts = setCookieHeader.split(';');
  var first = parts[0].split('=');
  var name = first[0].trim();
  var value = first.slice(1).join('=').trim();
  if (!name) return;
  var domain = null;
  for (var i = 1; i < parts.length; i++) {
    var p = parts[i].trim().split('=');
    if (p[0].toLowerCase().trim() === 'domain' && p[1]) {
      domain = p[1].trim().toLowerCase();
      if (domain.charAt(0) === '.') domain = domain.substring(1);
    }
  }
  if (!domain) {
    try { domain = new URL(url).hostname; } catch(e) { return; }
  }
  var activeJar = jar || _cookieJar;
  if (!activeJar[domain]) activeJar[domain] = {};
  activeJar[domain][name] = value;
}

function _jarGet(url, jar) {
  try {
    var host = new URL(url).hostname;
    var parts = host.split('.');
    var cookies = [];
    var activeJar = jar || _cookieJar;
    for (var i = 0; i < parts.length; i++) {
      var dom = parts.slice(i).join('.');
      if (activeJar[dom]) {
        for (var name in activeJar[dom]) {
          cookies.push(name + '=' + activeJar[dom][name]);
        }
      }
    }
    return cookies.join('; ');
  } catch(e) { return ''; }
}

function _jarClear() { _cookieJar = {}; }

// =========================================================================
// CLICKA.CC FETCH WRAPPERS (manual redirect following + cookie persistence)
// =========================================================================
function _extractCookies(r, finalUrl, jar) {
  try {
    if (!r.headers) return;
    // Try modern getSetCookie() first
    var all = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : null;
    if (all && all.length) {
      for (var i = 0; i < all.length; i++) _jarSet(finalUrl, all[i], jar);
      return;
    }
    // Fallback: iterate all headers
    if (typeof r.headers.forEach === 'function') {
      r.headers.forEach(function(v, k) {
        if (k.toLowerCase() === 'set-cookie') _jarSet(finalUrl, v, jar);
      });
    } else if (typeof r.headers.get === 'function') {
      var sc = r.headers.get('set-cookie') || r.headers.get('Set-Cookie');
      if (sc) _jarSet(finalUrl, sc, jar);
    }
  } catch(e) {}
}

function _follow(url, options, maxHops, jar) {
  return new Promise(function(resolve, reject) {
    var hops = 0;
    function doFetch(curUrl) {
      if (hops++ > maxHops) return reject(new Error('Too many redirects'));
      var fetchOpts = {};
      for (var k in options) fetchOpts[k] = options[k];
      var cookieStr = _jarGet(curUrl, jar);
      if (cookieStr) {
        fetchOpts.headers = fetchOpts.headers || {};
        fetchOpts.headers['Cookie'] = cookieStr;
      }

      // Proxy clicka.cc and safego.cc through Cloudflare Worker
      var finalFetchUrl = curUrl;
      if (curUrl.includes('clicka.cc') || curUrl.includes('safego.cc')) {
        finalFetchUrl = 'https://vidclick.leanhhu061208-775.workers.dev/?url=' + encodeURIComponent(curUrl);
        fetchOpts.headers = fetchOpts.headers || {};
        fetchOpts.headers['User-Agent'] = ES_UA;
        fetchOpts.headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';
        fetchOpts.headers['Accept-Language'] = 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7';
        fetchOpts.headers['Sec-Ch-Ua'] = '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"';
        fetchOpts.headers['Sec-Ch-Ua-Mobile'] = '?0';
        fetchOpts.headers['Sec-Ch-Ua-Platform'] = '"Windows"';
        fetchOpts.headers['Sec-Fetch-Dest'] = 'document';
        fetchOpts.headers['Sec-Fetch-Mode'] = 'navigate';
        fetchOpts.headers['Sec-Fetch-Site'] = 'none';
        fetchOpts.headers['Sec-Fetch-User'] = '?1';
        fetchOpts.headers['Upgrade-Insecure-Requests'] = '1';
        fetchOpts.headers['Connection'] = 'keep-alive';
      }

      fetch(finalFetchUrl, { ...fetchOpts, redirect: 'manual' }).then(function(r) {
        var finalUrl = curUrl; 
        _extractCookies(r, finalUrl, jar);
        if (r.status >= 300 && r.status < 400 && r.status !== 304) {
          var loc = r.headers.get('location');
          if (loc) {
            var nextUrl = loc.indexOf('://') >= 0 ? loc : _resolveUrl(loc, finalUrl);
            if (nextUrl && nextUrl !== curUrl) return doFetch(nextUrl);
          }
        }
        return r.text().then(function(text) {
          resolve({ ok: true, status: r.status, text: text, url: finalUrl });
        });
      }).catch(function(err) { reject(err); });
    }
    doFetch(url);
  });
}

function _clickaFetch(url, referer, jar) {
  var headers = {
    'User-Agent': ES_UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'identity'
  };
  if (referer) headers['Referer'] = referer;
  return _follow(url, { headers: headers }, 7, jar);
}

function _clickaPost(url, formData, referer, jar) {
  var headers = {
    'User-Agent': ES_UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    'Content-Type': 'application/x-www-form-urlencoded'
  };
  try { headers['Origin'] = new URL(url).origin; } catch(e) {}
  if (referer) headers['Referer'] = referer;
  var body = typeof formData === 'string' ? formData : _formEncode(formData);
  return _follow(url, { method: 'POST', headers: headers, body: body }, 7, jar);
}

function _formEncode(obj) {
  var parts = [];
  for (var k in obj) {
    if (obj.hasOwnProperty(k)) {
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(obj[k])));
    }
  }
  return parts.join('&');
}

// =========================================================================
// PNG DECODER (Buffer + zlib, no external deps)
// =========================================================================
var _zlib = null;
try { _zlib = require('zlib'); } catch(e) {}

function _pngDecode(b64) {
  if (!_zlib) throw new Error('zlib not available');
  // Decode base64 to raw bytes
  var raw = (typeof atob !== 'undefined' ? atob(b64) : require('buffer').Buffer.from(b64, 'base64').toString('latin1'));
  var len = raw.length;
  var bytes = new Uint8Array(len);
  for (var i = 0; i < len; i++) bytes[i] = raw.charCodeAt(i) & 0xff;
  // Validate PNG signature
  if (bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) {
    throw new Error('Not a PNG');
  }
  // Parse chunks
  var pos = 8;
  var width, height, bitDepth, colorType;
  var idatData = [];
  while (pos + 8 <= bytes.length) {
    var clen = (bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
    var ctype = String.fromCharCode(bytes[pos + 4]) + String.fromCharCode(bytes[pos + 5]) +
                String.fromCharCode(bytes[pos + 6]) + String.fromCharCode(bytes[pos + 7]);
    if (ctype === 'IHDR') {
      width = (bytes[pos + 8] << 24) | (bytes[pos + 9] << 16) | (bytes[pos + 10] << 8) | bytes[pos + 11];
      height = (bytes[pos + 12] << 24) | (bytes[pos + 13] << 16) | (bytes[pos + 14] << 8) | bytes[pos + 15];
      bitDepth = bytes[pos + 16];
      colorType = bytes[pos + 17];
    } else if (ctype === 'IDAT') {
      var chunkData = bytes.subarray(pos + 8, pos + 8 + clen);
      idatData.push(chunkData);
    } else if (ctype === 'IEND') {
      break;
    }
    pos += 12 + clen;
  }
  if (!width || !height) throw new Error('PNG: no IHDR');
  // Only support RGB (colorType=2) or RGBA (colorType=6), bitDepth=8
  var bytesPerPixel = (colorType === 6) ? 4 : (colorType === 2) ? 3 : 1;
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error('PNG: unsupported format colorType=' + colorType + ' bitDepth=' + bitDepth);
  }
  // Concatenate IDAT data and decompress
  var totalLen = 0;
  for (var di = 0; di < idatData.length; di++) totalLen += idatData[di].length;
  var idatCombined = new Uint8Array(totalLen);
  var off = 0;
  for (var di2 = 0; di2 < idatData.length; di2++) {
    idatCombined.set(idatData[di2], off);
    off += idatData[di2].length;
  }
  var decompressed = _zlib.inflateSync(idatCombined);
  // Reconstruct image rows with filter
  var bpp = bytesPerPixel;
  var rowBytes = width * bpp;
  var pixels = new Array(height);
  var dpos = 0;
  for (var y = 0; y < height; y++) {
    var filter = decompressed[dpos++];
    var row = new Uint8Array(rowBytes);
    var prevRow = y > 0 ? pixels[y - 1] : null;
    for (var x = 0; x < rowBytes; x++) {
      var rawByte = decompressed[dpos++];
      if (filter === 0) {
        row[x] = rawByte;
      } else if (filter === 1) {
        var left = x >= bpp ? row[x - bpp] : 0;
        row[x] = (rawByte + left) & 0xff;
      } else if (filter === 2) {
        var up = prevRow ? prevRow[x] : 0;
        row[x] = (rawByte + up) & 0xff;
      } else if (filter === 3) {
        var leftA = x >= bpp ? row[x - bpp] : 0;
        var upA = prevRow ? prevRow[x] : 0;
        row[x] = (rawByte + Math.floor((leftA + upA) / 2)) & 0xff;
      } else if (filter === 4) {
        var leftP = x >= bpp ? row[x - bpp] : 0;
        var upP = prevRow ? prevRow[x] : 0;
        var upLeftP = (x >= bpp && prevRow) ? prevRow[x - bpp] : 0;
        var p = leftP + upP - upLeftP;
        var pa = Math.abs(p - leftP);
        var pb = Math.abs(p - upP);
        var pc = Math.abs(p - upLeftP);
        var pr = (pa <= pb && pa <= pc) ? leftP : (pb <= pc ? upP : upLeftP);
        row[x] = (rawByte + pr) & 0xff;
      }
    }
    pixels[y] = row;
  }
  return { width: width, height: height, pixels: pixels, bpp: bpp };
}

// =========================================================================
// CAPTCHA OCR - native 10x10 template matching (all digits confirmed by user)
// =========================================================================
// Full pixel data for all 10 digits (1=black, 0=white), 10 rows each.
// The captcha font is always the same fixed bitmap font.
// Format: data[d] = { w: width, pixels: [[row0],[row1],...] }

var DIGIT_PIXELS = [
  // 0 (w=8)
  { w: 8, pixels: [
    [0,0,0,1,1,0,0,0],
    [0,0,1,1,1,1,0,0],
    [0,1,1,0,0,1,1,0],
    [1,1,0,0,0,0,1,1],
    [1,1,0,0,0,0,1,1],
    [1,1,0,0,0,0,1,1],
    [1,1,0,0,0,0,1,1],
    [0,1,1,0,0,1,1,0],
    [0,0,1,1,1,1,0,0],
    [0,0,0,1,1,0,0,0]
  ]},
  // 1 (w=3)
  { w: 3, pixels: [
    [0,1,1],
    [1,1,1],
    [1,1,1],
    [0,1,1],
    [0,1,1],
    [0,1,1],
    [0,1,1],
    [0,1,1],
    [0,1,1],
    [1,1,1]
  ]},
  // 2 (w=7)
  { w: 7, pixels: [
    [0,1,1,1,1,0,0],
    [1,1,0,0,1,1,0],
    [1,0,0,0,0,1,1],
    [0,0,0,0,0,1,1],
    [0,0,0,0,1,1,0],
    [0,0,0,1,1,0,0],
    [0,0,1,1,0,0,0],
    [0,1,1,0,0,0,0],
    [1,1,0,0,0,0,0],
    [1,1,1,1,1,1,1]
  ]},
  // 3 (w=5)
  { w: 5, pixels: [
    [1,1,1,0,0],
    [0,0,1,1,0],
    [0,0,0,1,1],
    [0,0,1,1,0],
    [1,1,1,0,0],
    [0,0,1,1,0],
    [0,0,0,1,1],
    [0,0,0,1,1],
    [0,0,1,1,0],
    [1,1,1,0,0]
  ]},
  // 4 (w=6)
  { w: 6, pixels: [
    [0,0,0,0,1,1],
    [0,0,0,1,1,1],
    [0,0,1,1,1,1],
    [0,1,1,0,1,1],
    [1,1,0,0,1,1],
    [1,0,0,0,1,1],
    [1,1,1,1,1,1],
    [0,0,0,0,1,1],
    [0,0,0,0,1,1],
    [0,0,0,0,1,1]
  ]},
  // 5 (w=8)
  { w: 8, pixels: [
    [1,1,1,1,1,1,1,0],
    [1,1,0,0,0,0,0,0],
    [1,1,0,0,0,0,0,0],
    [1,1,0,1,1,1,0,0],
    [1,1,1,0,0,1,1,0],
    [0,0,0,0,0,0,1,1],
    [0,0,0,0,0,0,1,1],
    [1,1,0,0,0,0,1,1],
    [0,1,1,0,0,1,1,0],
    [0,0,1,1,1,1,0,0]
  ]},
  // 6 (w=7)
  { w: 7, pixels: [
    [0,0,1,1,1,1,0],
    [0,1,1,0,0,1,1],
    [1,1,0,0,0,0,1],
    [1,1,0,0,0,0,0],
    [1,1,0,1,1,1,0],
    [1,1,1,0,0,1,1],
    [1,1,0,0,0,0,1],
    [1,1,0,0,0,0,1],
    [0,1,1,0,0,1,1],
    [0,0,1,1,1,1,0]
  ]},
  // 7 (w=8)
  { w: 8, pixels: [
    [1,1,1,1,1,1,1,1],
    [0,0,0,0,0,0,1,1],
    [0,0,0,0,0,0,1,1],
    [0,0,0,0,0,1,1,0],
    [0,0,0,0,1,1,0,0],
    [0,0,0,1,1,0,0,0],
    [0,0,1,1,0,0,0,0],
    [0,1,1,0,0,0,0,0],
    [1,1,0,0,0,0,0,0],
    [1,1,0,0,0,0,0,0]
  ]},
  // 8 (w=8)
  { w: 8, pixels: [
    [0,0,1,1,1,1,0,0],
    [0,1,1,0,0,1,1,0],
    [1,1,0,0,0,0,1,1],
    [0,1,1,0,0,1,1,0],
    [0,0,1,1,1,1,0,0],
    [0,1,1,0,0,1,1,0],
    [1,1,0,0,0,0,1,1],
    [1,1,0,0,0,0,1,1],
    [0,1,1,0,0,1,1,0],
    [0,0,1,1,1,1,0,0]
  ]},
  // 9 (w=7)
  { w: 7, pixels: [
    [0,1,1,1,1,0,0],
    [1,1,0,0,1,1,0],
    [1,0,0,0,0,1,1],
    [1,0,0,0,0,1,1],
    [1,1,0,0,1,1,1],
    [0,1,1,1,0,1,1],
    [0,0,0,0,0,1,1],
    [1,0,0,0,0,1,1],
    [1,1,0,0,1,1,0],
    [0,1,1,1,1,0,0]
  ]}
];

function _binarize(pixels, w, h, bpp) {
  var bin = new Array(h);
  for (var y = 0; y < h; y++) {
    bin[y] = new Uint8Array(w);
    for (var x = 0; x < w; x++) {
      var idx = x * bpp;
      var r = pixels[y][idx];
      var g = pixels[y][idx + 1];
      var b = pixels[y][idx + 2];
      var mx = Math.max(r, g, b);
      var mn = Math.min(r, g, b);
      // Threshold from main.py: r<110 && g<110 && b<170 && max-min<80
      bin[y][x] = (r < 110 && g < 110 && b < 170 && (mx - mn) < 80) ? 1 : 0;
    }
  }
  return bin;
}

function _segmentChars(bin, w, h) {
  // Vertical projection: count black pixels per column
  var proj = new Array(w);
  for (var x = 0; x < w; x++) {
    var count = 0;
    for (var y = 0; y < h; y++) {
      if (bin[y][x]) count++;
    }
    proj[x] = count;
  }
  // Find character segments by looking for gaps in projection
  var threshold = Math.round(h * 0.1); // at least 10% height
  var segments = [];
  var inChar = false;
  var start = 0;
  for (var x2 = 0; x2 < w; x2++) {
    if (proj[x2] >= threshold) {
      if (!inChar) {
        start = x2;
        inChar = true;
      }
    } else {
      if (inChar) {
        if (x2 - start >= 2) segments.push({ x1: start, x2: x2 - 1 });
        inChar = false;
      }
    }
  }
  if (inChar && w - start >= 2) segments.push({ x1: start, x2: w - 1 });
  // Filter out noise segments (too narrow/tall ratio)
  var refined = [];
  for (var si = 0; si < segments.length; si++) {
    var seg = segments[si];
    var segW = seg.x2 - seg.x1 + 1;
    if (segW >= 2 && segW <= w * 0.5) refined.push(seg);
  }
  return refined;
}

function _extractSegment(bin, seg, w, h) {
  var segW = seg.x2 - seg.x1 + 1;
  var data = new Array(h);
  for (var y = 0; y < h; y++) {
    data[y] = new Uint8Array(segW);
    for (var x = 0; x < segW; x++) {
      data[y][x] = bin[y][seg.x1 + x];
    }
  }
  return { data: data, w: segW, h: h };
}

function _cropSegVert(segData, segW, segH) {
  var y1 = segH, y2 = 0;
  for (var y = 0; y < segH; y++) {
    for (var x = 0; x < segW; x++) {
      if (segData[y][x]) { if (y < y1) y1 = y; if (y > y2) y2 = y; break; }
    }
  }
  if (y2 < y1) return null;
  var cropH = y2 - y1 + 1;
  var cropped = new Array(cropH);
  for (var y = y1; y <= y2; y++) {
    cropped[y - y1] = new Uint8Array(segW);
    for (var x = 0; x < segW; x++) cropped[y - y1][x] = segData[y][x];
  }
  return { data: cropped, w: segW, h: cropH };
}

function _digitMatchScore(segData, segW, segH, template) {
  var tw = template.w;
  var th = 10; // all templates are 10 rows
  if (segH !== th) return 0; // height must match (after cropping)
  // Determine which is shorter/longer in width
  var sw = segW < tw ? segW : tw;
  var lw = segW < tw ? tw : segW;
  var shortData = segW < tw ? segData : template.pixels;
  var longData = segW < tw ? template.pixels : segData;
  var maxScore = 0;
  for (var off = 0; off <= lw - sw; off++) {
    var matches = 0;
    for (var y = 0; y < th; y++) {
      for (var x = 0; x < sw; x++) {
        if (shortData[y][x] === longData[y][off + x]) matches++;
      }
    }
    var score = matches / (sw * th);
    if (score > maxScore) maxScore = score;
  }
  return maxScore;
}

function _classifyDigit(segData, segW, segH) {
  if (segH <= 0) return -1;
  var cropped = _cropSegVert(segData, segW, segH);
  if (!cropped || cropped.h < 8) return -1;
  var cw = cropped.w, ch = cropped.h;
  var bestScore = 0;
  var bestDigit = -1;
  for (var d = 0; d < 10; d++) {
    var tmpl = DIGIT_PIXELS[d];
    if (Math.abs(cw - tmpl.w) > 2) continue; // skip if width differs too much
    var score = _digitMatchScore(cropped.data, cw, ch, tmpl);
    if (score > bestScore) {
      bestScore = score;
      bestDigit = d;
    }
  }
  if (bestScore >= 0.75) return bestDigit;
  // Fallback: try width range ±3
  for (var d2 = 0; d2 < 10; d2++) {
    var tmpl2 = DIGIT_PIXELS[d2];
    if (Math.abs(cw - tmpl2.w) > 3) continue;
    var score2 = _digitMatchScore(cropped.data, cw, ch, tmpl2);
    if (score2 > bestScore) {
      bestScore = score2;
      bestDigit = d2;
    }
  }
  return bestScore >= 0.6 ? bestDigit : -1;
}

function _ocrSolve(imageB64) {
  var decoded = _pngDecode(imageB64);
  var bin = _binarize(decoded.pixels, decoded.width, decoded.height, decoded.bpp);
  var segs = _segmentChars(bin, decoded.width, decoded.height);
  if (segs.length < 3 || segs.length > 6) return null;
  var result = '';
  for (var si = 0; si < segs.length; si++) {
    var seg = _extractSegment(bin, segs[si], decoded.width, decoded.height);
    var digit = _classifyDigit(seg.data, seg.w, seg.h);
    if (digit < 0) return null;
    result += String(digit);
  }
  return result;
}

// =========================================================================
// CAPTCHA PAGE DETECTION & EXTRACTION
// =========================================================================
function _hasCaptcha(text) {
  var hasImg = /data:image\/(?:png|jpe?g);base64,/i.test(text);
  if (!hasImg) return false;
  if (/maxstream\.video\/uprots/i.test(text)) return false;
  var hasForm = /<input[^>]+\bname=["']?capt(?:cha|ch5|ch6)?["']?/i.test(text);
  return hasForm;
}

function _captchaImageSrc(text) {
  var m = text.match(/data:image\/(?:png|jpe?g);base64,[^"]+/i);
  return m ? m[0] : null;
}

function _formDataFromInputs(text, guess, captchaField) {
  var data = {};
  var inputRe = /<input\b[^>]*>/gi;
  var m;
  while ((m = inputRe.exec(text))) {
    var tag = m[0];
    var nameM = tag.match(/\bname=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
    if (!nameM) continue;
    var name = _decodeEntities(nameM[1] || nameM[2] || nameM[3] || '');
    var valueM = tag.match(/\bvalue=(?:"([^"]*)"|'([^']*)'|([^\s>]*))/i);
    var value = valueM ? _decodeEntities(valueM[1] || valueM[2] || valueM[3] || '') : '';
    var lowerName = name.toLowerCase();
    var isCaptcha = (lowerName.indexOf('capt') === 0 || /captcha|insert\s+numbers/i.test(tag));
    if (name && isCaptcha) {
      data[name] = guess;
    } else if (name) {
      data[name] = value;
    }
  }
  return data;
}

function _findCaptchaFormAction(text, baseUrl) {
  var formRe = /<form\b[^>]*>/gi;
  var m;
  while ((m = formRe.exec(text))) {
    if (m[0].toLowerCase().indexOf('data:image') >= 0 ||
        /name=["']?capt(?:cha|ch5|ch6)?["']?/i.test(m[0])) {
      var actionM = m[0].match(/\baction=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      if (actionM) {
        var action = _decodeEntities(actionM[1] || actionM[2] || actionM[3] || '').trim();
        if (action) return _resolveUrl(action, baseUrl);
      }
      return baseUrl;
    }
  }
  return baseUrl;
}

// =========================================================================
// HTML URL PATTERN PARSERS
// =========================================================================
function _findProceedToVideoUrl(text) {
  // clicka.cc/adelta/{id} -> Deltabit
  // clicka.cc/tva/{id}    -> Turbovid
  // clicka.cc/amix/{id}   -> MixDrop
  var m = text.match(/https?:\/\/clicka\.cc\/(?:adelta|tva|amix)\/[^"'<>\s]+/i);
  if (m) return m[0];
  // Direct video host links (with TLD)
  var dm = text.match(new RegExp('https?://[^\\s"\'>]*' + MD_PAT + '[^\\s"\'>]+', 'i'));
  if (dm) return dm[0];
  var dt = text.match(/https?:\/\/[^\s"'>]*?deltabit\.[a-z]+\/[A-Za-z0-9]{6,}/i);
  if (dt) return dt[0];
  var tv = text.match(/https?:\/\/[^\s"'>]*?turbovid\.[a-z]+\/[A-Za-z0-9]{6,}/i);
  if (tv) return tv[0];
  // "Proceed to video" button/link
  var aM = text.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>[\s\S]*?Proceed\s*to\s*video/i);
  return aM ? aM[1] : null;
}

function _findMixdropUrl(text) {
  var re = new RegExp('https?://[^\\s"\'>]*' + MD_PAT + '[^\\s"\'>]*/(?:e|f|emb|embed)/([A-Za-z0-9]+)', 'i');
  var m = text.match(re);
  return m ? { url: m[0], id: m[1] } : null;
}

function _findDeltabitUrl(text) {
  var m = text.match(/https?:\/\/(?:[a-z0-9.-]+\.)?deltabit\.[a-z]+\/([A-Za-z0-9]{6,})/i);
  return m ? m[0] : null;
}

function _findTurbovidUrl(text) {
  var m = text.match(/https?:\/\/(?:[a-z0-9.-]+\.)?(?:turbovid|turbovid)\.[a-z]+\/([A-Za-z0-9]{6,})/i);
  return m ? m[0] : null;
}

function _findNextUprotUrl(text, baseUrl) {
  var anchors = text.match(/<a\b[^>]*\bhref=(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi);
  if (!anchors) return null;
  // Priority: "Continue" links pointing to maxstream/clicka/uprots/adelta
  for (var ai = 0; ai < anchors.length; ai++) {
    var aTag = anchors[ai];
    var hrefM = aTag.match(/\bhref=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
    var labelM = aTag.match(/>([\s\S]*?)<\/a>/i);
    var href = hrefM ? (hrefM[1] || hrefM[2] || hrefM[3]) : null;
    var label = labelM ? labelM[1].replace(/<[^>]+>/g, '').toLowerCase().trim() : '';
    if (href && label.indexOf('continue') >= 0 && /(maxstream|clicka|uprots|adelta)/i.test(href)) {
      var resolved = _resolveUrl(href, baseUrl);
      if (resolved) return resolved;
    }
  }
  // Fallback: any "Continue" link
  for (var ai2 = 0; ai2 < anchors.length; ai2++) {
    var aTag2 = anchors[ai2];
    var hrefM2 = aTag2.match(/\bhref=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
    var labelM2 = aTag2.match(/>([\s\S]*?)<\/a>/i);
    var href2 = hrefM2 ? (hrefM2[1] || hrefM2[2] || hrefM2[3]) : null;
    var label2 = labelM2 ? labelM2[1].replace(/<[^>]+>/g, '').toLowerCase().trim() : '';
    if (href2 && label2.indexOf('continue') >= 0) {
      var resolved2 = _resolveUrl(href2, baseUrl);
      if (resolved2) return resolved2;
    }
  }
  return null;
}

function _findM3u8(text) {
  var pats = [
    /sources:\s*\[\s*\{\s*src:\s*["']([^"']+\.m3u8[^"']*)["']/i,
    /(?:file|src|url)\s*[:=]\s*["']([^"']+\.m3u8[^"']*)["']/i,
    /["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
    /(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i
  ];
  for (var pi = 0; pi < pats.length; pi++) {
    var mm = text.match(pats[pi]);
    if (mm && mm[1]) return mm[1].replace(/\\/g, '');
  }
  return null;
}

function _findStreamSource(text) {
  var pats = [
    /sources\s*:\s*\[\s*["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/i,
    /sources\s*:\s*\[\s*\{\s*(?:file|src|url)\s*:\s*["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/i,
    /(?:file|src|url)\s*[:=]\s*["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)["']/i,
    /["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)["']/i
  ];
  for (var pi = 0; pi < pats.length; pi++) {
    var mm = text.match(pats[pi]);
    if (mm && mm[1]) return mm[1].replace(/\\\//g, '/').replace(/\\/g, '');
  }
  return null;
}

function _isDeltabitHost(url) {
  try { return /(^|\.)deltabit\./.test(new URL(url).host); } catch(e) { return false; }
}

function _isTurbovidHost(url) {
  try {
    var h = new URL(url).host.toLowerCase();
    return /(turbovid)/.test(h);
  } catch(e) { return false; }
}

function _isMixdropHost(url) {
  try {
    var h = new URL(url).host.toLowerCase();
    return new RegExp(MD_PAT).test(h);
  } catch(e) { return false; }
}

// =========================================================================
// PACKED JS UNPACKER (Packer by Dean Edwards)
// =========================================================================
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
  return p.replace(/\b(\w+)\b/g, function(_, w) { return dict[w] !== undefined ? dict[w] : w; });
}

// =========================================================================
// CLICKA.CC CAPTCHA SOLVER
// =========================================================================
function _solveCaptchaPage(text, currentUrl, jar) {
  return new Promise(function(resolve, reject) {
    if (!_hasCaptcha(text)) return resolve({ text: text, url: currentUrl });
    var imageSrc = _captchaImageSrc(text);
    if (!imageSrc) return reject(new Error('captcha image not found'));
    // Extract base64 data from data URI
    var b64 = imageSrc.replace(/^data:image\/(?:png|jpe?g);base64,/, '');
    var guess = _ocrSolve(b64);
    if (!guess || guess.length < 3 || guess.length > 6) {
      return reject(new Error('OCR failed to solve captcha'));
    }
    var action = _findCaptchaFormAction(text, currentUrl);
    var formData = _formDataFromInputs(text, guess);
    _clickaPost(action, formData, currentUrl, jar)
      .then(function(postRes) {
        if (_hasCaptcha(postRes.text)) {
          var _pv = _findProceedToVideoUrl(postRes.text);
          if (!_pv) {
            return reject(new Error('captcha still present after POST'));
          }
        }
        resolve({ text: postRes.text, url: action });
      })
      .catch(function(err) { reject(err); });
  });
}

// =========================================================================
// MIXDROP EXTRACTION (promise-based)
// =========================================================================
function fetchMixDrop(host, id) {
  return new Promise(function(resolve, reject) {
    var headers = {
      'User-Agent': ES_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding': 'identity',
      'Referer': 'https://' + host + '/'
    };
    var url = 'https://' + host + '/e/' + id;
    fetch(url, { headers: headers, timeout: 15000 })
      .then(function(r) { return r.text(); })
      .then(function(html) {
        var combined = html;
        var packerRe = /eval\(function\(p,a,c,k,e,d\)[\s\S]*?\}\([\s\S]*?\.split\(['"]\|['"]\)[\s\S]*?\)\s*\)/g;
        var pm;
        while ((pm = packerRe.exec(html)) !== null) {
          var unpacked = unpackPackedJs(pm[0]);
          if (unpacked) combined += '\n' + unpacked;
        }
        var streamUrl = _findStreamSource(combined);
        if (!streamUrl) {
          // Try MD-specific patterns
          var mdPats = [
            /(?:MDCore|vsConfig)\.wurl\s*=\s*["']([^"']+)["']/,
            /wurl\s*[:=]\s*["']([^"']+)["']/,
            /<source\s+[^>]*src=["']([^"']+)["']/i,
            /file\s*:\s*["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/
          ];
          for (var pi = 0; pi < mdPats.length; pi++) {
            var mm = combined.match(mdPats[pi]);
            if (mm && mm[1]) {
              streamUrl = mm[1].trim();
              if (streamUrl.indexOf('//') === 0) streamUrl = 'https:' + streamUrl;
              break;
            }
          }
        }
        if (!streamUrl) return reject(new Error('MixDrop stream URL not found for ' + host + '/' + id));
        resolve(streamUrl);
      })
      .catch(function(err) { reject(err); });
  });
}

function tryMixDropHosts(id) {
  var idx = 0;
  var lastErr = null;
  function next() {
    if (idx >= MD_HOSTS.length) {
      return Promise.reject(new Error('MixDrop all hosts failed: ' + (lastErr || 'unknown')));
    }
    var host = MD_HOSTS[idx++];
    return fetchMixDrop(host, id).then(function(streamUrl) {
      return { url: streamUrl, host: host };
    }).catch(function(err) {
      lastErr = err.message;
      return next();
    });
  }
  return next();
}

// =========================================================================
// TURBOVID EXTRACTION  (GET landing -> parse form -> POST imhuman -> source)
// =========================================================================
function extractTurbovid(pageUrl, jar) {
  return new Promise(function(resolve, reject) {
    var landingHeaders = {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.8,it;q=0.7',
      'Accept-Encoding': 'identity',
      'Referer': 'https://safego.cc/'
    };
    var cookieStr = _jarGet(pageUrl, jar);
    if (cookieStr) landingHeaders['Cookie'] = cookieStr;
    fetch(pageUrl, { headers: landingHeaders, timeout: 15000 })
      .then(function(r) {
        try {
          if (r.headers && r.headers.get) {
            var sc = r.headers.get('set-cookie') || r.headers.get('Set-Cookie');
            if (sc) _jarSet(pageUrl, sc, jar);
          }
        } catch(e) {}
        return r.text();
      })
      .then(function(html) {
        // Try inline source first
        var finalOrigin = (function() { try { return new URL(pageUrl).origin; } catch(e) { return ''; } })();
        var source = _findStreamSource(html);
        if (source) return resolve({ url: source, headers: { 'User-Agent': landingHeaders['User-Agent'], 'Referer': pageUrl, 'Origin': finalOrigin } });
        // Parse form
        var formData = {};
        var ir = /<input\b[^>]*>/gi;
        var im;
        while ((im = ir.exec(html))) {
          var tag = im[0];
          var nameM = tag.match(/\bname=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
          if (!nameM) continue;
          var name = _decodeEntities(nameM[1] || nameM[2] || nameM[3] || '');
          var valueM = tag.match(/\bvalue=(?:"([^"]*)"|'([^']*)'|([^\s>]*))/i);
          var value = valueM ? _decodeEntities(valueM[1] || valueM[2] || valueM[3] || '') : '';
          if (name) formData[name] = value;
        }
        if (!formData.op) return reject(new Error('Turbovid: form op not found'));
        formData.imhuman = 'Proceed+to+video';
        formData.referer = pageUrl;
        var postHeaders = {
          'User-Agent': landingHeaders['User-Agent'],
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.8,it;q=0.7',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Origin': finalOrigin,
          'Referer': pageUrl
        };
        var cookieStr2 = _jarGet(pageUrl, jar);
        if (cookieStr2) postHeaders['Cookie'] = cookieStr2;
        // Sleep 5s before POST (Turbovid requires delay)
        return _sleep(5000).then(function() {
          return fetch(pageUrl, { method: 'POST', headers: postHeaders, body: _formEncode(formData), timeout: 30000 });
        });
      })
      .then(function(r) {
        try {
          if (r.headers && r.headers.get) {
            var sc = r.headers.get('set-cookie') || r.headers.get('Set-Cookie');
            if (sc) _jarSet(pageUrl, sc, jar);
          }
        } catch(e) {}
        return r.text();
      })
      .then(function(html) {
        var finalOrigin = (function() { try { return new URL(pageUrl).origin; } catch(e) { return ''; } })();
        // Search source in POST response
        var source = _findStreamSource(html);
        if (!source) {
          // Try unpacking packed JS
          var combined = html;
          var packerRe = /eval\(function\(p,a,c,k,e,d\)[\s\S]*?\}\([\s\S]*?\.split\(['"]\|['"]\)[\s\S]*?\)\s*\)/g;
          var pm;
          while ((pm = packerRe.exec(html)) !== null) {
            var unpacked = unpackPackedJs(pm[0]);
            if (unpacked) combined += '\n' + unpacked;
          }
          source = _findStreamSource(combined);
        }
        if (!source) {
          // Retry GET after POST
          var retryHeaders = {
            'User-Agent': landingHeaders['User-Agent'],
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.8,it;q=0.7',
            'Accept-Encoding': 'identity',
            'Referer': 'https://safego.cc/'
          };
          var cstr = _jarGet(pageUrl, jar);
          if (cstr) retryHeaders['Cookie'] = cstr;
          return fetch(pageUrl, { headers: retryHeaders, timeout: 15000 })
            .then(function(r2) { return r2.text(); })
            .then(function(html2) {
              source = _findStreamSource(html2);
              if (!source) return reject(new Error('Turbovid: stream source not found'));
              resolve({ url: source, headers: { 'User-Agent': landingHeaders['User-Agent'], 'Referer': pageUrl, 'Origin': finalOrigin } });
            });
        }
        resolve({ url: source, headers: { 'User-Agent': landingHeaders['User-Agent'], 'Referer': pageUrl, 'Origin': finalOrigin } });
      })
      .catch(function(err) { reject(err); });
  });
}

// =========================================================================
// DELTABIT EXTRACTION (similar to Turbovid but imhuman='' and 2.5s sleep)
// =========================================================================
function extractDeltabit(pageUrl, jar) {
  return new Promise(function(resolve, reject) {
    var landingHeaders = {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.8,it;q=0.7',
      'Accept-Encoding': 'identity',
      'Referer': 'https://safego.cc/'
    };
    var cookieStr = _jarGet(pageUrl, jar);
    if (cookieStr) landingHeaders['Cookie'] = cookieStr;
    fetch(pageUrl, { headers: landingHeaders, timeout: 15000 })
      .then(function(r) {
        try {
          if (r.headers && r.headers.get) {
            var sc = r.headers.get('set-cookie') || r.headers.get('Set-Cookie');
            if (sc) _jarSet(pageUrl, sc, jar);
          }
        } catch(e) {}
        return r.text();
      })
      .then(function(html) {
        var finalOrigin = (function() { try { return new URL(pageUrl).origin; } catch(e) { return ''; } })();
        var source = _findStreamSource(html);
        if (source) return resolve({ url: source, headers: { 'User-Agent': landingHeaders['User-Agent'], 'Referer': pageUrl, 'Origin': finalOrigin } });
        // Parse form
        var formData = {};
        var ir = /<input\b[^>]*>/gi;
        var im;
        while ((im = ir.exec(html))) {
          var tag = im[0];
          var nameM = tag.match(/\bname=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
          if (!nameM) continue;
          var name = _decodeEntities(nameM[1] || nameM[2] || nameM[3] || '');
          var valueM = tag.match(/\bvalue=(?:"([^"]*)"|'([^']*)'|([^\s>]*))/i);
          var value = valueM ? _decodeEntities(valueM[1] || valueM[2] || valueM[3] || '') : '';
          if (name) formData[name] = value;
        }
        if (!formData.op) return reject(new Error('Deltabit: form op not found'));
        formData.imhuman = '';
        formData.referer = pageUrl;
        var postHeaders = {
          'User-Agent': landingHeaders['User-Agent'],
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.8,it;q=0.7',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Origin': finalOrigin,
          'Referer': pageUrl
        };
        var cookieStr2 = _jarGet(pageUrl, jar);
        if (cookieStr2) postHeaders['Cookie'] = cookieStr2;
        // Sleep 2.5s before POST
        return _sleep(2500).then(function() {
          return fetch(pageUrl, { method: 'POST', headers: postHeaders, body: _formEncode(formData), timeout: 30000 });
        });
      })
      .then(function(r) {
        try {
          if (r.headers && r.headers.get) {
            var sc = r.headers.get('set-cookie') || r.headers.get('Set-Cookie');
            if (sc) _jarSet(pageUrl, sc, jar);
          }
        } catch(e) {}
        return r.text();
      })
      .then(function(html) {
        var finalOrigin = (function() { try { return new URL(pageUrl).origin; } catch(e) { return ''; } })();
        var source = _findStreamSource(html);
        if (!source) {
          var combined = html;
          var packerRe = /eval\(function\(p,a,c,k,e,d\)[\s\S]*?\}\([\s\S]*?\.split\(['"]\|['"]\)[\s\S]*?\)\s*\)/g;
          var pm;
          while ((pm = packerRe.exec(html)) !== null) {
            var unpacked = unpackPackedJs(pm[0]);
            if (unpacked) combined += '\n' + unpacked;
          }
          source = _findStreamSource(combined);
        }
        if (!source) {
          // Retry GET
          var retryHeaders = {
            'User-Agent': landingHeaders['User-Agent'],
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.8,it;q=0.7',
            'Accept-Encoding': 'identity',
            'Referer': 'https://safego.cc/'
          };
          var cstr = _jarGet(pageUrl, jar);
          if (cstr) retryHeaders['Cookie'] = cstr;
          return fetch(pageUrl, { headers: retryHeaders, timeout: 15000 })
            .then(function(r2) { return r2.text(); })
            .then(function(html2) {
              source = _findStreamSource(html2);
              if (!source) return reject(new Error('Deltabit: stream source not found'));
              resolve({ url: source, headers: { 'User-Agent': landingHeaders['User-Agent'], 'Referer': pageUrl, 'Origin': finalOrigin } });
            });
        }
        resolve({ url: source, headers: { 'User-Agent': landingHeaders['User-Agent'], 'Referer': pageUrl, 'Origin': finalOrigin } });
      })
      .catch(function(err) { reject(err); });
  });
}

// =========================================================================
// FOLLOW REDIRECTOR PAGE  (clicka.cc/adelta/tva/amix -> upstream URL)
// =========================================================================
function _followRedirector(url, referer, jar) {
  return _clickaFetch(url, referer, jar).then(function(res) {
    var text = res.text;
    // Meta refresh
    var metaM = text.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+url=["']?([^"'>\s]+)/i);
    if (metaM) {
      var upUrl = _resolveUrl(metaM[1], url);
      if (upUrl) return upUrl;
    }
    // Canonical
    var canM = text.match(/<link[^>]+rel=["']?canonical["']?[^>]+href=["']([^"']+)["']/i);
    if (canM) return canM[1];
    // Form action - relative or absolute, resolve against current URL
    var formM = text.match(/<form[^>]+action=["']([^"']+)["']/i);
    if (formM && formM[1] && formM[1] !== '#') {
      var actionUrl = _resolveUrl(formM[1], res.url || url);
      if (actionUrl) return actionUrl;
    }
    // Direct link to deltabit/turbovid/mixdrop
    var dlM = text.match(new RegExp('https?://[^\\s"\'>]*(?:deltabit|turbovid|' + MD_PAT + ')[^\\s"\'>]*', 'i'));
    if (dlM) return dlM[0];
    // Fallback to the response URL
    return res.url || url;
  });
}

// =========================================================================
// CLICKA.CC MAIN RESOLVER
// =========================================================================
function resolveClickacc(startUrl, kind, jar) {
  var current = startUrl;
  var ES_DOMAIN = 'https://eurostreamings.makeup';
  var referer = ES_DOMAIN + '/';
  var activeJar = jar || {};
  function loop(hop) {
    if (hop >= 6) return Promise.reject(new Error('Clickacc: max hops reached'));
    // Check if current is a redirector URL (clicka.cc/adelta|tva|amix)
    var isRedirector = false;
    try {
      var uPath = new URL(current).pathname;
      var uHost = new URL(current).host.toLowerCase();
      isRedirector = (uHost === 'clicka.cc') && /^\/(adelta|tva|amix)\//.test(uPath);
    } catch(e) {}
    if (isRedirector) {
      return _followRedirector(current, referer, activeJar).then(function(upUrl) {
        if (upUrl === current) return Promise.reject(new Error('Clickacc: redirector did not resolve'));
        referer = current;
        current = upUrl;
        return loop(hop + 1);
      });
    }
    // Check if we're already on a video host
    if (kind === 'mix' && _isMixdropHost(current)) {
      var mixMatch = current.match(/\/(?:e|f|emb|embed)\/([A-Za-z0-9]+)/i);
      if (mixMatch) {
        return tryMixDropHosts(mixMatch[1]).then(function(res) {
          return {
            url: _buildProxyUrl(res.url, 'https://' + res.host + '/', ES_UA),
            name: 'Eurostreaming',
            title: 'MixDrop',
            behaviorHints: { notWebReady: true }
          };
        }).catch(function() {
          return Promise.reject(new Error('MixDrop extraction failed'));
        });
      }
    }
    if (kind === 'tv' && _isTurbovidHost(current)) {
      return extractTurbovid(current, activeJar).then(function(video) {
        return {
          url: _buildProxyUrl(video.url, current, video.headers['User-Agent'], video.headers['Origin']),
          name: 'Eurostreaming',
          title: 'Turbovid',
          behaviorHints: { notWebReady: true }
        };
      });
    }
    if (kind === 'delta' && _isDeltabitHost(current)) {
      return extractDeltabit(current, activeJar).then(function(video) {
        return {
          url: _buildProxyUrl(video.url, current, video.headers['User-Agent'], video.headers['Origin']),
          name: 'Eurostreaming',
          title: 'Deltabit',
          behaviorHints: { notWebReady: true }
        };
      });
    }
    // Fetch current URL (captcha page, safego, etc.)
    return _clickaFetch(current, referer, activeJar).then(function(res) {
      var text = res.text;
      var finalUrl = res.url || current;
      // Check for captcha
      if (_hasCaptcha(text)) {
        return _solveCaptchaPage(text, finalUrl, activeJar).then(function(solved) {
          text = solved.text;
          // After captcha, check for "Proceed to video"
          var proceedUrl = _findProceedToVideoUrl(text);
          if (proceedUrl && proceedUrl !== current) {
            referer = finalUrl;
            current = proceedUrl;
            return loop(hop + 1);
          }
          // Check for mixdrop (kind=mix)
          if (kind === 'mix') {
            var md = _findMixdropUrl(text);
            if (md) return tryMixDropHosts(md.id).then(function(res) {
              return {
                url: _buildProxyUrl(res.url, 'https://' + res.host + '/', ES_UA),
                name: 'Eurostreaming',
                title: 'MixDrop',
                behaviorHints: { notWebReady: true }
              };
            });
          }
          // Check for m3u8
          var m3u8Url = _findM3u8(text);
          if (m3u8Url) return { url: m3u8Url, name: 'Eurostreaming', title: 'Stream', behaviorHints: { notWebReady: true } };
          // Next continue URL
          var nextUrl = _findNextUprotUrl(text, finalUrl);
          if (!nextUrl || nextUrl === current) return Promise.reject(new Error('Clickacc: no next URL after captcha'));
          referer = finalUrl;
          current = nextUrl;
          return loop(hop + 1);
        });
      }
      // No captcha - check for proceed-to-video
      var proceedUrl2 = _findProceedToVideoUrl(text);
      if (proceedUrl2 && proceedUrl2 !== current) {
        referer = finalUrl;
        current = proceedUrl2;
        return loop(hop + 1);
      }
      // Check for mixdrop (kind=mix)
      if (kind === 'mix') {
        var md2 = _findMixdropUrl(text);
        if (md2) return tryMixDropHosts(md2.id).then(function(res) {
          return {
            url: _buildProxyUrl(res.url, 'https://' + res.host + '/', ES_UA),
            name: 'Eurostreaming',
            title: 'MixDrop',
            behaviorHints: { notWebReady: true }
          };
        });
      }
      // Check for m3u8 inline
      var m3u8Url2 = _findM3u8(text);
      if (m3u8Url2) return { url: m3u8Url2, name: 'Eurostreaming', title: 'Stream', behaviorHints: { notWebReady: true } };
      // Next continue URL
      var nextUrl2 = _findNextUprotUrl(text, finalUrl);
      if (!nextUrl2 || nextUrl2 === current) return Promise.reject(new Error('Clickacc: dead end'));
      referer = finalUrl;
      current = nextUrl2;
      return loop(hop + 1);
    });
  }
  return loop(0);
}

// =========================================================================
// =========================================================================
// TMDB API helper (used as fallback when Cinemeta fails)
// =========================================================================
var TMDB_API_KEY = '68e094699525b18a70bab2f86b1fa706';

function _tmdbSeriesName(id) {
  return new Promise(function(resolve) {
    var cleanId = String(id || '').replace(/^tmdb:/, '');
    if (/^tt\d+$/.test(cleanId)) {
      fetch('https://api.themoviedb.org/3/find/' + cleanId + '?api_key=' + TMDB_API_KEY + '&external_source=imdb_id&language=it-IT', { timeout: 10000 })
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(data) {
          if (data && data.tv_results && data.tv_results.length > 0) {
            resolve(data.tv_results[0].name || data.tv_results[0].original_name || null);
          } else {
            resolve(null);
          }
        })
        .catch(function() { resolve(null); });
    } else if (/^\d+$/.test(cleanId)) {
      fetch('https://api.themoviedb.org/3/tv/' + cleanId + '?api_key=' + TMDB_API_KEY + '&language=it-IT', { timeout: 10000 })
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(data) { resolve(data && (data.name || data.original_name) ? data.name : null); })
        .catch(function() { resolve(null); });
    } else {
      resolve(null);
    }
  });
}

// =========================================================================
// ENTRY POINT
// =========================================================================
function getStreams(id, type, season, episode) {
  return new Promise(function (resolve, reject) {
    var rawId = String(id || '').replace(/^tmdb:/, '');
    var mediaType = String(type || 'movie').toLowerCase();

    if (mediaType !== 'series' && mediaType !== 'tv') return resolve([]);

    var seasonNum = Number(season) || 1;
    var episodeNum = Number(episode) || 1;

    // Determine best IMDb ID and TMDB ID available.
    // Nuvio server sets sandbox.__imdb_id = original IMDb/TMDB id.
    // getStreams(id) receives the TMDB numeric id after Cinemeta translation.
    var sandboxImdb = (typeof __imdb_id !== 'undefined' && __imdb_id) ? String(__imdb_id) : null;
    var isImdb = function(s) { return /^tt\d+$/.test(String(s || '')); };
    var isNumeric = function(s) { return /^\d+$/.test(String(s || '')); };

    var imdbCandidate = null; // tt... for Cinemeta
    var tmdbCandidate = null; // numeric for TMDB API

    if (isImdb(rawId))    { imdbCandidate = rawId; }
    else if (isNumeric(rawId)) { tmdbCandidate = rawId; }

    if (sandboxImdb && isImdb(sandboxImdb))   { imdbCandidate = sandboxImdb; }
    else if (sandboxImdb && isNumeric(sandboxImdb) && !tmdbCandidate) { tmdbCandidate = sandboxImdb; }

    function doSearch(title) {
      getEsDomain(function (domain) {
        if (!domain) return resolve([]);
        searchSeries(domain, title, seasonNum, function (pageUrl) {
          if (!pageUrl) return resolve([]);
          extractLinksFromPage(domain, pageUrl, seasonNum, episodeNum, function (streams) {
            resolve(streams || []);
          });
        });
      });
    }

    function tryTmdbDirect() {
      if (tmdbCandidate) {
        _tmdbSeriesName(tmdbCandidate).then(function(title) {
          if (title) return doSearch(title);
          resolve([]);
        }).catch(function() { resolve([]); });
      } else {
        resolve([]);
      }
    }

    if (imdbCandidate) {
      // 1st: Cinemeta with IMDb
      getCinemetaMeta('series', imdbCandidate, function(err, meta) {
        if (meta && meta.name) return doSearch(meta.name);
        // 2nd: TMDB external lookup by IMDb ID
        _tmdbSeriesName(imdbCandidate).then(function(title) {
          if (title) return doSearch(title);
          // 3rd: TMDB direct with numeric ID
          tryTmdbDirect();
        }).catch(function() { tryTmdbDirect(); });
      });
    } else {
      // No IMDb ID — go straight to TMDB numeric
      tryTmdbDirect();
    }
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
    'Referer': 'https://eurostreamings.makeup/'
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
      cb('https://eurostreamings.makeup');
    })
    .catch(function () { cb('https://eurostreamings.makeup'); });
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

// =========================================================================
// extractLinksFromPage - Python es.py approach (regex entire HTML)
// =========================================================================
function extractLinksFromPage(domain, pageUrl, seasonNum, episodeNum, cb) {
  esFetch(pageUrl, function (err, html) {
    if (err || !html) return cb(null);
    var streams = [];
    var seen = {};

    // Match episode line: "1×01" / "1&#215;01" / "S01E01" (like Python es.py)
    var ep2 = episodeNum < 10 ? '0' + String(episodeNum) : String(episodeNum);
    var patterns = [
      seasonNum + '\\s*(?:&#215;|×|x)\\s*0?' + episodeNum + '[\\s\\S]{0,1800}?(?=<br\\s*/?>|</div>)',
      'S0?' + seasonNum + 'E' + ep2 + '[\\s\\S]{0,1800}?(?=<br\\s*/?>|</div>)'
    ];
    var block = null;
    for (var pi = 0; pi < patterns.length; pi++) {
      var m = html.match(new RegExp(patterns[pi], 'i'));
      if (m) { block = m[0]; break; }
    }
    if (!block) block = html;

    // Extract clicka.cc URLs from the matched region
    var clickaTasks = [];
    var clickaRe = /https?:\/\/clicka\.cc\/(tv|mix|delta)\/[A-Za-z0-9]+/gi;
    var cm;
    while ((cm = clickaRe.exec(block)) !== null) {
      if (!seen[cm[0]]) { seen[cm[0]] = true; clickaTasks.push({ url: cm[0], kind: cm[1] }); }
    }
    // Fallback: search entire HTML for clicka.cc URLs
    if (clickaTasks.length === 0) {
      while ((cm = clickaRe.exec(html)) !== null) {
        if (!seen[cm[0]]) { seen[cm[0]] = true; clickaTasks.push({ url: cm[0], kind: cm[1] }); }
      }
    }

    // Also extract direct MixDrop URLs (from entire page)
    var mdRe = new RegExp('https?://[^\\s"\'>]*' + MD_PAT + '[^\\s"\'>]*/[A-Za-z0-9]+', 'gi');
    while ((cm = mdRe.exec(html)) !== null) {
      if (!seen[cm[0]]) {
        seen[cm[0]] = true;
        streams.push({
          url: cm[0],
          name: 'Eurostreaming',
          title: 'MixDrop',
          behaviorHints: { notWebReady: true }
        });
      }
    }
    // Search inside JS strings too
    var jsUrlRe = /["'](https?:\/\/[^"']+)["']/g;
    var jm;
    while ((jm = jsUrlRe.exec(html)) !== null) {
      var mdRe2 = new RegExp('https?://[^\\s"\'>]*' + MD_PAT + '[^\\s"\'>]*/[A-Za-z0-9]+', 'gi');
      while ((cm = mdRe2.exec(jm[1])) !== null) {
        if (!seen[cm[0]]) {
          seen[cm[0]] = true;
          streams.push({
            url: cm[0],
            name: 'Eurostreaming',
            title: 'MixDrop',
            behaviorHints: { notWebReady: true }
          });
        }
      }
    }

    if (clickaTasks.length === 0) return cb(streams.length > 0 ? streams : null);

    // Resolve clicka.cc URLs in parallel with an overall scraper timeout of 12s
    var resolved = false;
    var timer = setTimeout(function() {
      if (!resolved) {
        resolved = true;
        console.log('[ES] Overall scraper timeout of 12s reached. Returning ' + streams.length + ' streams.');
        cb(streams.length > 0 ? streams : null);
      }
    }, 12000);

    var pending = clickaTasks.length;
    clickaTasks.forEach(function(task) {
      var taskJar = {};
      var timeoutPromise = new Promise(function(_, reject) {
        // Individual link timeout remains 25s to allow Turbovid to finish if it can
        setTimeout(function() { reject(new Error('Timeout resolving link')); }, 25000);
      });
      Promise.race([
        resolveClickacc(task.url, task.kind, taskJar),
        timeoutPromise
      ])
      .then(function(streamObj) {
        if (streamObj && streamObj.url && !seen[streamObj.url]) {
          seen[streamObj.url] = true;
          streams.push(streamObj);
        }
      })
      .catch(function(err) {
        console.log('[ES] clicka resolve failed/timeout: ' + task.url + ' - ' + (err.message || err));
      })
      .then(function() {
        pending--;
        if (pending === 0 && !resolved) {
          clearTimeout(timer);
          resolved = true;
          cb(streams.length > 0 ? streams : null);
        }
      });
    });
  });
}

module.exports = { getStreams: getStreams };
