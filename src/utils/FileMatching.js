/**
 * FileMatching — resolves vague or partial file references from natural language
 * to actual filesystem paths.
 *
 * Provides:
 *   - Fuzzy name matching (partial substrings, ignoring case)
 *   - Extension-based search ("send the pdf", "that spreadsheet")
 *   - Ranked results so callers can pick the best match or ask for clarification
 */

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Extension aliases — maps natural-language type words to file extensions
// ---------------------------------------------------------------------------

const TYPE_ALIASES = {
  // Documents
  document:    ['.doc', '.docx', '.odt', '.rtf', '.txt'],
  doc:         ['.doc', '.docx'],
  word:        ['.doc', '.docx'],
  pdf:         ['.pdf'],
  text:        ['.txt'],
  spreadsheet: ['.xls', '.xlsx', '.csv', '.ods'],
  excel:       ['.xls', '.xlsx'],
  csv:         ['.csv'],
  presentation:['.ppt', '.pptx', '.odp'],
  slide:       ['.ppt', '.pptx'],
  slides:      ['.ppt', '.pptx'],
  // Images
  image:       ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'],
  photo:       ['.png', '.jpg', '.jpeg', '.gif', '.webp'],
  picture:     ['.png', '.jpg', '.jpeg', '.gif', '.webp'],
  // Archives
  archive:     ['.zip', '.tar', '.gz', '.rar', '.7z'],
  zip:         ['.zip'],
  // Data / code
  json:        ['.json'],
  xml:         ['.xml'],
  html:        ['.html', '.htm'],
  // Audio / video
  audio:       ['.mp3', '.wav', '.ogg', '.flac', '.aac'],
  video:       ['.mp4', '.webm', '.mov', '.avi', '.mkv'],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively collect all file paths under a directory up to a depth limit.
 * Symlinks to directories are followed once; circular links are skipped.
 *
 * @param {string}   dir       - absolute directory path to scan
 * @param {number}   maxDepth  - how many levels deep to recurse (default 4)
 * @param {Set<string>} _seen  - internal set for cycle detection (do not pass)
 * @returns {string[]} list of absolute file paths
 */
function collectFiles(dir, maxDepth = 4, _seen = new Set()) {
  const results = [];

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return results;
  }

  const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', 'dist', 'build', '.cache']);

  for (const entry of entries) {
    // Skip known large/irrelevant directories
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;

    const full = path.join(dir, entry.name);

    // Resolve symlinks so we can detect cycles
    let realFull = full;
    if (entry.isSymbolicLink()) {
      try {
        realFull = fs.realpathSync(full);
      } catch (_) {
        continue;
      }
    }

    if (entry.isFile() || (entry.isSymbolicLink() && isFile(realFull))) {
      results.push(full);
    } else if (
      (entry.isDirectory() || entry.isSymbolicLink()) &&
      maxDepth > 0 &&
      !_seen.has(realFull)
    ) {
      _seen.add(realFull);
      results.push(...collectFiles(realFull, maxDepth - 1, _seen));
    }
  }

  return results;
}

/**
 * @param {string} p - resolved path
 * @returns {boolean}
 */
function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

/**
 * Simple substring-based fuzzy score (0 – 1).
 *
 * Scoring rules:
 *   1.0  — exact filename match (case-insensitive)
 *   0.9  — filename starts with the query
 *   0.7  — filename contains the query as a whole word / boundary
 *   0.5  — filename contains the query anywhere
 *   0.3  — all query characters appear in the filename in order (subsequence)
 *   0.0  — no match
 *
 * @param {string} query    - the partial name the user mentioned
 * @param {string} filename - just the basename (no directory)
 * @returns {number}
 */
function fuzzyScore(query, filename) {
  const q = query.toLowerCase();
  const f = filename.toLowerCase();
  const fNoExt = f.replace(/\.[^.]+$/, '');

  if (f === q || fNoExt === q)                    return 1.0;
  if (f.startsWith(q) || fNoExt.startsWith(q))   return 0.9;

  // Word-boundary containment: preceded/followed by a non-alphanumeric char
  const wordBoundary = new RegExp(`(^|[^a-z0-9])${escapeRegex(q)}([^a-z0-9]|$)`);
  if (wordBoundary.test(fNoExt))                  return 0.7;

  if (f.includes(q) || fNoExt.includes(q))        return 0.5;

  // Character subsequence check
  let qi = 0;
  for (let fi = 0; fi < f.length && qi < q.length; fi++) {
    if (f[fi] === q[qi]) qi++;
  }
  if (qi === q.length)                            return 0.3;

  return 0.0;
}

/**
 * @param {string} s
 * @returns {string}
 */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Search a set of candidate file paths for files whose name fuzzy-matches
 * a partial query string.
 *
 * @param {string}   query       - partial filename or keyword the user said
 * @param {string[]} candidates  - absolute file paths to search through
 * @param {object}   [options]
 * @param {number}   [options.limit=10]       - max results to return
 * @param {number}   [options.minScore=0.3]   - minimum score threshold
 * @returns {{ filePath: string, filename: string, score: number }[]}
 *          sorted by score descending
 */
function searchByPartialName(query, candidates, { limit = 10, minScore = 0.3 } = {}) {
  if (!query || typeof query !== 'string') return [];

  const results = [];

  for (const filePath of candidates) {
    const filename = path.basename(filePath);
    const score    = fuzzyScore(query.trim(), filename);
    if (score >= minScore) {
      results.push({ filePath, filename, score });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

/**
 * Search a set of candidate file paths for files whose extension matches a
 * natural-language type word (e.g. "pdf", "document", "spreadsheet").
 *
 * @param {string}   typeWord    - e.g. "pdf", "document", "image"
 * @param {string[]} candidates  - absolute file paths to search through
 * @param {object}   [options]
 * @param {number}   [options.limit=10] - max results to return
 * @returns {{ filePath: string, filename: string, ext: string }[]}
 */
function searchByType(typeWord, candidates, { limit = 10 } = {}) {
  if (!typeWord || typeof typeWord !== 'string') return [];

  const key        = typeWord.toLowerCase().trim();
  const extensions = TYPE_ALIASES[key] || (key.startsWith('.') ? [key] : [`.${ key }`]);

  const results = [];

  for (const filePath of candidates) {
    const filename = path.basename(filePath);
    const ext      = path.extname(filename).toLowerCase();
    if (extensions.includes(ext)) {
      results.push({ filePath, filename, ext });
    }
  }

  return results.slice(0, limit);
}

/**
 * Combined search: tries partial-name matching first, then falls back to
 * type-based matching if the query looks like a generic type word.
 *
 * Returns a ranked list of matches with a `matchType` field indicating how
 * the match was found ('name' | 'type').
 *
 * @param {string}   query      - what the user said (partial name or type)
 * @param {string[]} candidates - absolute file paths to search through
 * @param {object}   [options]
 * @param {number}   [options.limit=10]
 * @param {number}   [options.minScore=0.3]
 * @returns {{
 *   filePath:  string,
 *   filename:  string,
 *   score:     number,
 *   matchType: 'name'|'type'
 * }[]}
 */
function findMatches(query, candidates, { limit = 10, minScore = 0.3 } = {}) {
  if (!query || typeof query !== 'string') return [];

  const nameMatches = searchByPartialName(query, candidates, { limit, minScore });

  if (nameMatches.length > 0) {
    return nameMatches.map((m) => ({ ...m, matchType: 'name' }));
  }

  // Fallback: try type-word matching
  const typeMatches = searchByType(query, candidates, { limit });
  return typeMatches.map((m) => ({ ...m, score: 0.5, matchType: 'type' }));
}

/**
 * High-level helper: scan one or more directories for files that match a
 * vague user reference, returning ranked results.
 *
 * @param {string}          query       - partial name or type word
 * @param {string|string[]} searchDirs  - directory or directories to scan
 * @param {object}          [options]
 * @param {number}          [options.maxDepth=4]   - directory recursion depth
 * @param {number}          [options.limit=10]
 * @param {number}          [options.minScore=0.3]
 * @returns {{
 *   filePath:  string,
 *   filename:  string,
 *   score:     number,
 *   matchType: 'name'|'type'
 * }[]}
 */
function findInDirectories(query, searchDirs, { maxDepth = 4, limit = 10, minScore = 0.3 } = {}) {
  const dirs       = Array.isArray(searchDirs) ? searchDirs : [searchDirs];
  const candidates = [];

  for (const dir of dirs) {
    try {
      const resolved = path.resolve(dir);
      candidates.push(...collectFiles(resolved, maxDepth));
    } catch (_) {
      // Skip unreadable directories
    }
  }

  return findMatches(query, candidates, { limit, minScore });
}

/**
 * Resolve a previously collected list of recent files against a vague query.
 * Useful when the conversation context already knows which files were recently
 * accessed or mentioned.
 *
 * @param {string}   query        - partial name or type word
 * @param {string[]} recentFiles  - ordered list (most recent first) of paths
 * @param {object}   [options]
 * @param {number}   [options.limit=5]
 * @param {number}   [options.minScore=0.3]
 * @returns {{
 *   filePath:  string,
 *   filename:  string,
 *   score:     number,
 *   matchType: 'name'|'type'
 * }[]}
 */
function findInRecentFiles(query, recentFiles, { limit = 5, minScore = 0.3 } = {}) {
  if (!Array.isArray(recentFiles) || recentFiles.length === 0) return [];

  // Apply a small recency boost: earlier items in the array rank slightly higher
  // when scores are equal by pre-scoring them with a tiny positional bonus.
  const results = findMatches(query, recentFiles, { limit: recentFiles.length, minScore });

  // Add recency boost: index 0 gets +0.1, last gets +0.0
  const maxIdx = recentFiles.length - 1;
  for (const result of results) {
    const idx = recentFiles.indexOf(result.filePath);
    if (idx !== -1) {
      result.score += (1 - idx / (maxIdx || 1)) * 0.1;
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

/**
 * Extract a type word or partial file name from a natural-language query.
 * Strips common filler phrases like "send me", "that", "this", "the", "a".
 *
 * Returns `null` if no useful token is found.
 *
 * @param {string} message
 * @returns {string|null}
 */
function extractFileHint(message) {
  if (!message || typeof message !== 'string') return null;

  // Remove common leading command-like phrases
  let cleaned = message
    .replace(/\b(send|share|give|show|get|attach|upload|download|forward)\b/gi, '')
    .replace(/\b(me|us|him|her|them)\b/gi, '')
    .replace(/\b(please|can you|could you|would you|will you)\b/gi, '')
    .replace(/\b(the|a|an|that|this|those|these|my|our|your)\b/gi, '')
    .replace(/\b(for|from|in|of|to|at|by|on|with|about|into|onto)\b/gi, '')
    .replace(/\b(project|folder|directory|repo|repository|workspace|codebase)\b/gi, '')
    .replace(/\b(file|document|doc|attachment|report|sheet|image|picture|photo)\b/gi, (match) => {
      // Keep type words that are also aliases
      return TYPE_ALIASES[match.toLowerCase()] ? match : '';
    })
    .trim();

  // Return the longest remaining token that is not a stop word
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  // Prefer a token that has an extension
  const withExt = tokens.find((t) => /\.\w{1,6}$/.test(t));
  if (withExt) return withExt;

  // Prefer a token that maps to a known type alias
  const typeToken = tokens.find((t) => TYPE_ALIASES[t.toLowerCase()]);
  if (typeToken) return typeToken.toLowerCase();

  // Prefer tokens that look like acronyms (all-uppercase, 2+ chars) or contain digits
  const acronym = tokens.find((t) => /^[A-Z0-9]{2,}$/.test(t));
  if (acronym) return acronym;

  // Otherwise return the longest non-trivial token
  return tokens.reduce((a, b) => (a.length >= b.length ? a : b), '');
}

module.exports = {
  TYPE_ALIASES,
  collectFiles,
  fuzzyScore,
  searchByPartialName,
  searchByType,
  findMatches,
  findInDirectories,
  findInRecentFiles,
  extractFileHint,
};
