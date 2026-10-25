---
name: saynow
description: Speak to the user out loud and wait for their reply. Use whenever you need their attention and they may not be watching the terminal — a question that blocks progress, a decision you should not make alone, a long task finishing, an error needing a human, or a document, table or chart worth showing. Prefer this over asking in the terminal and waiting.
---

# Speaking to the user

`saynow` speaks through the machine's speakers and shows a small bubble in the
corner with the transcript and a reply box. It exists because a question left
in a terminal nobody is watching is a question nobody answers.

Check it is installed before first use:

```bash
command -v saynow || npm install -g saynow
```

## Ask, and read the answer

```bash
answer=$(saynow --from "<agent> · <task>" --ask "Should I drop the old table?")
```

`--ask` blocks until they reply, then prints the reply to stdout.

They can paste pictures into the reply — usually a screenshot of what they
mean. Each is saved to a temporary file and its path printed on a line of its
own after the words, so the first line is the text and every line after it is
an image to open:

```
The second one, but tighter
/var/folders/…/T/saynow-reply-Xa81bQ/image-1.png
```

A reply can be pictures alone, with no words — then every line is a path.
Read those images before acting; they are often the whole answer.

| Exit | Meaning |
| --- | --- |
| `0` | They replied. The answer is on stdout, with any pasted image's path after it. |
| `2` | They dismissed it or were away. **Treat as no answer, never as consent.** |
| `1` | Something failed — usage, network, or no audio. |

On exit `2`, fall back to asking in the terminal. Do not proceed as though
silence were approval.

## Default to `--ask`

Almost anything worth saying invites a response, and without `--ask` there is
nowhere to put one. Drop the flag only when you are certain nothing can come
back:

```bash
saynow --from "build · ci" "Deploy finished, all checks green."
```

Even then, keep `--ask` if you would want to hear their reaction.

## Rules

- **One short sentence.** It is heard, not read. Long text is unusable aloud.
- **Identify with `--from`, never with words.** It shows in the bubble header,
  so the spoken sentence should never introduce you. `--from "billing · migration"`
  beats eight words of "Hey, the billing agent here…".
- **Talk like a colleague.** "Quick one — drop the old table?" beats "I am now
  requesting confirmation regarding…".
- **Never narrate routine progress.** Interrupting for nothing teaches them to
  ignore it, and then it is useless when it matters.
- **Also write the question in the terminal.** Speech is a notification, not a
  transcript — they may have missed it.

## Showing something

`--file` renders a Markdown document in the bubble — headings, lists, tables,
quotes, code, links and images, local or remote. Pair it with a short spoken
line, which then becomes the only thing said aloud.

```bash
saynow --from "metrics · weekly" --file report.md --ask "Weekly numbers are up. Anything look wrong?"
```

Use it when the answer is a table, a chart or a diff — anything worse described
than shown. Relative image paths resolve against the document's own directory,
so a folder containing the report and its charts works as-is.

The bubble holds open for as long as their pointer is on it or they are typing
in it, so a document is read at their pace rather than a timer's. Left alone it
goes five seconds after the voice stops.

They can pause the voice from the bubble, or click a word in the transcript to
hear it again from there — so a long line is recoverable rather than gone. A
paused bubble waits for them, which means `--ask` may block for longer than the
speech itself takes. That is normal; keep waiting for the exit code.

## Choosing a voice

The default needs no key and works offline. For better audio, set
`OPENROUTER_API_KEY` and:

```bash
saynow config set provider openrouter
saynow models                        # every speech model, with prices
saynow voices -p openrouter          # voices for the selected model
```

`saynow --help` is the full reference. Concurrent calls queue automatically, so
several agents speaking at once produce sequential sentences rather than a
muddle.
