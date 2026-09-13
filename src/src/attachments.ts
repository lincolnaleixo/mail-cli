/**
 * Outgoing attachment loading — shared by both backends.
 *
 * An `OutgoingAttachment` names a file on disk; the bytes are read once here at
 * build time so gmail.ts (raw RFC 2822) and icloud.ts (nodemailer) can never
 * disagree about what was attached.
 */

import { readFileSync, statSync } from 'fs';
import { basename, extname } from 'path';
import type { OutgoingAttachment } from './types';

/** Total attachment budget. Gmail rejects ~25 MB messages; base64 adds ~37%. */
const MAX_TOTAL_BYTES = 18 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export interface LoadedAttachment {
  filename: string;
  mimeType: string;
  content: Buffer;
}

/** Read every attachment from disk, validating existence, names, and total size. */
export function loadAttachments(atts: OutgoingAttachment[] | undefined): LoadedAttachment[] {
  if (!atts?.length) return [];
  let total = 0;
  return atts.map((a) => {
    if (!a.path) throw new Error('attachment entry is missing "path"');
    const st = statSync(a.path, { throwIfNoEntry: false });
    if (!st?.isFile()) throw new Error(`attachment not found or not a file: ${a.path}`);
    total += st.size;
    if (total > MAX_TOTAL_BYTES) {
      throw new Error(`attachments exceed ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)} MB total (${a.path})`);
    }
    const filename = (a.filename ?? basename(a.path)).replace(/[\r\n"]/g, '_');
    const mimeType =
      a.mimeType ?? MIME_BY_EXT[extname(filename).toLowerCase()] ?? 'application/octet-stream';
    return { filename, mimeType, content: readFileSync(a.path) };
  });
}
