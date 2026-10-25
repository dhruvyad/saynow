import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { createDom } from './helpers/dom.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PAGE = fs.readFileSync(path.join(ROOT, 'ui', 'bubble.html'), 'utf8');

const SCRIPT = /<script>([\s\S]*)<\/script>\s*<\/body>/.exec(PAGE)?.[1];
assert.ok(SCRIPT, 'could not find the page script — did the markup change?');

/**
 * Run the page against a stub DOM and hand back what it built.
 *
 * Three of this project's bugs lived in this script and every one was found
 * by a person noticing an inert bubble: a const referenced from above its
 * declaration threw before a single handler was bound, twice. Nothing here
 * needs a browser to catch that — it only needs the script to actually run.
 */
function loadPage(state) {
  const { document, byId, search } = createDom({ markup: PAGE });
  const calls = { fetched: [], audio: [], players: [], events: [], revoked: [] };

  // Timers are held rather than run, so nothing fires unless a test says so.
  // A cleared one is forgotten, which is what lets a test flush the clock
  // without a countdown that was cancelled going off anyway.
  const timers = new Map();
  let timerId = 0;

  // Frames are queued rather than run inline. The highlight's tick reschedules
  // itself for as long as the clip is playing, so running one the moment it is
  // asked for recurses until the stack gives out.
  const frames = [];

  // The window is an event target too, and losing focus is how a half-finished
  // keystroke gets abandoned, so its listeners have to be reachable from here.
  const windowListeners = new Map();

  const context = {
    window: {
      __SAYNOW__: state,
      addEventListener(type, handler) {
        if (!windowListeners.has(type)) windowListeners.set(type, []);
        windowListeners.get(type).push(handler);
      },
      webkit: undefined,
    },
    document,
    location: { search },
    fetch: (url, init) => {
      calls.fetched.push({ url, init });
      // A test can hold a request open by answering it here.
      return calls.respond?.(url) ?? Promise.resolve({ ok: true });
    },
    Audio: class {
      constructor(src) {
        calls.audio.push(src);
        calls.players.push(this);
        this.src = src;
        // A clip that has not been asked to play yet is paused, exactly as a
        // real element reports it — the transport button reads this.
        this.paused = true;
        this.ended = false;
        this.currentTime = 0;
        this.duration = 0;
        this.bound = {};
        // Every listener of a type runs, but the type is still callable as
        // players[0].handlers.ended() to fire it the way the browser would.
        this.handlers = {};
      }
      addEventListener(type, handler) {
        (this.bound[type] ??= []).push(handler);
        this.handlers[type] = (event) => {
          for (const fn of this.bound[type]) fn(event);
        };
      }
      play() {
        // Playing a finished clip rewinds it, so it is no longer ended —
        // which is what makes the button say "play it again".
        this.paused = false;
        this.ended = false;
        return Promise.resolve();
      }
      pause() {
        this.paused = true;
      }
      load() {}
    },
    EventSource: class {
      constructor(url) {
        calls.events.push(url);
      }
      addEventListener() {}
    },
    requestAnimationFrame: (fn) => frames.push(fn),
    setTimeout: (fn) => {
      timerId += 1;
      timers.set(timerId, fn);
      return timerId;
    },
    clearTimeout: (id) => timers.delete(id),
    URL: {
      createObjectURL: (file) => `blob:${file.name}`,
      revokeObjectURL: (url) => calls.revoked.push(url),
    },
    FileReader: class {
      readAsDataURL(file) {
        if (file.stalls) return; // a read that never finishes
        this.result = `data:${file.type};base64,${Buffer.from(file.bytes ?? '').toString('base64')}`;
        queueMicrotask(() => this.onload?.());
      }
    },
    ResizeObserver: class {
      observe() {}
    },
    URLSearchParams,
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    console,
  };

  context.window.document = document;

  const run = new Function(...Object.keys(context), SCRIPT);
  run(...Object.values(context));

  const fireOnWindow = (type, event = {}) => {
    for (const handler of windowListeners.get(type) ?? []) handler(event);
  };

  /** Fire every timer still pending, as though their time had come. */
  const tick = () => {
    for (const [id, fn] of [...timers]) {
      timers.delete(id);
      fn();
    }
  };

  /** Run the frames asked for so far; a tick may queue the next one. */
  const frame = () => {
    for (const fn of frames.splice(0)) fn();
  };

  /** The word elements in reading order, however the transcript is built. */
  const wordsIn = (node, found = []) => {
    for (const child of node.children ?? []) {
      if (child.tagName === 'W') found.push(child);
      else wordsIn(child, found);
    }
    return found;
  };

  return {
    document,
    byId,
    calls,
    fireOnWindow,
    frame,
    tick,
    words: () => wordsIn(byId.get('transcript')),
  };
}

const PLAIN = { text: 'The build finished, 42 tests passed.', ask: false, rate: 175, dismissMs: 5000 };

test('the page runs to completion on a plain announcement', () => {
  // The whole point: if the script throws, nothing below is bound and the
  // bubble opens inert with a close button that does nothing.
  assert.doesNotThrow(() => loadPage(PLAIN));
});

test('dismissal is wired even though everything else could fail', () => {
  const { byId, document } = loadPage(PLAIN);
  assert.ok(byId.get('close').hasListener('click'), 'the close button must be clickable');
  assert.ok(document.hasListener('keydown'), 'Escape must be handled');
});

test('clicking close asks the CLI to dismiss', () => {
  const { byId, calls } = loadPage(PLAIN);
  byId.get('close').dispatch('click');
  const paths = calls.fetched.map((c) => c.url);
  assert.ok(
    paths.some((p) => p.includes('/dismiss')),
    `expected a dismiss request, saw ${JSON.stringify(paths)}`,
  );
});

test('every request carries the token', () => {
  const { byId, calls } = loadPage(PLAIN);
  byId.get('close').dispatch('click');
  for (const { url, init } of calls.fetched) {
    const carried =
      url.includes('t=testtoken') || init?.headers?.['X-Saynow-Token'] === 'testtoken';
    assert.ok(carried, `request to ${url} went out without the token`);
  }
});

test('the transcript is split into one element per word', () => {
  const { byId } = loadPage(PLAIN);
  const words = byId.get('transcript').children.filter((c) => c.tagName === 'W');
  assert.equal(words.length, PLAIN.text.split(/\s+/).length);
  assert.equal(words[0].textContent, 'The');
});

test('the reply box appears only when an answer is wanted', () => {
  const plain = loadPage(PLAIN);
  assert.ok(plain.byId.get('reply').classList.contains('hidden'), 'no reply box without --ask');

  const asking = loadPage({ ...PLAIN, ask: true });
  assert.ok(!asking.byId.get('reply').classList.contains('hidden'), '--ask must show one');
});

test('a named sender replaces the wordmark', () => {
  const { byId } = loadPage({ ...PLAIN, from: 'noclick1 · billing' });
  const label = byId.get('label');
  assert.match(label.textContent, /noclick1/);
  assert.ok(label.classList.contains('named'), 'a name is styled differently from the wordmark');
});

test('audio is played by the page, with the token attached', () => {
  const { calls } = loadPage({ ...PLAIN, hasAudio: true });
  assert.equal(calls.audio.length, 1);
  assert.match(calls.audio[0], /^\/audio\?t=testtoken/);
});

test('chunked speech starts the first clip and preloads the next', () => {
  const { calls } = loadPage({
    ...PLAIN,
    text: 'One two three. Four five six.',
    chunks: [
      { firstWord: 0, wordCount: 3 },
      { firstWord: 3, wordCount: 3 },
    ],
  });
  assert.match(calls.audio[0], /^\/audio\/0\?t=testtoken/);
  assert.match(calls.audio[1], /^\/audio\/1\?t=testtoken/, 'the next clip should be warmed');
});

test('a rendered document keeps its structure and still lights word by word', () => {
  const { byId } = loadPage({
    ...PLAIN,
    text: 'Morning summary Rates held steady',
    html: '<h1>Morning summary</h1><ul><li>Rates held steady</li></ul>',
  });

  const transcript = byId.get('transcript');
  assert.ok(transcript.classList.contains('rich'));
  assert.equal(transcript.children[0].tagName, 'H1', 'structure must survive');

  const words = [];
  const walk = (node) => {
    for (const child of node.children ?? []) {
      if (child.tagName === 'W') words.push(child.textContent);
      else walk(child);
    }
  };
  walk(transcript);
  assert.deepEqual(words, ['Morning', 'summary', 'Rates', 'held', 'steady']);
});

test('code blocks are never lit, because they are never spoken', () => {
  const { byId } = loadPage({
    ...PLAIN,
    text: 'Run this',
    html: '<p>Run this</p><pre><code>npm install --global saynow</code></pre>',
  });

  const inPre = [];
  const walk = (node, insidePre) => {
    for (const child of node.children ?? []) {
      const nowInside = insidePre || child.tagName === 'PRE';
      if (child.tagName === 'W' && nowInside) inPre.push(child.textContent);
      walk(child, nowInside);
    }
  };
  walk(byId.get('transcript'), false);
  assert.deepEqual(inPre, [], 'wrapping code would desynchronise everything after it');
});

test('the countdown runs after a question, not only after a statement', () => {
  // The page focuses the reply box itself on load, and holding() counted that
  // as engagement — so with --ask the countdown never started, the bar never
  // appeared, and the bubble sat there until the CLI gave up. It looked like
  // the timer only worked without --ask, which is exactly what it did.
  const { byId, calls } = loadPage({ ...PLAIN, ask: true, hasAudio: true });

  const player = calls.players[0];
  assert.ok(player, 'the page should be playing the audio itself');
  player.handlers.ended();

  const bar = byId.get('timer');
  assert.equal(bar.style.transform, 'scaleX(0)', 'the bar must be counting down');
  assert.match(bar.style.transition, /^transform \d+ms linear$/);
});

test('the countdown runs for exactly as long as the CLI asked for', () => {
  const { byId, calls } = loadPage({ ...PLAIN, ask: true, dismissMs: 5000, hasAudio: true });
  calls.players[0].handlers.ended();

  assert.equal(
    Number(/transform (\d+)ms/.exec(byId.get('timer').style.transition)?.[1]),
    5000,
    'the bar must run the length the caller set, not one of its own',
  );
});

test('the transcript scrolling itself does not cancel the countdown', () => {
  // The reveal calls scrollIntoView on every word it lights, and a document is
  // long enough to actually scroll the transcript. Treating that scroll as
  // "they are reading" meant every document cancelled the countdown it had
  // just started: the bar was drawn for one frame and never seen again, and
  // nothing closed the bubble afterwards.
  const { byId, calls } = loadPage({
    ...PLAIN,
    ask: true,
    hasAudio: true,
    html: '<h1>Weekly report</h1><p>Signups climbed nine per cent.</p>',
  });
  calls.players[0].handlers.ended();

  const bar = byId.get('timer');
  assert.equal(bar.style.transform, 'scaleX(0)', 'the countdown should have started');

  // A frame later, the smooth scroll the reveal started settles.
  byId.get('transcript').dispatch('scroll');

  assert.equal(bar.style.opacity, '1', 'the bar must still be on screen');
  assert.equal(bar.style.transform, 'scaleX(0)', 'and must still be counting down');
});

test('hovering holds the bubble open, and leaving restarts the countdown', () => {
  const { byId, calls } = loadPage({ ...PLAIN, ask: true, hasAudio: true });
  calls.players[0].handlers.ended();

  const bubble = byId.get('bubble');
  const bar = byId.get('timer');

  bubble.dispatch('mouseenter');
  assert.equal(bar.style.opacity, '0', 'the bar should fade out while they are here');

  bubble.dispatch('mouseleave');
  assert.equal(bar.style.transform, 'scaleX(0)');
  assert.equal(bar.style.opacity, '1', 'and come back when they leave');
});

test('the cursor landing in the box on its own does not hold the bubble open', () => {
  // The page focuses the reply field itself, and WebKit may deliver that
  // focus event whenever it likes. Treating focus as engagement is what
  // killed the countdown for every --ask bubble.
  const { byId, calls } = loadPage({ ...PLAIN, ask: true, hasAudio: true });
  byId.get('field').dispatch('focus');
  calls.players[0].handlers.ended();

  assert.equal(byId.get('timer').style.transform, 'scaleX(0)', 'it must still count down');
});

test('a draft deleted back to nothing gives the countdown back', () => {
  // Typing latched a flag that was never cleared, so a character typed and
  // then deleted held the bubble open for good. With no guard behind it that
  // is forever: the bar never returned and nothing ever closed the bubble.
  const { byId, calls } = loadPage({ ...PLAIN, ask: true, hasAudio: true });
  const field = byId.get('field');
  const bar = byId.get('timer');

  field.value = 'wait';
  field.dispatch('input');
  calls.players[0].handlers.ended();
  assert.notEqual(bar.style.transform, 'scaleX(0)', 'a reply in progress holds it open');

  field.value = '';
  field.dispatch('input');
  assert.equal(bar.style.transform, 'scaleX(0)', 'an empty box is not a reply in progress');
  assert.equal(bar.style.opacity, '1', 'and the bar has to be visible again');
});

test('a keystroke abandoned by switching window does not strand the countdown', () => {
  // A key can be let go of somewhere else: hold one down, switch window, and
  // the keyup is delivered to whatever you switched to. The countdown that
  // keydown stopped then had nothing left to restart it.
  const { byId, calls, fireOnWindow } = loadPage({ ...PLAIN, ask: true, hasAudio: true });
  calls.players[0].handlers.ended();

  byId.get('field').dispatch('keydown', { key: 'a' });
  fireOnWindow('blur');

  assert.equal(byId.get('timer').style.transform, 'scaleX(0)', 'it must still count down');
  assert.equal(byId.get('timer').style.opacity, '1');
});

test('a click with the pointer elsewhere does not strand the countdown', () => {
  // Space on a focused button is a click too, and by then mouseleave has long
  // since been and gone — so a click cannot be taken as proof anyone is here.
  const { byId, calls } = loadPage({ ...PLAIN, ask: true, hasAudio: true });
  calls.players[0].handlers.ended();

  byId.get('bubble').dispatch('click');

  assert.equal(byId.get('timer').style.transform, 'scaleX(0)', 'it must still count down');
  assert.equal(byId.get('timer').style.opacity, '1');
});

test('a key that never becomes text does not strand the countdown', () => {
  // keydown stops the countdown before the value changes, which is right for
  // a letter. An arrow or a modifier produces no input event to reconsider
  // it, so the stop has to be undone on the way up instead.
  const { byId, calls } = loadPage({ ...PLAIN, ask: true, hasAudio: true });
  calls.players[0].handlers.ended();

  byId.get('field').dispatch('keydown', { key: 'ArrowLeft' });
  byId.get('field').dispatch('keyup', { key: 'ArrowLeft' });

  assert.equal(byId.get('timer').style.transform, 'scaleX(0)', 'it must still count down');
  assert.equal(byId.get('timer').style.opacity, '1');
});

test('a reply in progress is never swallowed by the timer', () => {
  const { byId, calls } = loadPage({ ...PLAIN, ask: true, hasAudio: true });
  const field = byId.get('field');

  field.value = 'not yet, wait';
  field.dispatch('input');
  calls.players[0].handlers.ended();

  byId.get('bubble').dispatch('mouseenter');
  byId.get('bubble').dispatch('mouseleave');
  assert.notEqual(
    byId.get('timer').style.transform,
    'scaleX(0)',
    'losing a half-written reply is worse than a bubble that overstays',
  );
});

/* ---- pausing and playing from a word ------------------------------------ */

/** A clip that has run to the end, as the browser would leave it. */
function finish(player) {
  player.ended = true;
  player.paused = true;
  player.handlers.ended();
}

test('the transport button pauses the voice and starts it again', () => {
  const { byId, calls } = loadPage({ ...PLAIN, hasAudio: true });
  const player = calls.players[0];
  const bubble = byId.get('bubble');

  assert.equal(player.paused, false, 'it should be speaking to begin with');

  byId.get('play').dispatch('click');
  assert.equal(player.paused, true, 'the click must actually silence it');
  assert.ok(bubble.classList.contains('paused'), 'and the button must show a triangle');

  byId.get('play').dispatch('click');
  assert.equal(player.paused, false, 'the same button starts it again');
  assert.ok(!bubble.classList.contains('paused'), 'and goes back to bars');
});

test('a paused bubble is still handed back to the countdown when it finishes', () => {
  // Pausing holds the bubble open, which is only safe because resuming gives
  // it back. If the resumed audio could end without starting the countdown,
  // the bubble would sit on screen for good and the caller would wait with it.
  const { byId, calls } = loadPage({ ...PLAIN, hasAudio: true });
  const player = calls.players[0];

  byId.get('play').dispatch('click'); // paused
  byId.get('bubble').dispatch('mouseleave'); // and walked away from
  assert.notEqual(
    byId.get('timer').style.transform,
    'scaleX(0)',
    'nothing should count down while there is speech left to hear',
  );

  byId.get('play').dispatch('click'); // back, and resumed
  finish(player);

  assert.equal(byId.get('timer').style.transform, 'scaleX(0)', 'the countdown must run');
  assert.equal(byId.get('timer').style.opacity, '1', 'and be visible');
});

test('the button plays it again once the voice has finished', () => {
  const { byId, calls, words } = loadPage({ ...PLAIN, hasAudio: true });
  const player = calls.players[0];
  player.duration = 10;
  finish(player);

  assert.ok(byId.get('bubble').classList.contains('done'));
  byId.get('play').dispatch('click');

  assert.equal(player.paused, false, 'it should be speaking again');
  assert.equal(player.currentTime, 0, 'from the top');
  assert.ok(!byId.get('bubble').classList.contains('done'), 'and no longer look finished');
  assert.ok(!words()[0].classList.contains('said'), 'with the transcript back to the start');
});

test('clicking a word plays from that word', () => {
  const { byId, calls, words } = loadPage({ ...PLAIN, hasAudio: true });
  const player = calls.players[0];
  player.duration = 10;

  const at = (i) => {
    byId.get('transcript').dispatch('click', { target: words()[i] });
    return player.currentTime;
  };

  assert.equal(at(0), 0, 'the first word is the beginning of the clip');
  const third = at(2);
  const fifth = at(4);
  assert.ok(third > 0 && third < 10, `expected a position inside the clip, got ${third}`);
  assert.ok(fifth > third, 'a later word must be a later position');
  assert.equal(player.paused, false, 'and it plays rather than just moving the playhead');
});

test('clicking back into the transcript dims what has not been said again', () => {
  const { byId, calls, words } = loadPage({ ...PLAIN, hasAudio: true });
  const player = calls.players[0];
  player.duration = 10;
  finish(player);
  assert.ok(words().every((w) => w.classList.contains('said')), 'all lit at the end');

  byId.get('transcript').dispatch('click', { target: words()[2] });

  assert.ok(words()[1].classList.contains('said'), 'what was already said stays lit');
  assert.ok(!words()[2].classList.contains('said'), 'the word being spoken again does not');
  assert.ok(!words()[5].classList.contains('said'), 'nor anything after it');
});

test('playing from a word stops the countdown, and the end starts it again', () => {
  // This is the one rule the bubble has. Sending the voice back cancels a
  // countdown that was already running, so the audio reaching its end has to
  // be able to start it — otherwise a click on a word strands the bubble.
  const { byId, calls, words } = loadPage({ ...PLAIN, ask: true, hasAudio: true });
  const player = calls.players[0];
  player.duration = 10;
  finish(player);
  assert.equal(byId.get('timer').style.transform, 'scaleX(0)', 'counting down at the end');

  byId.get('transcript').dispatch('click', { target: words()[2] });
  assert.equal(byId.get('timer').style.opacity, '0', 'and holding once it speaks again');

  finish(player);
  assert.equal(byId.get('timer').style.transform, 'scaleX(0)', 'the countdown must come back');
  assert.equal(byId.get('timer').style.opacity, '1');
});

const CHUNKED = {
  ...PLAIN,
  text: 'One two three. Four five six. Seven eight nine.',
  chunks: [
    { firstWord: 0, wordCount: 3 },
    { firstWord: 3, wordCount: 3 },
    { firstWord: 6, wordCount: 3 },
  ],
};

test('clicking a word in a later clip switches to that clip', () => {
  const { byId, calls, words } = loadPage(CHUNKED);
  const clip = (n) => calls.players.find((p) => p.src.startsWith(`/audio/${n}?`));

  // Third clip: past the one warmed behind the first, so it has to be asked
  // for. The server renders on demand, which is why it is fetched at all.
  byId.get('transcript').dispatch('click', { target: words()[7] });

  assert.ok(clip(2), 'the clip holding that word should have been requested');
  assert.equal(clip(2).paused, false, 'and be the one now speaking');
  assert.equal(clip(0).paused, true, 'while the clip it interrupted is silent');
  assert.equal(clip(1).paused, true, 'and the one it skipped never starts');
});

test('a clip abandoned by a click cannot step the one that replaced it', () => {
  // The abandoned clip still delivers its own 'ended' afterwards. Acting on
  // it would advance past the clip the user just asked for — ending the
  // bubble while it was still speaking.
  const { byId, calls, words } = loadPage(CHUNKED);
  const clip = (n) => calls.players.find((p) => p.src.startsWith(`/audio/${n}?`));

  byId.get('transcript').dispatch('click', { target: words()[7] });
  finish(clip(0)); // the interrupted clip, arriving late

  assert.equal(clip(2).paused, false, 'the clip the user asked for keeps speaking');
  assert.ok(
    !byId.get('bubble').classList.contains('done'),
    'and the bubble must not settle while it does',
  );
});

test('neither pausing nor seeking is offered when the page has no audio', () => {
  // The system voice speaks for itself: there is no playhead in the page to
  // move, so a button and a clickable word would both be lies.
  const silent = loadPage(PLAIN);
  assert.ok(silent.byId.get('play').classList.contains('hidden'), 'no transport button');
  assert.ok(!silent.byId.get('transcript').classList.contains('seekable'));

  const playing = loadPage({ ...PLAIN, hasAudio: true });
  assert.ok(!playing.byId.get('play').classList.contains('hidden'), 'but one when it can');
  assert.ok(playing.byId.get('transcript').classList.contains('seekable'));
});

test('a link in a document is a link, not a place to play from', () => {
  const { byId, calls } = loadPage({
    ...PLAIN,
    hasAudio: true,
    text: 'Read the report',
    html: '<p><a href="https://example.com">Read the report</a></p>',
  });
  const player = calls.players[0];
  player.duration = 10;
  player.currentTime = 4;

  const words = [];
  const walk = (node) => {
    for (const child of node.children ?? []) {
      if (child.tagName === 'W') words.push(child);
      else walk(child);
    }
  };
  walk(byId.get('transcript'));

  byId.get('transcript').dispatch('click', { target: words[1] });
  assert.equal(player.currentTime, 4, 'following the link is what the click is for');
});

test('space pauses, unless a reply is being typed', () => {
  const { document, calls } = loadPage({ ...PLAIN, ask: true, hasAudio: true });
  const player = calls.players[0];

  // The page focuses the reply box itself, so space is a character first.
  document.dispatch('keydown', { key: ' ' });
  assert.equal(player.paused, false, 'a space typed into a reply is a space');

  document.activeElement = null;
  document.dispatch('keydown', { key: ' ' });
  assert.equal(player.paused, true, 'with nothing being typed it is play/pause');
});

test('the highlight follows the playhead wherever it is sent', () => {
  const { calls, frame, words } = loadPage({ ...PLAIN, hasAudio: true });
  const player = calls.players[0];
  player.duration = 10;

  player.currentTime = 10;
  player.handlers.play();
  frame();
  assert.ok(words().every((w) => w.classList.contains('said')), 'lit up to the playhead');

  player.currentTime = 0;
  frame();
  assert.ok(!words()[1].classList.contains('said'), 'and dimmed again when it goes back');
});

/* ---- dragging the top edge ---------------------------------------------- */

/**
 * Take hold of the top edge and pull it to another height.
 *
 * Screen coordinates, because the page is resized by the very drag it would
 * otherwise be measured against. Moves go to the document: that is where the
 * page listens, since the handle is twelve pixels tall and a drag leaves it
 * with the first movement.
 */
const drag = ({ byId, document }, from, to, buttons = 1) => {
  byId.get('grip').dispatch('pointerdown', { screenY: from, pointerId: 1, buttons: 1 });
  document.dispatch('pointermove', { screenY: to, pointerId: 1, buttons });
};

test('dragging the top edge up shows more of the transcript, down less', () => {
  const page = loadPage({ ...PLAIN, hasAudio: true });
  const transcript = page.byId.get('transcript');

  // The stub lays every element out at 120px tall.
  drag(page, 500, 400);
  assert.equal(transcript.style.maxHeight, '220px', 'up is taller');

  page.byId.get('grip').dispatch('lostpointercapture');
  drag(page, 500, 560);
  assert.equal(transcript.style.maxHeight, '60px', 'down is shorter');
});

test('a drag holds the bubble open, and letting go hands it back', () => {
  const page = loadPage({ ...PLAIN, ask: true, hasAudio: true });
  finish(page.calls.players[0]);
  const bar = page.byId.get('timer');
  assert.equal(bar.style.transform, 'scaleX(0)', 'counting down to begin with');

  drag(page, 500, 420);
  // Dragging up takes the pointer off the top of the bubble on the way.
  page.byId.get('bubble').dispatch('mouseleave');
  assert.equal(bar.style.opacity, '0', 'nothing may take the bubble mid-drag');

  page.byId.get('grip').dispatch('lostpointercapture');
  assert.equal(bar.style.transform, 'scaleX(0)', 'and the countdown comes back');
  assert.equal(bar.style.opacity, '1');
});

test('a release nobody heard about does not strand the bubble', () => {
  // Let go outside the window, or with the capture taken away, and no end-of-
  // drag event arrives at all. The next move without a button held is the
  // last thing standing between that and a bubble that never closes.
  const page = loadPage({ ...PLAIN, ask: true, hasAudio: true });
  finish(page.calls.players[0]);

  drag(page, 500, 420);
  page.byId.get('bubble').dispatch('mouseleave');
  // The button was let go where nothing could hear it. The next move, with
  // nothing held down, is the only thing that says so.
  page.document.dispatch('pointermove', { screenY: 410, pointerId: 1, buttons: 0 });

  assert.equal(page.byId.get('timer').style.transform, 'scaleX(0)', 'it must count down again');
  assert.equal(page.byId.get('timer').style.opacity, '1');
});

test('the transcript is never dragged shorter than a line or taller than the screen', () => {
  const page = loadPage({ ...PLAIN, hasAudio: true });
  const transcript = page.byId.get('transcript');

  drag(page, 500, 5000);
  assert.equal(transcript.style.maxHeight, '48px', 'still readable');

  page.byId.get('grip').dispatch('lostpointercapture');
  drag(page, 500, -5000);
  // The stub reports no screen, so the fallback of 900 stands in for one.
  assert.ok(
    Number.parseInt(transcript.style.maxHeight, 10) < 900,
    `a bubble taller than the screen runs off the top of it, got ${transcript.style.maxHeight}`,
  );
});

/**
 * There is deliberately no static check for use-before-declaration here.
 *
 * A regex cannot see scope: the first attempt flagged the parameters of
 * litUpTo(count) and followAudio(audio, chunk) as references to consts
 * declared further down. A test that cries wolf gets muted, and then it
 * protects nothing. "The page runs to completion" above already catches the
 * temporal dead zone definitively, because that is exactly how it fails.
 */

/* ---- pasted images ------------------------------------------------------ */

const ASKING = { ...PLAIN, ask: true, hasAudio: true, imageTypes: ['image/png', 'image/jpeg'] };

/** A paste event as WebKit delivers it, with a way to see if it was taken. */
function pasting(...files) {
  const event = {
    clipboardData: { files },
    prevented: false,
    preventDefault() {
      event.prevented = true;
    },
  };
  return event;
}

const screenshot = { name: 'image.png', type: 'image/png', bytes: 'not really a png' };

/** Let the reader and the requests that follow it run. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

test('a pasted image is attached, and its path is not pasted beside it', () => {
  // A picture copied in Finder arrives as a file and as its path in text. Left
  // alone, the path lands in the box next to the thumbnail.
  const { byId } = loadPage(ASKING);
  const event = pasting(screenshot);
  byId.get('field').dispatch('paste', event);

  const strip = byId.get('attachments');
  assert.ok(!strip.classList.contains('hidden'), 'the thumbnail row should show');
  assert.equal(strip.children.length, 1);
  assert.equal(strip.children[0].children[0].src, 'blob:image.png');
  assert.ok(event.prevented, 'the text half of the paste must be stopped');
  assert.ok(byId.get('send').classList.contains('ready'), 'a picture alone can be sent');
});

test('a paste with no image in it is left to the browser', () => {
  const { byId } = loadPage(ASKING);
  const event = pasting();
  byId.get('field').dispatch('paste', event);

  assert.ok(!event.prevented, 'ordinary text has to paste as it always did');
  assert.ok(byId.get('attachments').classList.contains('hidden'));
});

test('nothing is shown as attached that the CLI would not save', () => {
  // The CLI says which types it keeps. A thumbnail for one it then dropped
  // would tell the person their picture had been sent when it had not.
  const { byId } = loadPage(ASKING);
  const event = pasting({ name: 'logo.svg', type: 'image/svg+xml' });
  byId.get('field').dispatch('paste', event);

  assert.equal(byId.get('attachments').children.length, 0);
  assert.ok(!event.prevented, 'and the paste goes ahead as text');
});

test('a waiting picture holds the bubble, and removing it gives the countdown back', () => {
  // The bubble's one rule: whatever stops the countdown must be able to start
  // it again. A picture is a draft like typed text, so it has to end the same
  // way an emptied box does.
  const { byId, calls } = loadPage(ASKING);
  calls.players[0].handlers.ended();
  const bar = byId.get('timer');
  assert.equal(bar.style.transform, 'scaleX(0)', 'counting down before the paste');

  byId.get('field').dispatch('paste', pasting(screenshot));
  assert.equal(bar.style.opacity, '0', 'a picture waiting to be sent holds it open');

  const thumb = byId.get('attachments').children[0];
  thumb.children[1].dispatch('click');

  assert.equal(byId.get('attachments').children.length, 0);
  assert.ok(byId.get('attachments').classList.contains('hidden'));
  assert.deepEqual(calls.revoked, ['blob:image.png'], 'the thumbnail is let go of');
  assert.ok(!byId.get('send').classList.contains('ready'), 'nothing is left to send');
  assert.equal(bar.style.opacity, '1', 'the countdown has to come back');
  assert.equal(bar.style.transform, 'scaleX(0)');
});

test('a picture sent with no words is still a reply, and carries the picture', async () => {
  const { byId, calls, tick } = loadPage(ASKING);
  const field = byId.get('field');
  field.dispatch('paste', pasting(screenshot));
  field.dispatch('keydown', { key: 'Enter' });

  await settled();
  tick(); // the "Sent" beat
  await settled();

  const reply = calls.fetched.find((c) => c.url === '/reply');
  assert.ok(reply, `expected a reply, saw ${JSON.stringify(calls.fetched.map((c) => c.url))}`);
  assert.deepEqual(JSON.parse(reply.init.body), {
    text: '',
    images: [`data:image/png;base64,${Buffer.from(screenshot.bytes).toString('base64')}`],
  });
});

test('/close waits for the reply to land, however long it takes to send', async () => {
  // /close settles the bubble as dismissed. Sent on a fixed clock, it could
  // overtake a reply still uploading a screenshot, and the answer was lost.
  const { byId, calls, tick } = loadPage(ASKING);
  let land;
  const uploading = new Promise((resolve) => (land = resolve));
  calls.respond = (url) => (url === '/reply' ? uploading : undefined);
  const sent = () => calls.fetched.map((c) => c.url);

  const field = byId.get('field');
  field.dispatch('paste', pasting(screenshot));
  field.dispatch('keydown', { key: 'Enter' });
  await settled();
  tick(); // the "Sent" beat
  await settled();
  assert.ok(sent().includes('/reply'), 'the reply should be on its way');

  tick();
  await settled();
  assert.ok(!sent().includes('/close'), 'nothing may settle the bubble while the reply uploads');

  land({ ok: true });
  await settled();
  tick();
  assert.ok(sent().includes('/close'), 'once the reply is in, /close follows');
});

test('a picture that never finishes reading cannot leave the bubble on "Sent"', async () => {
  // Sending stops the countdown for good, so whatever it waits on has to end.
  const { byId, calls, tick } = loadPage(ASKING);
  const field = byId.get('field');
  field.value = 'words still matter';
  field.dispatch('input');
  field.dispatch('paste', pasting({ ...screenshot, stalls: true }));
  field.dispatch('keydown', { key: 'Enter' });

  await settled();
  tick(); // the "Sent" beat, and the read being given up on
  await settled();

  const reply = calls.fetched.find((c) => c.url === '/reply');
  assert.ok(reply, 'the reply has to go without the picture rather than not at all');
  assert.deepEqual(JSON.parse(reply.init.body), { text: 'words still matter', images: [] });
});
