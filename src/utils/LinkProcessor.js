/**
 * LinkProcessor — extracts, validates, and fetches content from URLs found
 * in WhatsApp message text for inclusion in Claude context.
 */

const https = require('https');
const http  = require('http');
const { URL } = require('url');

// Maximum response body size to fetch (bytes) — avoid pulling in huge pages
const MAX_FETCH_BYTES = 512 * 1024; // 512 KB

// Content types we consider readable text
const TEXT_CONTENT_TYPES = new Set([
  'text/html',
  'text/plain',
  'application/json',
  'application/xml',
  'text/xml',
  'text/csv',
]);

// Regex that matches http/https URLs (including those without explicit scheme via www.)
const URL_PATTERN = /https?:\/\/[^\s<>"']+|www\.[^\s<>"']+/gi;

/**
 * Extract all URLs from a plain-text string.
 * @param {string} text
 * @returns {string[]} deduplicated list of URL strings
 */
function extractUrls(text) {
  if (!text || typeof text !== 'string') return [];
  const matches = text.match(URL_PATTERN) ?? [];
  // Normalise www. links to include https://
  const normalised = matches.map(u =>
    u.startsWith('www.') ? `https://${u}` : u
  );
  // Deduplicate while preserving order
  return [...new Set(normalised)];
}

/**
 * Determine whether a URL string is valid and uses http/https.
 * @param {string} urlString
 * @returns {boolean}
 */
function isValidUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Determine the content category for a content-type header value.
 * @param {string} contentType  e.g. 'text/html; charset=utf-8'
 * @returns {'text'|'image'|'pdf'|'other'}
 */
function categoriseContentType(contentType) {
  if (!contentType) return 'other';
  const base = contentType.split(';')[0].trim().toLowerCase();
  if (TEXT_CONTENT_TYPES.has(base)) return 'text';
  if (base.startsWith('image/'))          return 'image';
  if (base === 'application/pdf')         return 'pdf';
  return 'other';
}

/**
 * Perform an HTTP/HTTPS GET request and return up to MAX_FETCH_BYTES of body.
 * Follows up to one redirect.
 * @param {string} urlString
 * @param {number} [redirectsLeft=1]
 * @returns {Promise<{ statusCode: number, contentType: string, body: string }>}
 */
function fetchUrl(urlString, redirectsLeft = 1) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch (err) {
      return reject(new Error(`Invalid URL: ${urlString}`));
    }

    const transport = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RemoteEngineeringAgents/1.0)',
        'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: 10000,
    };

    const req = transport.request(options, (res) => {
      const { statusCode, headers } = res;

      // Follow a single redirect
      if ((statusCode === 301 || statusCode === 302 || statusCode === 307 || statusCode === 308)
          && headers.location && redirectsLeft > 0) {
        res.resume(); // discard body
        return resolve(fetchUrl(headers.location, redirectsLeft - 1));
      }

      const contentType = headers['content-type'] ?? '';
      const chunks = [];
      let totalBytes = 0;

      res.on('data', (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes <= MAX_FETCH_BYTES) {
          chunks.push(chunk);
        } else {
          // Truncate — push only what fits
          const remaining = MAX_FETCH_BYTES - (totalBytes - chunk.length);
          if (remaining > 0) chunks.push(chunk.slice(0, remaining));
          res.destroy();
        }
      });

      res.on('end', () => {
        resolve({
          statusCode,
          contentType,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });

      res.on('error', reject);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timed out: ${urlString}`));
    });

    req.on('error', reject);
    req.end();
  });
}

/**
 * Strip HTML tags from a string and collapse whitespace.
 * @param {string} html
 * @returns {string}
 */
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Process a single URL: validate, fetch, and return a structured result.
 * @param {string} urlString
 * @returns {Promise<{
 *   url: string,
 *   valid: boolean,
 *   category: 'text'|'image'|'pdf'|'other',
 *   statusCode: number|null,
 *   contentType: string|null,
 *   textContent: string|null,
 *   error: string|null,
 * }>}
 */
async function processUrl(urlString) {
  if (!isValidUrl(urlString)) {
    return {
      url: urlString,
      valid: false,
      category: 'other',
      statusCode: null,
      contentType: null,
      textContent: null,
      error: 'Invalid or unsupported URL',
    };
  }

  try {
    const { statusCode, contentType, body } = await fetchUrl(urlString);
    const category = categoriseContentType(contentType);

    let textContent = null;
    if (category === 'text') {
      const base = contentType.split(';')[0].trim().toLowerCase();
      textContent = base === 'text/html' ? stripHtml(body) : body;
    }

    return {
      url: urlString,
      valid: true,
      category,
      statusCode,
      contentType,
      textContent,
      error: null,
    };
  } catch (err) {
    return {
      url: urlString,
      valid: true,
      category: 'other',
      statusCode: null,
      contentType: null,
      textContent: null,
      error: err.message,
    };
  }
}

/**
 * Extract all URLs from text, validate them, fetch their content, and return
 * structured results for each URL.
 * @param {string} text
 * @returns {Promise<Array<object>>}
 */
async function processLinksFromText(text) {
  const urls = extractUrls(text);
  if (urls.length === 0) return [];
  return Promise.all(urls.map(processUrl));
}

module.exports = {
  extractUrls,
  isValidUrl,
  categoriseContentType,
  fetchUrl,
  processUrl,
  processLinksFromText,
};
