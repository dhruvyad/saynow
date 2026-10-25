import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { saveImages } from '../src/bubble.js';

/**
 * A picture pasted into a reply reaches the caller as a path, so these hold
 * the part between the page handing over its bytes and that path existing.
 */

const dataUrl = (type, bytes) => `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;

/** Point the system temp folder somewhere disposable for one test. */
function inTemp(run) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'saynow-test-'));
  const before = process.env.TMPDIR;
  process.env.TMPDIR = scratch;
  try {
    return run(scratch);
  } finally {
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

test('each pasted image is saved under the extension its type calls for', () => {
  inTemp(() => {
    const [png, jpg] = saveImages([dataUrl('image/png', 'png bytes'), dataUrl('image/jpeg', 'jpeg bytes')]);

    assert.match(png, /image-1\.png$/);
    assert.match(jpg, /image-2\.jpg$/);
    assert.equal(fs.readFileSync(png, 'utf8'), 'png bytes');
    assert.equal(fs.readFileSync(jpg, 'utf8'), 'jpeg bytes');
    assert.equal(path.dirname(png), path.dirname(jpg), 'one reply, one folder');
  });
});

test('a pasted image is readable by this user alone', () => {
  // A screenshot is whatever was on the screen, and the temp folder can be
  // shared. The folder and the file are both closed to everyone else.
  inTemp(() => {
    const [file] = saveImages([dataUrl('image/png', 'secret')]);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  });
});

test('anything that is not a supported image is left out', () => {
  inTemp((scratch) => {
    const saved = saveImages([
      dataUrl('image/svg+xml', '<svg/>'),
      dataUrl('text/html', '<script></script>'),
      'not a data url',
      null,
      dataUrl('image/png', 'kept'),
    ]);
    assert.equal(saved.length, 1);
    assert.match(saved[0], /image-1\.png$/, 'numbered by what was kept, not by what was sent');
    assert.equal(fs.readdirSync(scratch).length, 1);
  });
});

test('a reply with no pictures writes nothing at all', () => {
  inTemp((scratch) => {
    assert.deepEqual(saveImages(undefined), []);
    assert.deepEqual(saveImages([]), []);
    assert.deepEqual(saveImages('data:image/png;base64,AAAA'), []);
    assert.deepEqual(fs.readdirSync(scratch), [], 'no empty folders left behind');
  });
});
