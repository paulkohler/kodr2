import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import viewImage, { maxImageBytes } from '../src/tools/view-image.mjs';

let tmpDir;
let context;

// A minimal 1x1 PNG.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'kodr-viewimg-'));
  context = { cwd: tmpDir };
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('view_image', () => {
  it('returns base64 image data and media type for a supported type', async () => {
    await writeFile(join(tmpDir, 'pic.png'), PNG_BYTES);
    const result = await viewImage.execute({ path: 'pic.png' }, context);
    assert.equal(result.error, undefined);
    assert.equal(result.image.path, 'pic.png');
    assert.equal(result.image.mediaType, 'image/png');
    assert.equal(result.image.dataBase64, PNG_BYTES.toString('base64'));
  });

  it('maps jpg/jpeg/gif/webp to the right media type', async () => {
    for (const [name, media] of [
      ['a.jpg', 'image/jpeg'],
      ['b.jpeg', 'image/jpeg'],
      ['c.gif', 'image/gif'],
      ['d.webp', 'image/webp'],
    ]) {
      await writeFile(join(tmpDir, name), PNG_BYTES);
      const r = await viewImage.execute({ path: name }, context);
      assert.equal(r.image.mediaType, media, name);
    }
  });

  it('rejects an unsupported extension', async () => {
    await writeFile(join(tmpDir, 'notes.txt'), 'hi');
    const result = await viewImage.execute({ path: 'notes.txt' }, context);
    assert.match(result.error, /unsupported image type/);
  });

  it('rejects a path escaping the workspace', async () => {
    const result = await viewImage.execute({ path: '../evil.png' }, context);
    assert.ok(result.error);
    assert.match(result.error, /escape|not found/i);
  });

  it('requires a path', async () => {
    const result = await viewImage.execute(
      /** @type {{ path: any }} */ ({}),
      context,
    );
    assert.match(result.error, /path is required/);
  });

  it('rejects an image over the size cap', async () => {
    await writeFile(join(tmpDir, 'big.png'), PNG_BYTES);
    const result = await viewImage.execute(
      { path: 'big.png' },
      { ...context, maxImageBytes: 1 },
    );
    assert.match(result.error, /too large/);
  });
});

describe('maxImageBytes', () => {
  const original = process.env.KODR_MAX_IMAGE_BYTES;
  afterEach(() => {
    if (original === undefined) {
      delete process.env.KODR_MAX_IMAGE_BYTES;
    } else {
      process.env.KODR_MAX_IMAGE_BYTES = original;
    }
  });

  it('uses an explicit option, then the env var, then the default', () => {
    delete process.env.KODR_MAX_IMAGE_BYTES;
    assert.equal(maxImageBytes({ maxImageBytes: 500 }), 500);
    assert.equal(maxImageBytes({}), 10 * 1024 * 1024);
    process.env.KODR_MAX_IMAGE_BYTES = '2048';
    assert.equal(maxImageBytes({}), 2048);
    assert.equal(maxImageBytes({ maxImageBytes: 99 }), 99);
  });
});
