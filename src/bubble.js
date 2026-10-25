import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { render as renderMarkdown } from './markdown.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PAGE = path.join(ROOT, 'ui', 'bubble.html');
const SHELL_SOURCE = path.join(ROOT, 'shell', 'SaynowPanel.swift');

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

/**
 * Images a reply can carry, and the extension each is saved under.
 *
 * Raster formats only. The page is told this list and attaches nothing else,
 * so a paste it shows as attached is never one dropped here. WebKit turns a
 * TIFF on the clipboard into a PNG before the page sees it, which is why a
 * screenshot copied with ⌃⇧⌘4 arrives as image/png.
 */
export const IMAGE_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/tiff': 'tiff',
  'image/bmp': 'bmp',
};

// A document can be wider than a sentence without becoming a window.
const WIDTH = 420;
const INITIAL_HEIGHT = 200;

const CACHE_DIR =
  process.env.SAYNOW_CACHE_DIR ||
  (process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Caches', 'saynow')
    : path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'saynow'));

/**
 * Show the bubble and wait for the user.
 *
 * Resolves with {reason: 'reply', text, images} when they answer, where
 * images holds the path of each picture they pasted, or {reason: 'dismiss'}
 * when it times out or they wave it away.
 */
export async function showBubble({
  text,
  ask = false,
  rate,
  from,
  document,
  // The same for a question as for a statement. Being present is what holds a
  // bubble open, not what it happens to be asking, and a question you are not
  // there for should not sit on the screen four times as long as one you are.
  dismissMs = 5000,
  speech,
  audio,
  audioType,
  chunks,
  // Off by default: nothing takes the bubble away on a clock. Tests set it to
  // bound a headless server that no one is ever going to answer.
  timeoutMs = null,
} = {}) {
  // When the page plays the audio itself, the highlight is driven by the
  // element's own currentTime — exact by construction, rather than a
  // words-per-minute guess that starts whenever the page happened to load.
  // Chunks are synthesised ahead of the page asking for them, so playback of
  // one overlaps rendering of the next and speech starts almost immediately.
  const pending = chunks ? new Map() : null;
  if (chunks) prefetch(chunks, pending, 0);

  /**
   * A secret for this bubble only.
   *
   * The server listens on loopback with no other authentication, and POST
   * /reply is what an agent reads as your answer — so anything able to reach
   * the port could answer on your behalf and the agent would act on it. The
   * page is served the token and hands it back; nothing else knows it.
   *
   * Declared before anything that closes over it. The asset callback below
   * only runs for documents carrying a relative image, so a reference from
   * above threw for those alone and left every other document working —
   * exactly the shape of bug that survives a test suite.
   */
  const token = randomBytes(24).toString('hex');

  const authorised = (req) => {
    const supplied =
      req.headers['x-saynow-token'] ||
      new URL(req.url ?? '/', 'http://localhost').searchParams.get('t') ||
      '';
    const a = Buffer.from(String(supplied));
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const state = {
    text,
    ask,
    // Who is speaking. Shown in the header so the sentence itself does not
    // have to spend words introducing the agent every single time.
    from: from || null,
    // Rendered here rather than in the page: the renderer escapes its input
    // and emits only tags it built, so the page never parses agent text.
    html: document
      ? renderMarkdown(document.markdown, {
          asset: (src) =>
            /^[a-z][\w+.-]*:/i.test(src)
              ? null // an unknown scheme is dropped rather than guessed at
              : `/asset?t=${token}&p=${encodeURIComponent(src)}`,
        })
      : null,
    rate: rate || 175,
    dismissMs,
    imageTypes: ask ? Object.keys(IMAGE_TYPES) : [],
    hasAudio: Boolean(audio),
    chunks: chunks?.map((c) => ({ firstWord: c.firstWord, wordCount: c.wordCount })) ?? null,
  };
  const page = renderPage(state);

  let settle;
  const answered = new Promise((resolve) => (settle = resolve));

  // The word animation is only an estimate of pace. The dismiss countdown has
  // to start when the audio genuinely stops, or the bubble can vanish
  // mid-sentence on a slow voice.
  const listeners = new Set();
  const announceSpeechEnded = () => {
    for (const res of listeners) res.write('event: ended\ndata: {}\n\n');
  };

  const server = http.createServer((req, res) => {
    if (!authorised(req)) {
      res.writeHead(403).end();
      return;
    }

    const route = (req.url ?? '/').split('?')[0];
    // /audio/<n> blocks until that chunk is rendered, which is what lets the
    // page ask for the next one before it exists.
    const chunkMatch = req.method === 'GET' && /^\/audio\/(\d+)$/.exec(route);
    if (chunkMatch && chunks) {
      const index = Number(chunkMatch[1]);
      // From this one rather than the next: clicking a word in the transcript
      // can ask for a clip well past the lookahead, and one that was never
      // started is a clip that never arrives.
      prefetch(chunks, pending, index);
      Promise.resolve(pending.get(index))
        .then((rendered) => {
          if (!rendered?.audio) {
            res.writeHead(503).end();
            return;
          }
          res.writeHead(200, {
            'Content-Type': rendered.ext === 'mp3' ? 'audio/mpeg' : 'audio/wav',
            'Content-Length': rendered.audio.length,
            'Cache-Control': 'no-store',
          });
          res.end(rendered.audio);
        })
        .catch(() => res.writeHead(503).end());
      return;
    }

    // Images referenced by the document, resolved against its own directory
    // and refused if they climb out of it.
    if (req.method === 'GET' && route === '/asset' && document) {
      const rel = new URL(req.url, 'http://localhost').searchParams.get('p') ?? '';
      const full = path.resolve(document.dir, rel);
      if (!full.startsWith(document.dir + path.sep)) {
        res.writeHead(403).end();
        return;
      }
      try {
        const body = fs.readFileSync(full);
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(full).toLowerCase()] ?? 'application/octet-stream',
          'Content-Length': body.length,
        });
        res.end(body);
      } catch {
        res.writeHead(404).end();
      }
      return;
    }

    if (req.method === 'GET' && route === '/audio' && audio) {
      res.writeHead(200, {
        'Content-Type': audioType || 'audio/wav',
        'Content-Length': audio.length,
        'Accept-Ranges': 'none',
        'Cache-Control': 'no-store',
      });
      res.end(audio);
      return;
    }

    if (req.method === 'GET' && route === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.write('retry: 1000\n\n');
      listeners.add(res);
      req.on('close', () => listeners.delete(res));
      return;
    }

    if (req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(page);
      return;
    }

    readJson(req).then((body) => {
      res.writeHead(204).end();
      switch (route) {
        case '/reply':
          settle({
            reason: 'reply',
            text: String(body.text ?? '').trim(),
            images: saveImages(body.images),
          });
          break;
        case '/dismiss':
          settle({ reason: 'dismiss' });
          break;
        case '/close':
          settle({ reason: 'dismiss' });
          break;
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/?t=${token}`;

  // Nothing here ends the bubble on a timer. It closes when the page says so —
  // dismissed, answered, or counted down in front of someone who was not
  // there. The one exception is the shell vanishing: if the panel is killed
  // there is no longer anything on screen to answer with, and without this the
  // caller would wait for an answer that can never arrive.
  const window = openWindow(url, () => settle({ reason: 'dismiss' }));
  const guard = timeoutMs ? setTimeout(() => settle({ reason: 'dismiss' }), timeoutMs) : null;

  // Resolves when the audio actually finishes, however long it really took.
  Promise.resolve(speech)
    .catch(() => {})
    .then(announceSpeechEnded);

  try {
    return await answered;
  } finally {
    if (guard) clearTimeout(guard);
    for (const res of listeners) res.end();
    window.close();
    server.close();
  }
}

/** Keep a small lookahead rendering, so the page rarely has to wait. */
const LOOKAHEAD = 2;

function prefetch(chunks, pending, from) {
  for (let i = from; i < Math.min(chunks.length, from + LOOKAHEAD); i += 1) {
    if (!pending.has(i)) pending.set(i, chunks[i].render());
  }
}

function renderPage(state) {
  const html = fs.readFileSync(PAGE, 'utf8');
  const injected = `<script>window.__SAYNOW__ = ${JSON.stringify(state).replace(
    /</g,
    '\\u003c',
  )};</script>`;
  return html.replace('<!--SAYNOW_STATE-->', injected);
}

/**
 * Write the images a reply carried to disk, and return their paths.
 *
 * The caller only ever reads text from us, so a picture has to become a file
 * it can open. Each reply gets a fresh directory only this user can read,
 * left in the system temp folder for the OS to clear away: an agent opens the
 * file seconds after we exit, and nothing here needs it for longer.
 *
 * Never throws. An image that cannot be saved is reported and skipped, since
 * the words of the reply are still worth delivering on their own.
 */
export function saveImages(images) {
  if (!Array.isArray(images) || !images.length) return [];
  const saved = [];
  let dir = null;
  for (const image of images) {
    const [, type, data] = /^data:([\w./+-]+);base64,(.*)$/s.exec(String(image ?? '')) ?? [];
    const ext = IMAGE_TYPES[type?.toLowerCase()];
    if (!ext) continue;
    try {
      dir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'saynow-reply-'));
      const file = path.join(dir, `image-${saved.length + 1}.${ext}`);
      fs.writeFileSync(file, Buffer.from(data, 'base64'), { mode: 0o600 });
      saved.push(file);
    } catch (err) {
      process.stderr.write(`saynow: could not save a pasted image: ${err.message}\n`);
    }
  }
  return saved;
}

function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

/* ---- window shells ------------------------------------------------------ */

function openWindow(url, onGone) {
  // Tests need the server without putting a window on someone's screen.
  if (process.env.SAYNOW_NO_WINDOW) return noWindow();

  const shell = nativePanel(url, onGone) || browserWindow(url);
  if (shell) return shell;

  // Neither shell opened, so nothing was put on the screen and no one can
  // ever answer. With no clock left to fall back on, saying so immediately is
  // what stops the caller waiting for a bubble that does not exist.
  onGone?.();
  return noWindow();
}

/**
 * The preferred shell: a borderless transparent NSPanel. Compiled on first use
 * and cached, keyed by a hash of the source so an upgrade rebuilds it.
 */
function nativePanel(url, onGone) {
  if (process.platform !== 'darwin') return null;
  if (!fs.existsSync(SHELL_SOURCE)) return null;
  if (spawnSync('which', ['swiftc'], { stdio: 'ignore' }).status !== 0) return null;

  const source = fs.readFileSync(SHELL_SOURCE);
  const digest = createHash('sha256').update(source).digest('hex').slice(0, 12);
  const binary = path.join(CACHE_DIR, `panel-${digest}`);

  if (!fs.existsSync(binary)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const build = spawnSync('swiftc', ['-O', '-o', binary, SHELL_SOURCE], {
      stdio: 'ignore',
      timeout: 120_000,
    });
    if (build.status !== 0) return null;
    // A stale build from an older version is just wasted disk; clear it out.
    for (const entry of fs.readdirSync(CACHE_DIR)) {
      if (entry.startsWith('panel-') && entry !== `panel-${digest}`) {
        fs.rmSync(path.join(CACHE_DIR, entry), { force: true });
      }
    }
  }

  const child = spawn(binary, [url, String(WIDTH), String(INITIAL_HEIGHT)], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });

  // The panel draws no close button of its own — the page does, and that goes
  // through the server. So the panel process ending means it died rather than
  // was dismissed, and there is now nothing on screen for anyone to answer
  // with. Deliberately not wired for the browser fallback: a Chromium spawned
  // against a profile that is already running hands its window to the existing
  // instance and exits at once, which would read as an instant dismissal.
  child.on('exit', () => onGone?.());
  child.on('error', () => onGone?.());

  // The panel exits when this pipe closes, so it can never outlive us.
  return { close: () => child.kill() };
}

const BROWSERS = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge'],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
};

/** Fallback shell: a Chromium app window. Same page, but the OS draws a frame. */
function browserWindow(url) {
  const candidates = BROWSERS[process.platform] || [];
  const browser = candidates.find(
    (c) =>
      (c.includes('/') || c.includes('\\')
        ? fs.existsSync(c)
        : spawnSync('which', [c], { stdio: 'ignore' }).status === 0),
  );
  if (!browser) return null;

  const { width, height } = screenSize();
  const child = spawn(
    browser,
    [
      `--app=${url}`,
      `--window-size=${WIDTH},${INITIAL_HEIGHT + 40}`,
      `--window-position=${Math.max(0, width - WIDTH - 24)},${Math.max(0, height - INITIAL_HEIGHT - 120)}`,
      `--user-data-dir=${path.join(CACHE_DIR, 'browser-profile')}`,
      '--no-first-run',
      '--no-default-browser-check',
      // The page plays the speech itself; without this it is blocked as
      // unsolicited autoplay and the bubble sits silent.
      '--autoplay-policy=no-user-gesture-required',
    ],
    { stdio: 'ignore', detached: false },
  );

  return { close: () => child.kill() };
}

function screenSize() {
  if (process.platform === 'darwin') {
    const out = spawnSync(
      'osascript',
      ['-e', 'tell application "Finder" to get bounds of window of desktop'],
      { encoding: 'utf8' },
    );
    const parts = (out.stdout || '').trim().split(', ').map(Number);
    if (parts.length === 4 && parts[2] > 0) return { width: parts[2], height: parts[3] };
  }
  return { width: 1440, height: 900 };
}

/** No shell available — speak-only, so --ask degrades to a plain announcement. */
function noWindow() {
  return { close: () => {} };
}

export function canShowBubble() {
  if (process.platform === 'darwin' && spawnSync('which', ['swiftc'], { stdio: 'ignore' }).status === 0) {
    return 'panel';
  }
  const candidates = BROWSERS[process.platform] || [];
  const found = candidates.some((c) =>
    c.includes('/') || c.includes('\\')
      ? fs.existsSync(c)
      : spawnSync('which', [c], { stdio: 'ignore' }).status === 0,
  );
  return found ? 'browser' : null;
}
