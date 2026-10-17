# Terminal reference comparison

Observed startup and settings at 80×24 from the pinned OMP binary and final production Harness CLI, using disposable profiles without a model request. Profile paths and literal product names are normalized; ASCII wordmarks, versions, random tips, capability menus and runtime values remain visible differences. This is bounded visual review, not a pixel-equivalence score.

## OMP — Welcome

Evidence: `ev_60e1d747658d669029d0702be3d5fb30440e1145c7021a62a145f4ee49b6f7e8`; frame 155 at 3680 ms.

```text

                        ████████████
                           ██  ██       ▄▀▀▄ █▀▄▀▄ █▀▀▄
                           ██  ██       ▀▄▄▀ █ █ █ █▄▄▀
                           ▒▒  ██                  █
                               ██       v18.11.3

     Tip: `/copy code` grabs the last code block to your clipboard — `/copy
                    cmd` grabs the last shell/python command

 Warning: No default model selected. Use /login, set an API key environment
 variable, or select a local model with /model or --model.

 π > ⬢ no-model > 🗑 /profile/project > ◫ 2.2K/? ⟲ ▶───────
╰─                                                  ⇧⇥ to change thinking effort









```

## OMP — Settings

Evidence: `ev_60e1d747658d669029d0702be3d5fb30440e1145c7021a62a145f4ee49b6f7e8`; frame 163 at 8030 ms.

```text
╭─ Settings ───────────────────────────────────────────────────────────────────╮
│  🎨 Appearance    🤖    ⌨    📋    🧠    📁    💻    🔧    📦    🌐    📦    │
├──────────────────────────────────────────────────────────────────────────────┤
│   Theme                                                                    █ │
│ ❯ Dark Theme                  titanium                                     █ │
│   Light Theme                 light                                        │ │
│   Symbol Preset               unicode                                      │ │
│   Color-Blind Mode            false                                        │ │
│   Composer                                                                 │ │
│   Composer Shape              band                                         │ │
│   Generation Rate             false                                        │ │
│   Status Line                                                              │ │
│   Status Line Preset          default                                      │ │
│   Status Line Separator       powerline-thin                               │ │
│                                                                              │
│   Theme used when the terminal has a dark background                         │
│                                                                              │
│                                                                              │
│                                                                              │
│ Preview:                                                                     │
│  π > ⬢ no-model > 🗑 /profile/project > ◫ 2.2K/? ⟲ ▶──… │
├──────────────────────────────────────────────────────────────────────────────┤
│ ⏎/␣ to change · ⇥ to jump sections · ←/→ to switch tabs · Type to search · … │
╰──────────────────────────────────────────────────────────────────────────────╯
```

## Harness — Welcome

Evidence: `ev_f77284e263113f813d2f8a06a085b5447e55626af345e3a96aaf47eca0b7d95a`; frame 7 at 2910 ms.

```text

                        ████████████
                           ██  ██       PRODUCT
                           ██  ██
                           ▒▒  ██
                               ██       v0.1.6

     Tip: Use /accounts to manage sign-ins, /plugins to manage extensions,
                      and /hub to browse reusable skills.


No model is configured. Use /accounts or /login to sign in.
 π > ⬢ no-model > 📁 /private/var/folders/69/1vwvfl494kx0s... > Default ▶───────
╰─                                                  ⇧⇥ to change thinking effort










```

## Harness — Settings

Evidence: `ev_f77284e263113f813d2f8a06a085b5447e55626af345e3a96aaf47eca0b7d95a`; frame 15 at 8030 ms.

```text
╭─ Settings ───────────────────────────────────────────────────────────────────╮
│  🎨 Appearance    🤖 Model    ⌨ Interaction    📋 Context                    │
├──────────────────────────────────────────────────────────────────────────────┤
│ Theme                                                                        │
│ ❯ Theme          harness-titanium                                            │
│ Display                                                                      │
│   Hide thinking  off                                                         │
│ Images                                                                       │
│   Show images    on                                                          │
│   Resize images  on                                                          │
│                                                                              │
│                                                                              │
│                                                                              │
│                                                                              │
│                                                                              │
│                                                                              │
│                                                                              │
│                                                                              │
│ Theme loaded from the trusted resource catalog.                              │
│                                                                              │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│ Enter/Space change · Tab jump sections · ←/→ switch tabs · Type to search ·  │
╰──────────────────────────────────────────────────────────────────────────────╯
```

## Observations

Both screens use a centered five-row logo, status band and curved composer. Settings use rounded full-screen borders and inline section headings at 80 columns. Wider Harness screens show a section rail only when at least 60 columns remain for editable rows, following the inspected upstream constraint. Supported tabs, setting labels, current values and available actions differ with the capability set. The Harness status includes its pinned account.

OMP’s large capability catalog and configurable status presets were not imported. The initial OMP capture sent input before startup completed; it timed out and is retained as `omp-reference-80x24-early.json.gz`, excluded above. Both compared captures completed with code 0 and no output truncation. The final Harness capture also records the bundled CLI file digest before and after execution. Runtime and environmental limitations remain in the complete records.
