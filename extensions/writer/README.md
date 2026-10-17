# Writer

A native Pi prompt-template port of [claude-writer](https://github.com/minhuw/claude-writer): academic writing workflows for papers targeting top-tier computer science conferences.

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

Each command expands its template from `prompts/` into the current Pi session. Remaining text becomes the writing task or excerpt through Pi’s native `$ARGUMENTS` (shell-like quoting; arguments are joined with spaces). Guidance applies only to that invocation, not as permanent session rules. There is no Writer runtime or auto-discovered skill.

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

Install the collection:

```bash
pi install git:github.com/minhuw/pi-extensions
```

To load one workflow from a local checkout:

```bash
pi --prompt-template /absolute/path/to/pi-extensions/extensions/writer/prompts/polish.md
```

Repeat `--prompt-template` for additional workflows.

## Migration

- Collection users: update the package, then run `/reload` in an active session.
- Former direct `extensions/writer/index.ts` users: remove that extension entry (including any `-e` argument) and install the collection or select the new prompt files as above. The old entry point is removed.
- Former `/skill:<name>` users: use `/<name>` instead, for example `/skill:polish` becomes `/polish`. Remove any old Writer skill paths or copied skills from your configuration to avoid duplicate or autonomous discovery.
- Package filters now select Writer under `prompts`, not `extensions` or `skills`. If prompts are disabled with `[]`, or your filter uses `autoload: false`, enable the desired prompt paths. For example, to load only Writer from the collection:

  ```json
  {
    "packages": [
      {
        "source": "git:github.com/minhuw/pi-extensions",
        "extensions": [],
        "skills": [],
        "themes": [],
        "prompts": ["extensions/writer/prompts/*.md"]
      }
    ]
  }
  ```

  Filters narrow the eight explicit files declared by the package; they do not enable undeclared resources. Run `/reload` after changing templates or settings.
