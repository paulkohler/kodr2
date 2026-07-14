/**
 * view_image tool — let a vision-capable model see an image file, path-jailed
 * to the workspace. Returns the image as a structured result; the tool loop
 * turns it into an OpenAI image content part (see specs/vision.yaml). Only
 * registered when vision is enabled.
 */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { resolveExistingPath } from '../path-jail.mjs';

export const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

const MEDIA_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * Max bytes an image may be before view_image refuses it. Overridable via the
 * registry option, then KODR_MAX_IMAGE_BYTES, then the default -- a huge file
 * would otherwise bloat the request the base64 rides in.
 * @param {{ maxImageBytes?: number }} [context]
 * @returns {number}
 */
export function maxImageBytes(context = {}) {
  if (Number.isInteger(context.maxImageBytes) && context.maxImageBytes > 0) {
    return context.maxImageBytes;
  }
  const fromEnv = Number.parseInt(process.env.KODR_MAX_IMAGE_BYTES || '', 10);
  if (Number.isInteger(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  return DEFAULT_MAX_IMAGE_BYTES;
}

export default {
  definition: {
    name: 'view_image',
    description:
      'View an image file so you can see its contents (a scanned document, invoice, screenshot, diagram, or photo). Supports jpg, png, gif, and webp. Path is relative to the workspace root, or an absolute path within it.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Path relative to the workspace root, or an absolute path within it',
        },
      },
      required: ['path'],
    },
  },

  async execute({ path }, context) {
    if (!path) {
      return {
        error: 'path is required — view_image needs { "path": "<image>" }',
      };
    }
    const mediaType = MEDIA_TYPES[extname(path).toLowerCase()];
    if (!mediaType) {
      return {
        error: `unsupported image type: ${path} (supported: jpg, png, gif, webp)`,
      };
    }

    let resolved;
    try {
      resolved = await resolveExistingPath(context.cwd, path);
    } catch {
      return { error: `image not found: ${path}` };
    }
    if (!resolved) {
      return { error: 'path escapes workspace root' };
    }

    let data;
    try {
      data = await readFile(resolved);
    } catch {
      return { error: `image not found: ${path}` };
    }
    const cap = maxImageBytes(context);
    if (data.length > cap) {
      return { error: `image too large: ${data.length} bytes (max ${cap})` };
    }

    return {
      image: { path, mediaType, dataBase64: data.toString('base64') },
    };
  },
};
