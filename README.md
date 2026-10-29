<p align="center">
  <img src="https://raw.githubusercontent.com/Ryu-CZ/pi-icarus-hook/main/media/banner.webp" alt="pi-icarus-hook banner" />
</p>

# pi-icarus-hook

**Give Pi access to your existing Hermes/Icarus memory.**

<p>
  <a href="https://www.npmjs.com/package/pi-icarus-hook"><img src="https://img.shields.io/npm/v/pi-icarus-hook" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/pi-icarus-hook"><img src="https://img.shields.io/npm/dt/pi-icarus-hook" alt="npm downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/pi-icarus-hook" alt="license"></a>
  <a href="https://pi.dev/packages/pi-icarus-hook"><img src="https://img.shields.io/badge/pi-package-1a1a2e" alt="pi package"></a>
</p>

Pick up where you left off, without reminding Pi to look up memory before every answer.

- **Remember the context.** Icarus supplies memories before Pi answers.
- **Carry useful work forward.** Successful exchanges go back to Icarus for capture.
- **Stay in control.** Turn automatic memory off, or simply hide its messages.

> This connects an existing [Hermes/Icarus](https://github.com/esaradev/icarus-plugin)
> / [Memory OS](https://github.com/ClaudioDrews/memory-os) installation. It does not install or replace the memory backend.

## Get started

You need **Pi**, **Node.js 22+**, and a working local Icarus installation with its Python dependencies.
The default plugin location is `~/.hermes/plugins/icarus`.

```bash
pi install npm:pi-icarus-hook
pi
```

Already running Pi? Reload or restart after installation. Then ask something natural:

> “What did we decide about this project last time?”

Memory context is visible by default. **🪽 Icarus** in the footer means automatic memory is on.
Pi can also search, recall, and write Fabric memories when you ask.

<p align="center">
  <img src="https://raw.githubusercontent.com/Ryu-CZ/pi-icarus-hook/main/media/usage.webp" alt="Icarus memory context and controls in Pi" />
</p>

## Everyday controls

| You want to… | Run in Pi |
|---|---|
| Check whether automatic memory is on | `/icarus status` |
| Stop automatic memory for this session | `/icarus off` |
| Turn it back on | `/icarus on` |
| Hide memory messages, but keep using memory | `/icarus context hide` |
| Show memory messages again | `/icarus context show` |
| Start future sessions with messages hidden | `/icarus context default hide global` |
| See the active configuration | `/icarus config` |

**Hiding is not disabling.** Hidden context still goes to the model. Turning automatic
memory off does not remove context already in the conversation or disable explicit Fabric tools.

Session controls apply now; saved defaults apply to future sessions.
Use `project` instead of `global` to save a visibility default just for a trusted project.

## Keep only useful context

The optional classifier automatically removes text it confidently judges irrelevant
before memory reaches Pi. Uncertain text stays; if classification fails, the original
context is kept. Startup context is left alone.

| `classifier` setting | What it does |
|---|---|
| `"default"` | Automatically choose an available classifier, preferring local models |
| `"none"` | Keep the original context without classification |
| `"provider/model-id"` | Use exactly that classifier from Pi |

**Privacy and cost:** `default` may use a configured remote provider when no local
classifier is available. That sends your prompt and candidate context to that provider
and may incur charges. Choose an exact local model to prevent remote fallback, or use `none`.

Filtering is a relevance estimate, not fact-checking. Discarded text may not be offered again later by Icarus.

## A few settings, only if you need them

Put this inside your Pi settings file—normally `~/.pi/agent/settings.json`—to hide
memory messages by default and disable classification:

```json
{
  "piIcarusHook": {
    "contextDisplay": false,
    "classifier": "none"
  }
}
```

For a different installation, add `"icarusDir": "/path/to/icarus"` and
`"python": "/path/to/venv/bin/python"` inside `piIcarusHook`.
Use the Python environment where Icarus's dependencies are installed.
Reload or restart Pi after editing settings.

Need more? [Full configuration reference →](VISION.md#configuration-reference)

## Help & further reading

- **Memory missing?** Check `/icarus status`, then `/icarus config` for the plugin and Python paths. After a backend failure, restart the session to reinitialize memory.
- **Found a problem?** [Report an issue](https://github.com/Ryu-CZ/pi-icarus-hook/issues).
- **What changed?** Read the [changelog](CHANGELOG.md).
- **Developing the extension?** Read the [technical vision & developer guide](VISION.md).
