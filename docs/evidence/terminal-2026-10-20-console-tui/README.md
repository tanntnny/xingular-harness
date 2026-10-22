# OpenTUI console evidence — 2026-10-20

- `default-opentui-probe.json` and `default-opentui-80x24.ansi.gz` run the standalone command with
  `XINGULAR_HARNESS_TUI` unset. The home product mark and composer render, and Ctrl+C exits 0,
  proving OpenTUI is the only launch path after the Pi fallback was removed.
- `dialog-probes.json` and the `*-settings-dialog.ansi.gz` files are targeted PTY probes of the
  centered page dialog at 40x20, 80x24 and 120x40. They record the production OpenTUI frontend
  opening `/settings`, the observed panel rectangle, the `#111114` panel, the `#0b0b0d` console and
  the dimmed `#2b2b31` footer text produced by the `#0b0b0d99` scrim. The 40x20 capture also shows
  the dimmed welcome lockup around the panel. See `dialog-probes.json` for hashes and limits.
- `verification.json` and `40x20-welcome.ansi.gz` are an earlier full `scripts/verify-terminal.py`
  run under OpenTUI. It stopped at `/settings` because the verifier writes `/settings\r` as one
  burst and OpenTUI drops the Return in that burst. The targeted probes send the command
  characters and Return separately, as a person does, and are the evidence for the dialog work.
- `pi-80x24/verification.json` and its captures are the removed Pi frontend's full verifier run at
  80x24 in the same tree. They are retained as history; the default now launches OpenTUI.
- `palette-probes.json` and `palette-command-order.ansi.gz` are a targeted PTY probe of the command
  palette at 80x24. Typing `/account` lists `/accounts` first and selected, before `/resume`, whose
  description mentions an account. The palette shows only its rows and selection field: no border,
  title or key guide. Its JSON records the frontend build used, which includes the rule-only
  composer.
- `bash-mode-probes.json` and its three captures are targeted PTY probes of the OpenTUI Bash mode
  at 80x24: typing `!` turns the chevron into `!` and colors both composer rules and the command
  with `#00ff88`, Backspace on the empty command restores the neutral composer, and Return sends
  `!command` through the normal Bash gate, where the capture stops at its approval dialog.

Each capture is a cumulative raw ANSI stream from PTY startup through the opened dialog. Replay it
at its recorded dimensions, for example with `pyte`:

```python
import gzip, pyte
raw = gzip.open('80x24-settings-dialog.ansi.gz', 'rb').read()
screen = pyte.Screen(80, 24)
pyte.ByteStream(screen).feed(raw)
print('\n'.join(screen.display))
```
