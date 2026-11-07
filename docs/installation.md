# Installation

Install the collection as one Pi package to load its extensions, prompts, skills, and theme. You need Node.js **22.19.0 or newer** and **Pi 1.3.0 or newer**. [Herder](../extensions/herder/README.md) additionally needs Git **2.38 or newer** and a repository with at least one commit.

## Install in Pi

Run this in your terminal:

```bash
pi install git:github.com/minhuw/pi-extensions
```

Load the installed resources by restarting Pi or running this in your current session:

```text
/reload
```

For a local checkout, install its absolute path:

```bash
git clone https://github.com/minhuw/pi-extensions.git
cd pi-extensions
pi install "$PWD"
```

Pi loads the checkout's TypeScript directly. Use `/reload` after editing it; see [Development](development.md) for dependencies and checks.

## Resolve duplicate packages

- Remove or disable `npm:@tintinweb/pi-subagents` in the same Pi profile. This collection already includes its own [Subagents](../extensions/subagents/README.md) fork. Reload when no agents are running.
- Remove or disable `npm:pi-autoresearch` before using [Autoresearch](../extensions/autoresearch/README.md). Both register `/autoresearch`. Existing `.auto/` files are preserved; the collection does not automatically import or execute those campaigns.
- If your settings still load the retired CLIProxyAPI provider or standalone native-compaction extension paths, remove those entries. Their saved credentials and configuration files are not changed by installation.

## Connect optional services

The prompt templates and individual agents are available after installation. [Magpie](../extensions/magpie-provider/README.md) needs a running gateway and `/login magpie`. [pika](../extensions/pika/README.md) starts uploading only after configuration, normally through `/pika login` against your own [pika server](../services/pika/README.md).

For a light terminal background, choose the `material-bloom` theme in `/settings`. Scripted Subagents workflows are disabled by default and require explicit opt-in; individual agents remain available. See [Configuration](configuration.md) for these settings and [the extension reference](../README.md#extensions) for each command's full documentation.
