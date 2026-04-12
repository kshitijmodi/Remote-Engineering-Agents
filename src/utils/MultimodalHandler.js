/**
 * MultimodalHandler — processes images, PDFs, and extracts media metadata
 * for inclusion in Claude API calls.
 */

const path = require('path');

// MIME types recognised as images that Claude vision supports
const IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
]);

// MIME types recognised as PDFs
const PDF_MIME_TYPES = new Set([
  'application/pdf',
]);

// File extensions → MIME type (fallback when MIME is not provided)
const EXT_TO_MIME = {
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png':  'image/png',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.pdf':  'application/pdf',
};

/**
 * Infer a MIME type from a file extension when no explicit type is available.
 * @param {string} filename
 * @returns {string|null}
 */
function inferMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  return EXT_TO_MIME[ext] ?? null;
}

/**
 * Determine whether a MIME type represents a supported image.
 * @param {string} mimeType
 * @returns {boolean}
 */
function isImage(mimeType) {
  return IMAGE_MIME_TYPES.has(mimeType);
}

/**
 * Determine whether a MIME type represents a PDF.
 * @param {string} mimeType
 * @returns {boolean}
 */
function isPdf(mimeType) {
  return PDF_MIME_TYPES.has(mimeType);
}

/**
 * Extract metadata from a media attachment object (as provided by WhatsApp).
 * @param {{
 *   mimetype?: string,
 *   filename?: string,
 *   filesize?: number,
 *   data?: string,       // base64-encoded content
 * }} attachment
 * @returns {{
 *   type: 'image'|'pdf'|'unsupported',
 *   mimeType: string|null,
 *   filename: string|null,
 *   filesize: number|null,
 *   data: string|null,
 * }}
 */
function extractMediaMetadata(attachment) {
  const mimeType = attachment.mimetype ?? inferMimeType(attachment.filename ?? '');
  const filename = attachment.filename ?? null;
  const filesize = attachment.filesize ?? null;
  const data     = attachment.data ?? null;

  let type = 'unsupported';
  if (mimeType && isImage(mimeType)) {
    type = 'image';
  } else if (mimeType && isPdf(mimeType)) {
    type = 'pdf';
  }

  return { type, mimeType, filename, filesize, data };
}

/**
 * Build a Claude API content block for an image attachment.
 * @param {{ mimeType: string, data: string }} imageMetadata
 * @returns {{ type: 'image', source: { type: 'base64', media_type: string, data: string } }}
 */
function buildImageBlock(imageMetadata) {
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: imageMetadata.mimeType,
      data: imageMetadata.data,
    },
  };
}

/**
 * Build a Claude API content block for a PDF attachment.
 * Claude supports PDFs via the document content block type.
 * @param {{ mimeType: string, data: string, filename: string|null }} pdfMetadata
 * @returns {{ type: 'document', source: { type: 'base64', media_type: string, data: string } }}
 */
function buildPdfBlock(pdfMetadata) {
  return {
    type: 'document',
    source: {
      type: 'base64',
      media_type: pdfMetadata.mimeType,
      data: pdfMetadata.data,
    },
  };
}

/**
 * Convert a list of raw media attachments into Claude API content blocks.
 * Attachments with unsupported types are skipped.
 * @param {Array<object>} attachments - raw attachment objects from WhatsApp
 * @returns {Array<object>} Claude API content blocks
 */
function buildContentBlocksFromAttachments(attachments) {
  const blocks = [];
  for (const attachment of attachments) {
    const meta = extractMediaMetadata(attachment);
    if (meta.type === 'image' && meta.data) {
      blocks.push(buildImageBlock(meta));
    } else if (meta.type === 'pdf' && meta.data) {
      blocks.push(buildPdfBlock(meta));
    }
    // unsupported types are silently skipped
  }
  return blocks;
}

module.exports = {
  inferMimeType,
  isImage,
  isPdf,
  extractMediaMetadata,
  buildImageBlock,
  buildPdfBlock,
  buildContentBlocksFromAttachments,
};
