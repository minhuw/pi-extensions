# Writer

A command-owned Pi port of [claude-writer](https://github.com/minhuw/claude-writer): academic writing workflows for papers targeting top-tier computer science conferences.

## Usage

```text
/polish introduction.tex
/evaluate the abstract
/grammar-checker section 3
/paper-validator
/conference-reviewer as an NSDI reviewer
/selection The system achieves [word_to_select] performance under high load.
/validation The system demonstrates <good> performance under various workloads.
/summary the related work section
```

Each command injects the packaged skill into the current Pi session and treats remaining text as the writing task or excerpt. The same skills are also discovered for autonomous `/skill:<name>` use.

## Commands

| Command | Purpose |
| --- | --- |
| `/conference-reviewer` | Write a formal conference-style review with scores, strengths, and weaknesses. |
| `/evaluate` | Score text for logical flow, structure, clarity, and readability without editing it. |
| `/grammar-checker` | Multi-pass proofreading for typos, grammar, and awkward academic phrasing. |
| `/paper-validator` | Review a draft for weaknesses, missing evidence, and structural issues. |
| `/polish` | Rewrite text for grammar, fluency, and conference style while preserving LaTeX. |
| `/selection` | Propose three scored word or phrase candidates for a `[placeholder]`. |
| `/summary` | Summarize a section while keeping technical claims intact. |
| `/validation` | Score a `<>`-marked word or phrase and suggest alternatives when needed. |

The workflows keep the original claude-writer guidance: conference-calibrated feedback, LaTeX integrity, and an acceptance-bar rather than pedantic perfection.

## Install

Install the extension collection:

```bash
pi install git:github.com/minhuw/pi-extensions
```

To load only this extension from a local checkout:

```bash
pi -e ./extensions/writer/index.ts
```
