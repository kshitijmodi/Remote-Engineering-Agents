/**
 * FileHandler — safely reads files from the filesystem with path validation,
 * directory traversal prevention, file size limits, and basic access control.
 */

const fs   = require('fs');
const path = require('path');

// Maximum file size allowed for reading/sending (10 MB default)
let _maxFileSizeBytes = 10 * 1024 * 1024;

// Allowed base directories — only files within these roots may be accessed.
// Empty list means no directory restriction (access control disabled).
let _allowedBaseDirs = [];

// File extensions that are explicitly blocked (executables, scripts, etc.)
const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.sh', '.ps1', '.bash', '.zsh',
  '.msi', '.dll', '.so', '.dylib',
  '.py', '.rb', '.pl', '.php',
]);

// ---------------------------------------------------------------------------
// Runtime configuration helpers
// ---------------------------------------------------------------------------

/**
 * Set the maximum file size limit.
 * @param {number} bytes - limit in bytes; must be a positive integer
 */
function setFileSizeLimit(bytes) {
  if (typeof bytes !== 'number' || bytes <= 0 || !Number.isInteger(bytes)) {
    throw new Error('setFileSizeLimit: bytes must be a positive integer');
  }
  _maxFileSizeBytes = bytes;
}

/**
 * Replace the list of allowed base directories entirely.
 * Pass an empty array to disable directory-based access control.
 * @param {string[]} dirs - absolute directory paths
 */
function setAllowedBaseDirs(dirs) {
  if (!Array.isArray(dirs)) {
    throw new Error('setAllowedBaseDirs: argument must be an array of path strings');
  }
  _allowedBaseDirs = dirs.map((d) => path.resolve(d));
}

/**
 * Append a single directory to the allowed-base-dirs list.
 * @param {string} dir - absolute or resolvable directory path
 */
function addAllowedBaseDir(dir) {
  if (!dir || typeof dir !== 'string') {
    throw new Error('addAllowedBaseDir: dir must be a non-empty string');
  }
  _allowedBaseDirs.push(path.resolve(dir));
}

// Expose read-only snapshots so callers can inspect the current config.
Object.defineProperties(exports, {
  MAX_FILE_SIZE_BYTES: { get: () => _maxFileSizeBytes, enumerable: true },
  ALLOWED_BASE_DIRS:   { get: () => [..._allowedBaseDirs], enumerable: true },
});

/**
 * Resolve and validate a file path.
 * Throws an Error if the path fails any security check.
 * @param {string} filePath - raw path supplied by the user
 * @returns {string} resolved absolute path
 */
function validatePath(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Invalid file path: must be a non-empty string');
  }

  const resolved = path.resolve(filePath);

  // Reject null bytes
  if (resolved.includes('\0')) {
    throw new Error('Invalid file path: contains null byte');
  }

  // Directory traversal guard when allowed base dirs are configured
  if (_allowedBaseDirs.length > 0) {
    const withinAllowed = _allowedBaseDirs.some((resolvedBase) => {
      return resolved.startsWith(resolvedBase + path.sep) || resolved === resolvedBase;
    });
    if (!withinAllowed) {
      throw new Error(`Access denied: path is outside allowed directories`);
    }
  }

  // Block dangerous file extensions
  const ext = path.extname(resolved).toLowerCase();
  if (BLOCKED_EXTENSIONS.has(ext)) {
    throw new Error(`Access denied: file type '${ext}' is not allowed`);
  }

  return resolved;
}

/**
 * Check that a file exists, is a regular file (not a directory/symlink to
 * a dangerous location), and is within the size limit.
 * @param {string} resolvedPath - already-validated absolute path
 * @returns {{ size: number, mtime: Date }} basic file stats
 */
function statFile(resolvedPath) {
  let stat;
  try {
    // lstat so we can detect symlinks before following them
    stat = fs.lstatSync(resolvedPath);
  } catch {
    throw new Error(`File not found: ${resolvedPath}`);
  }

  if (stat.isSymbolicLink()) {
    // Resolve symlink target and re-validate
    const realPath = fs.realpathSync(resolvedPath);
    return statFile(realPath);
  }

  if (!stat.isFile()) {
    throw new Error(`Path is not a file: ${resolvedPath}`);
  }

  if (stat.size > _maxFileSizeBytes) {
    const sizeMB    = (stat.size / (1024 * 1024)).toFixed(2);
    const limitMB   = (_maxFileSizeBytes / (1024 * 1024)).toFixed(0);
    throw new Error(`File too large: ${sizeMB} MB exceeds the ${limitMB} MB limit`);
  }

  return { size: stat.size, mtime: stat.mtime };
}

/**
 * Safely read a file and return its contents as a Buffer.
 * @param {string} filePath - path supplied by the user (may be relative)
 * @returns {{ buffer: Buffer, resolvedPath: string, filename: string, size: number }}
 */
function readFile(filePath) {
  const resolvedPath = validatePath(filePath);
  const { size }     = statFile(resolvedPath);

  const buffer   = fs.readFileSync(resolvedPath);
  const filename = path.basename(resolvedPath);

  return { buffer, resolvedPath, filename, size };
}

/**
 * Safely read a file as a UTF-8 string.
 * @param {string} filePath
 * @returns {{ text: string, resolvedPath: string, filename: string, size: number }}
 */
function readTextFile(filePath) {
  const { buffer, resolvedPath, filename, size } = readFile(filePath);
  return { text: buffer.toString('utf8'), resolvedPath, filename, size };
}

/**
 * Return a base64-encoded representation of a file's contents.
 * @param {string} filePath
 * @returns {{ base64: string, resolvedPath: string, filename: string, size: number }}
 */
function readFileAsBase64(filePath) {
  const { buffer, resolvedPath, filename, size } = readFile(filePath);
  return { base64: buffer.toString('base64'), resolvedPath, filename, size };
}

/**
 * Non-throwing access check. Returns an object indicating whether the given
 * path passes all security validations, plus an optional reason on failure.
 * Useful for pre-flight checks without try/catch boilerplate.
 * @param {string} filePath
 * @returns {{ allowed: boolean, reason?: string }}
 */
function canAccess(filePath) {
  try {
    const resolved = validatePath(filePath);
    statFile(resolved);
    return { allowed: true };
  } catch (err) {
    return { allowed: false, reason: err.message };
  }
}

module.exports = Object.assign(exports, {
  BLOCKED_EXTENSIONS,
  setFileSizeLimit,
  setAllowedBaseDirs,
  addAllowedBaseDir,
  validatePath,
  statFile,
  canAccess,
  readFile,
  readTextFile,
  readFileAsBase64,
});
