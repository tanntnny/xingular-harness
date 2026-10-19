# Third-party notices

## Harness²

The harness tree (`src/tree/`) and refinement (`src/refine/`) port the method of Harness²:
Recursive Agent Harnessing for an Open World (Xu, Chen, CuiZhu, Dalvi Mishra, Ming, Yu, Han,
Lee, Pfister; arXiv:2610.14224). The component surface and its validation, Propose–Probe–Compose
in parallel and sequential modes with its budget identity, blind answer-free selection, the
reflection record and the experience library, and the improver, selector and reflector prompts
are adapted from its reference implementation (`harness2/core`, `harness2/substrate`) for Pi.

Upstream: https://github.com/google-research/harness2 (Copyright 2026 Google LLC)

Licensed under the Apache License, Version 2.0 (the "License"); you may not use these files
except in compliance with the License. You may obtain a copy of the License at
https://www.apache.org/licenses/LICENSE-2.0. Unless required by applicable law or agreed to in
writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. Changes from upstream: ported
from Python to TypeScript; the OpenCode and Codex surfaces replaced by one Pi surface; executors
and improvers run as recorded harness sessions; benchmark adapters replaced by a host-supplied
`RefineHost`; prompt text that named a framework rewritten for Pi.

## Oh My Pi

The Harness terminal presentation adapts the titanium color palette, five-row Pi logo,
diagonal gradient and related terminal presentation conventions from Oh My Pi 18.11.3,
particularly `@oh-my-pi/pi-tui/src/theme/defaults/titanium.json` and
`@oh-my-pi/pi-tui/src/prompt/welcome.ts`.

Upstream: https://github.com/can1357/oh-my-pi

The adapted portions are included under the following upstream license. Harness-specific
product identity and runtime integration are maintained in this package. Dependencies retain
their own licenses and notices.

```text
MIT License

Copyright (c) 2025 Mario Zechner
Copyright (c) 2025-2026 Can Bölük
Copyright (c) 2026 Stencil Labs, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
