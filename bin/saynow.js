#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { plan, speak } from '../src/speak.js';
import { render as renderMarkdown, speech as markdownSpeech } from '../src/markdown.js';
import { canShowBubble, showBubble } from '../src/bubble.js';
import { acquireLock } from '../src/queue.js';
import * as history from '../src/history.js';
import { get, providerIds, providers } from '../src/providers/index.js';
import {
  CONFIG_PATH,
  SECRET_KEYS,
  apiKey,
  load,
  redact,
  resolve,
  save,
} from '../src/config.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const HELP = fs
  .readFileSync(path.join(ROOT, 'help.txt'), 'utf8')
  .replaceAll('{{VERSION}}', version)
  .replaceAll('{{PROVIDERS}}', providerIds.join(', '))
  .replaceAll('{{CONFIG_PATH}}', CONFIG_PATH);

const OPTIONS = {
  voice: { type: 'string', short: 'v' },
  provider: { type: 'string', short: 'p' },
  model: { type: 'string', short: 'm' },
  from: { type: 'string' },
  file: { type: 'string' },
  rate: { type: 'string', short: 'r' },
  speed: { type: 'string', short: 's' },
  save: { type: 'string' },
  ask: { type: 'boolean' },
  'no-ui': { type: 'boolean' },
  'no-queue': { type: 'boolean' },
  strict: { type: 'boolean' },
  quiet: { type: 'boolean', short: 'q' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
};

const SUBCOMMANDS = new Set([
  'init',
  'config',
  'voices',
  'models',
  'history',
  'app',
  'help',
]);

async function main() {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      options: OPTIONS,
      allowPositionals: true,
      args: process.argv.slice(2),
    }));
  } catch (err) {
    fail(`${err.message}\n\nRun \`saynow --help\` for usage.`);
  }

  if (values.version) return void console.log(version);
  if (values.help || positionals[0] === 'help') return void process.stdout.write(HELP);

  const flags = {
    voice: values.voice,
    provider: values.provider,
    model: values.model,
    from: values.from,
    file: values.file,
    rate: values.rate ? Number(values.rate) : undefined,
    speed: values.speed ? Number(values.speed) : undefined,
    save: values.save,
    ask: values.ask,
    noUi: values['no-ui'],
    noQueue: values['no-queue'],
    strict: values.strict,
    quiet: values.quiet,
  };

  if (flags.provider && !providerIds.includes(flags.provider)) {
    fail(`unknown provider "${flags.provider}". Available: ${providerIds.join(', ')}`);
  }
  for (const key of ['rate', 'speed']) {
    if (flags[key] !== undefined && Number.isNaN(flags[key])) {
      fail(`--${key} must be a number`);
    }
  }

  const [command, ...rest] = positionals;

  if (SUBCOMMANDS.has(command)) {
    if (command === 'init') return initCommand();
    if (command === 'config') return configCommand(rest);
    if (command === 'voices') return voicesCommand(flags);
    if (command === 'models') return modelsCommand();
    if (command === 'history') return historyCommand(rest);
    if (command === 'app') return appCommand(rest);
  }

  // --file supplies the document; any text argument becomes the spoken line,
  // so a long report can be shown while only a short summary is read out.
  let document = null;
  if (flags.file) {
    try {
      document = { markdown: fs.readFileSync(flags.file, 'utf8'), dir: path.dirname(path.resolve(flags.file)) };
    } catch (err) {
      fail(`could not read ${flags.file}: ${err.message}`);
    }
  }

  const text = positionals.length
    ? positionals.join(' ')
    : document
      ? markdownSpeech(document.markdown)
      : await readStdin();

  if (!text.trim()) {
    fail('nothing to say. Pass text as an argument or pipe it on stdin.\n\nRun `saynow --help` for usage.');
  }

  return speakCommand(text.trim(), { ...flags, document });
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function initCommand() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('Configure saynow. Press enter to keep the current value.\n');
    for (const id of providerIds) {
      const p = providers[id];
      console.log(`  ${id.padEnd(12)} ${p.label}`);
    }
    console.log();

    const config = load();
    const chosen =
      (await rl.question(`Provider [${config.provider}]: `)).trim() || config.provider;

    if (!providerIds.includes(chosen)) {
      fail(`unknown provider "${chosen}". Available: ${providerIds.join(', ')}`);
    }
    config.provider = chosen;

    const provider = get(chosen);
    if (!provider.speaksDirectly) {
      const existing = config[provider.configKey];
      const prompt = existing
        ? `API key [${redact(existing)}]: `
        : `API key (or leave blank to use $${provider.envVar}): `;
      const entered = (await rl.question(prompt)).trim();
      if (entered) config[provider.configKey] = entered;
    }

    const voice = (await rl.question(`Voice [${config.voice ?? 'default'}]: `)).trim();
    if (voice) config.voice = voice;

    save(config);
    console.log(`\nSaved to ${CONFIG_PATH} (mode 0600).`);

    if (!provider.speaksDirectly && !apiKey(chosen, config)) {
      console.log(
        `\nNo key stored and $${provider.envVar} is unset — saynow will use the offline system voice until one is available.`,
      );
    }
  } finally {
    rl.close();
  }
}

function configCommand([action, key, ...valueParts]) {
  const config = load();

  switch (action) {
    case 'path':
      return void console.log(CONFIG_PATH);

    case 'list':
    case undefined: {
      const rows = Object.entries(config).map(([k, v]) => [
        k,
        SECRET_KEYS.has(k) ? redact(v) : String(v),
      ]);
      const width = Math.max(...rows.map(([k]) => k.length));
      for (const [k, v] of rows) console.log(`${k.padEnd(width)}  ${v}`);
      if (!fs.existsSync(CONFIG_PATH)) {
        console.log(`\n(no config file yet — these are defaults. Run \`saynow init\`.)`);
      }
      return;
    }

    case 'get': {
      if (!key) fail('usage: saynow config get <key>');
      const value = config[key];
      if (value === undefined) fail(`no such key: ${key}`);
      return void console.log(SECRET_KEYS.has(key) ? redact(value) : value);
    }

    case 'set': {
      const value = valueParts.join(' ');
      if (!key || !value) fail('usage: saynow config set <key> <value>');
      if (key === 'provider' && !providerIds.includes(value)) {
        fail(`unknown provider "${value}". Available: ${providerIds.join(', ')}`);
      }
      config[key] = key === 'speed' || key === 'rate' ? Number(value) : value;
      save(config);
      return void console.log(
        `${key} = ${SECRET_KEYS.has(key) ? redact(value) : config[key]}`,
      );
    }

    default:
      fail(`unknown config command "${action}". Use: list, get, set, path`);
  }
}

async function voicesCommand(flags) {
  const config = resolve(flags);
  const provider = get(config.provider);
  const list = await provider.voices({
    apiKey: apiKey(config.provider, config),
    model: config.model,
  });

  if (!list.length) {
    console.log(`No voices listed for provider "${config.provider}".`);
    return;
  }

  const width = Math.max(...list.map((v) => v.name.length));
  for (const v of list) {
    console.log(`${v.name.padEnd(width)}  ${v.locale.padEnd(8)} ${v.note}`.trimEnd());
  }
}

/**
 * Speak the text, showing the bubble alongside unless asked not to.
 *
 * With --ask the bubble carries a reply box and we block on it, printing the
 * answer to stdout. Without it the bubble is a transcript that fades out once
 * the audio stops, so a missed sentence is still readable.
 */
async function speakCommand(text, flags) {
  if (flags.ask && flags.save) fail('--ask and --save cannot be combined.');

  // --save writes a file and plays nothing, so there is nothing to narrate.
  const wantsUi = !flags.noUi && !flags.save;
  const shell = wantsUi ? canShowBubble() : null;

  if (!shell) {
    if (wantsUi && flags.ask && !flags.quiet) {
      process.stderr.write(
        'saynow: no window shell available, so --ask can only speak. ' +
          'Install a Chromium-based browser, or Xcode command line tools on macOS.\n',
      );
    }
    const result = await speak(text, flags);
    if (result?.saved && !flags.quiet) console.log(result.saved);
    if (flags.ask) process.exitCode = 2;
    return;
  }

  // Long text is rendered in pieces so the first sentence plays while the rest
  // is still being made. It stays one bubble: the split is a synthesis detail.
  const pieces = await plan(text, flags).catch(() => null);
  if (pieces) {
    const release = await acquireLock();
    try {
      const answer = await showBubble({
        text,
        ask: Boolean(flags.ask),
        rate: flags.rate,
        from: flags.from,
        document: flags.document,
        chunks: pieces,
        speech: Promise.resolve(),
      });
      if (!flags.ask) return;
      if (!printAnswer(answer)) process.exitCode = 2;
      return;
    } finally {
      release();
    }
  }

  // Ask for the bytes rather than letting speak() play them: the page plays
  // the audio so the transcript can follow its clock exactly. The signal ends
  // whatever is left of it once the bubble is gone.
  const stop = new AbortController();
  let handed = null;
  const speech = speak(text, { ...flags, handoff: true, signal: stop.signal })
    .then((result) => {
      handed = result?.audio ? result : null;
      return result;
    })
    .catch((err) => {
      process.stderr.write(`saynow: ${err.message}\n`);
    });

  await speech;

  // Serialise here, since playback now happens in the page rather than in a
  // child process the queue could wrap.
  const release = handed ? await acquireLock() : null;

  let answer;
  try {
    answer = await showBubble({
      text,
      ask: Boolean(flags.ask),
      rate: flags.rate,
      from: flags.from,
      document: flags.document,
      speech: handed ? Promise.resolve() : speech,
      audio: handed?.audio,
      audioType: handed?.ext === 'mp3' ? 'audio/mpeg' : 'audio/wav',
    });
  } finally {
    release?.();
  }

  stop.abort();

  if (!flags.ask) return;
  if (!printAnswer(answer)) process.exitCode = 2;
}

/**
 * Print a reply: the words on the first line, then one line per pasted image
 * giving the path it was saved to. An image sent with no words is still an
 * answer. Returns whether there was anything to print.
 */
function printAnswer(answer) {
  if (answer.reason !== 'reply') return false;
  const lines = [answer.text, ...(answer.images ?? [])].filter(Boolean);
  if (!lines.length) return false;
  console.log(lines.join('\n'));
  return true;
}

async function modelsCommand() {
  const list = await providers.openrouter.audioModels();

  if (!list.length) {
    console.log('Could not reach OpenRouter to list speech models.');
    return;
  }

  const width = Math.max(...list.map((m) => m.id.length));
  console.log('OpenRouter speech models:\n');

  for (const model of list) {
    // Pricing is per input token; scale to something a human can compare.
    const cost = model.price ? `$${(model.price * 1000).toFixed(4)}/1k tok` : 'free';
    const voices = model.voices ? `${model.voices} voices` : 'voice required';
    const mark = model.isDefault ? '*' : ' ';
    console.log(`${mark} ${model.id.padEnd(width)}  ${cost.padStart(15)}  ${voices}`);
  }

  console.log(
    `\n* default. Use another with: saynow -p openrouter -m <id> "text"` +
      `\nSet a default with:          saynow config set model <id>` +
      `\nList a model's voices with:  saynow voices -p openrouter -m <id>`,
  );
}

async function historyCommand([action, ...rest]) {
  switch (action ?? 'list') {
    case 'path':
      return void console.log(history.HISTORY_DIR);

    case 'clear': {
      const removed = history.clear();
      return void console.log(`Removed ${removed} clip${removed === 1 ? '' : 's'}.`);
    }

    case 'open': {
      // Hand the newest clip, or the nth, to whatever normally opens audio.
      const entries = history.readIndex();
      const index = rest[0] ? Number(rest[0]) - 1 : 0;
      const entry = entries[index];
      if (!entry) fail(`no clip at position ${index + 1}. Run: saynow history`);
      const file = path.join(history.HISTORY_DIR, entry.file);
      spawnSync(process.platform === 'darwin' ? 'open' : 'xdg-open', [file], {
        stdio: 'ignore',
      });
      return void console.log(file);
    }

    case 'list': {
      // Prices are looked up here rather than at synthesis time, so speaking
      // is never delayed by a round trip just to learn what it cost.
      const config = load();
      const key = apiKey('openrouter', config);
      if (key) {
        await history.resolveCosts((genId) =>
          providers.openrouter.lookupCost(genId, key),
        );
      }

      const entries = history.readIndex();
      if (!entries.length) {
        console.log('No archived clips yet.');
        console.log(`\nThe system voice is not archived — it speaks directly and`);
        console.log(`produces no file. Cloud providers are.`);
        return;
      }

      entries.forEach((entry, i) => {
        const when = entry.at.replace('T', ' ').slice(0, 16);
        const size = history.formatBytes(entry.bytes).padStart(8);
        const source = [entry.provider, entry.model, entry.voice].filter(Boolean).join(' / ');
        const cost = entry.cost != null ? `$${entry.cost.toFixed(4)}` : '';
        console.log(`${String(i + 1).padStart(3)}. ${when}  ${size}  ${cost.padStart(8)}  ${source}`);
        console.log(`     ${entry.text.replace(/\s+/g, ' ').slice(0, 88)}`);
      });

      const spent = history.totalCost();
      console.log(
        `\n${entries.length} clip${entries.length === 1 ? '' : 's'}, ` +
          `${history.formatBytes(history.usage())}` +
          (spent ? `, $${spent.toFixed(4)} spent` : '') +
          `\n${history.HISTORY_DIR}` +
          `\nPlay one with: saynow history open <n>`,
      );
      return;
    }

    default:
      fail(`unknown history command "${action}". Use: list, open, path, clear`);
  }
}

/**
 * Build and install the macOS settings app.
 *
 * The app ships as source and is compiled here rather than shipped as a
 * binary: a prebuilt one would need a Developer ID and notarisation to run on
 * anyone else's machine, and per-platform packages to distribute. Compiling on
 * demand keeps the package small and needs nothing but the command line tools.
 */
function appCommand([action = 'install']) {
  const source = path.join(ROOT, 'app');
  const build = path.join(source, 'build.sh');

  if (action === 'path') return void console.log(source);

  if (!['install', 'build'].includes(action)) {
    fail(`unknown app command "${action}". Use: install, build, path`);
  }

  if (process.platform !== 'darwin') {
    fail('the settings app is macOS only. The command line tool works everywhere.');
  }
  if (!fs.existsSync(build)) {
    fail(
      'the app sources are missing from this install.\n' +
        'Clone the repository and run ./app/build.sh --install instead:\n' +
        '  https://github.com/dhruvyad/saynow',
    );
  }
  if (spawnSync('which', ['swiftc'], { stdio: 'ignore' }).status !== 0) {
    fail(
      'building the app needs the Xcode command line tools:\n' +
        '  xcode-select --install',
    );
  }

  const result = spawnSync('bash', [build, ...(action === 'install' ? ['--install'] : [])], {
    stdio: 'inherit',
  });
  if (result.status !== 0) fail('the app failed to build.');
}

function fail(message) {
  process.stderr.write(`saynow: ${message}\n`);
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`saynow: ${err.message}\n`);
  process.exit(1);
});
