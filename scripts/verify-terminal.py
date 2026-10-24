#!/usr/bin/env python3
"""Exercise the production Harness terminal and Pi SDK against a loopback SSE provider.

This is a transport fixture, not an AgentSession replacement. Every request goes through
Pi model selection, request streaming, real native tools, the Harness gate/socket, actual
terminal input, and the production run writer. No user credentials or private profiles load.
Run `npm run build` first, then `python3 scripts/verify-terminal.py`.
The report and raw PTY captures are retained in the printed disposable output directory.
"""
import argparse
import base64
import errno
import fcntl
import gzip
import hashlib
import http.server
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import tempfile
import termios
import threading
import time

REPOSITORY = Path(__file__).resolve().parent.parent
QUESTION_SELECTED_BG = '#193322'
QUESTION_ACTION_BG = '#35754a'
try:
    import pyte  # Optional: matches text on the rendered screen, not only in the raw byte stream.
except ImportError:
    pyte = None
ANSI = re.compile(r'\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][A-Z0-9]|\x1b[=>]')


def normalized(value):
    return ANSI.sub('', value.decode('utf-8', errors='replace') if isinstance(value, (bytes, bytearray)) else value)


def has_truecolor_background(raw, color):
    channels = bytes.fromhex(color.removeprefix('#'))
    pattern = rb'\x1b\[[0-9;]*48;2;' + b';'.join(str(channel).encode() for channel in channels) + rb'(?:;[0-9]+)*m'
    return re.search(pattern, raw) is not None


def has_slim_scrollbar_at_right_edge(output, width):
    glyph = '▕'.encode()
    for marker in re.finditer(re.escape(glyph), output):
        cursor_positions = list(re.finditer(rb'\x1b\[(\d+);(\d+)H', output[:marker.start()]))
        if cursor_positions and int(cursor_positions[-1].group(2)) >= width - 2:
            return True
    return False


def assert_prompt_gutter(terminal, marker, first_line, second_line, wrapped_word, label):
    if terminal.screen is None:
        return
    rows = terminal.screen.display
    first_rows = [line for line in rows if first_line in line]
    assert first_rows, f'{label}: PTY screen did not show {first_line!r}: {rows!r}'
    assert all(0 <= line.find(marker) < line.find(first_line) for line in first_rows), f'{label}: {marker!r} was not in the first-row gutter'
    continuation_rows = [line for line in rows if second_line in line]
    assert continuation_rows, f'{label}: PTY screen did not show {second_line!r}: {rows!r}'
    assert all(line.find(marker) < 0 or line.find(marker) > line.find(second_line) for line in continuation_rows), f'{label}: {marker!r} repeated on an explicit continuation row'
    wrapped_rows = [line for line in rows if wrapped_word in line]
    assert len(wrapped_rows) >= 2, f'{label}: input did not soft-wrap across multiple rows: {rows!r}'
    assert all(line.find(marker) < 0 or line.find(marker) > line.find(wrapped_word) for line in wrapped_rows), f'{label}: {marker!r} repeated on a soft-wrapped row: {wrapped_rows!r}'


class LocalProvider(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    requests = []
    root = None

    def log_message(self, *args):
        pass

    def do_GET(self):
        body = json.dumps({'object': 'list', 'data': [{'id': 'terminal-verifier', 'object': 'model'}]}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        messages = request.get('messages', [])
        user_index = max((i for i, item in enumerate(messages) if item.get('role') == 'user'), default=-1)
        user = str(messages[user_index].get('content', '')) if user_index >= 0 else ''
        results = [item for item in messages[user_index + 1:] if item.get('role') == 'tool']
        index = len(results)
        sequence = []
        if 'verify-flow' in user:
            sequence = [
                ('read', {'path': str(LocalProvider.root / 'fixture.txt')}),
                ('bash', {'command': "printf 'LOCAL_BASH_EXECUTED\\n'"}),
                ('ask_user_question', {'question': 'LOCAL_QUESTION: choose the actual option', 'options': [{'label': 'Verified', 'description': 'Exercise the real question bridge', 'recommended': True}, {'label': 'Other'}]})]
        elif 'verify-batch' in user:
            sequence = [('ask_user', {'questions': [
                {'summary': 'Batch choice', 'question': 'LOCAL_BATCH_CHOICE', 'options': [{'label': 'Batch A', 'description': 'First batch answer', 'recommended': True}]},
                {'summary': 'Batch reason', 'question': 'LOCAL_BATCH_REASON', 'options': [{'label': 'A listed reason', 'description': 'Choose this reason or enter another.', 'recommended': True}]}]})]
        elif 'verify-deny' in user or 'verify-approval-cancel' in user:
            sequence = [('bash', {'command': "printf 'blocked' > decision-must-not-execute.txt"})]
        elif 'verify-question-cancel' in user:
            sequence = [('ask_user_question', {'question': 'LOCAL_CANCEL_QUESTION', 'options': [{'label': 'Continue', 'recommended': True}]})]
        offered = [tool.get('function', {}).get('name') for tool in request.get('tools', [])]
        parts = messages[user_index].get('content') if user_index >= 0 else None
        images = sum(1 for part in parts if isinstance(part, dict) and part.get('type') == 'image_url') if isinstance(parts, list) else 0
        LocalProvider.requests.append({'at': time.time(), 'path': self.path, 'user': user, 'toolResults': index, 'tools': offered, 'images': images})
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Connection', 'close')
        self.end_headers()

        def chunk(delta=None, finish=None, usage=None):
            value = {'id': 'local-verifier', 'object': 'chat.completion.chunk', 'created': int(time.time()),
                     'model': 'terminal-verifier', 'choices': [{'index': 0, 'delta': delta or {}, 'finish_reason': finish}]}
            if usage:
                value['usage'] = usage
            self.wfile.write(('data: ' + json.dumps(value) + '\n\n').encode())
            self.wfile.flush()

        try:
            chunk({'role': 'assistant'})
            chunk({'reasoning_content': 'LOCAL_THINKING: inspect the real isolated fixture. '})
            time.sleep(0.08)
            if 'verify-cancel' in user or 'verify-stop' in user:
                for number in range(200):
                    chunk({'content': f'CANCEL_STREAM_{number:03d} '})
                    time.sleep(0.08)
            elif index < len(sequence):
                name, arguments = sequence[index]
                chunk({'content': f'LOCAL_STAGE_{index}: running {name}.\n'})
                chunk({'tool_calls': [{'index': 0, 'id': f'local_tool_{index}', 'type': 'function', 'function': {'name': name, 'arguments': ''}}]})
                encoded = json.dumps(arguments)
                for part in [encoded[:len(encoded)//2], encoded[len(encoded)//2:]]:
                    chunk({'tool_calls': [{'index': 0, 'function': {'arguments': part}}]})
                    time.sleep(0.05)
                chunk(finish='tool_calls', usage={'prompt_tokens': 40 + index, 'completion_tokens': 15, 'total_tokens': 55 + index})
                self.wfile.write(b'data: [DONE]\n\n')
                self.wfile.flush()
                return
            else:
                if 'Implement the plan' in user:
                    texts = ['LOCAL_IMPLEMENTED: ', 'the plan was carried out.\n']
                elif 'verify-markdown' in user:
                    texts = [
                        'LOCAL_MARKDOWN_START\n',
                        '# Primary heading\n\n',
                        '## Secondary heading\n\n',
                        '[Harness docs](https://example.test/docs)\n\n',
                        '**bold**, *italic*, ~~deleted~~, and `inline code`.\n\n',
                        '```ts\nconst answer = 42\n```\n\n',
                        '> Quoted guidance.\n\n',
                        '- unordered item\n1. ordered item\n- [x] complete\n- [ ] pending\n\n',
                        '| Name | Value |\n| --- | --- |\n| Markdown | styled |\n\n',
                        '---\n\n![Alt text](https://example.test/image.png)\n',
                        'LOCAL_MARKDOWN_DONE'
                    ]
                elif 'verify-plan' in user:
                    texts = ['LOCAL_PLAN: here is the plan. ', '<proposed_plan>', '# Verified plan\n\n', '1. Read `fixture.txt`.\n', '2. Confirm the result.\n', '</proposed_plan>']
                elif 'verify-scroll-latest' in user:
                    rows = '\n\n'.join(f'LOCAL_SCROLL_ROW_{number:02d}' for number in range(40))
                    texts = [f'LOCAL_SCROLL_START\n\n{rows}\n\nLOCAL_SCROLL_TAIL']
                else:
                    texts = ['LOCAL_FINAL: ', 'real SDK ', 'and terminal ', 'completed. ', 'Unicode 知識 🧠.\n']
                for text in texts:
                    chunk({'content': text})
                    time.sleep(0.07)
            chunk(finish='stop', usage={'prompt_tokens': 43, 'completion_tokens': 20, 'total_tokens': 63})
            self.wfile.write(b'data: [DONE]\n\n')
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            self.close_connection = True


class Terminal:
    def __init__(self, command, cwd, width, height, output):
        self.master, self.slave = pty.openpty()
        self.before = termios.tcgetattr(self.slave)
        self.output = output
        self.data = bytearray()
        self.width, self.height = width, height
        # A renderer that rewrites only changed cells may never emit a phrase contiguously.
        self.screen = pyte.Screen(width, height) if pyte else None
        self.screen_stream = pyte.ByteStream(self.screen) if pyte else None
        self.resize(width, height, initial=True)
        environment = {key: value for key, value in os.environ.items()
                       if not key.upper().endswith(('_API_KEY', '_AUTH_TOKEN', '_OAUTH_TOKEN', '_ACCESS_TOKEN'))
                       and key not in ['PI_CODING_AGENT_DIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']}
        environment.update({'TERM': 'xterm-256color', 'COLORTERM': 'truecolor'})

        def control_terminal():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)

        supervisor = ('import json, subprocess, sys, termios; '
                      'before=termios.tcgetattr(0); '
                      'result=subprocess.run(json.loads(sys.argv[1])); '
                      'after=termios.tcgetattr(0); '
                      'print(\"VERIFY_TTY_RESTORED=\"+str(before==after), flush=True); '
                      'sys.exit(result.returncode)')
        self.process = subprocess.Popen(['python3', '-c', supervisor, json.dumps(command)], cwd=cwd, env=environment, stdin=self.slave, stdout=self.slave,
                                        stderr=self.slave, preexec_fn=control_terminal, close_fds=True)
        self.snapshots = []

    def resize(self, width, height, initial=False):
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack('HHHH', height, width, 0, 0))
        self.width, self.height = width, height
        if getattr(self, 'screen', None) is not None:
            self.screen.resize(height, width)
        if not initial:
            os.killpg(self.process.pid, signal.SIGWINCH)

    def read(self, duration=0.1):
        deadline = time.monotonic() + duration
        while time.monotonic() < deadline:
            ready, _, _ = select.select([self.master], [], [], max(0.0, min(0.05, deadline - time.monotonic())))
            if ready:
                try:
                    part = os.read(self.master, 1024 * 128)
                except OSError as error:
                    if error.errno == errno.EIO:
                        return
                    raise
                if not part:
                    return
                self.data.extend(part)
                if self.screen_stream is not None:
                    try:
                        self.screen_stream.feed(part)
                    except Exception:
                        pass
                # Startup can fail after emitting a query but before the emulator replies.
                # Darwin returns EIO once the controlling tty has already gone away.
                replies = []
                if b'\x1b[6n' in part:
                    replies.append(b'\x1b[1;1R')
                if b'\x1b[c' in part:
                    replies.append(b'\x1b[?1;2c')
                for reply in replies:
                    try:
                        os.write(self.master, reply)
                    except OSError as error:
                        if error.errno != errno.EIO:
                            raise

    def send(self, text):
        os.write(self.master, text.encode() if isinstance(text, str) else text)
        self.read(0.12)

    def type_text(self, text):
        for character in text:
            self.send(character)

    def click(self, x, y):
        self.send(f'\x1b[<0;{x};{y}M')
        self.send(f'\x1b[<0;{x};{y}m')

    def move(self, x, y):
        self.send(f'\x1b[<35;{x};{y}M')

    def scroll(self, x, y, direction='up'):
        button = 64 if direction == 'up' else 65
        self.send(f'\x1b[<{button};{x};{y}M')

    def locate(self, needle):
        if self.screen is None:
            raise AssertionError('Install pyte to locate terminal controls for mouse verification')
        for y, line in enumerate(self.screen.display):
            x = line.find(needle)
            if x >= 0:
                return x + 1, y + 1
        raise AssertionError(f'Could not locate {needle!r} on the PTY screen: {self.screen.display!r}')

    def click_text(self, needle):
        x, y = self.locate(needle)
        self.click(x, y)

    def blank_rows_before(self, needle):
        _, y = self.locate(needle)
        count = 0
        for line in reversed(self.screen.display[:y - 1]):
            if line.strip(' │█'):
                break
            count += 1
        return count

    def assert_blank_rows_before(self, needle, expected, label):
        actual = self.blank_rows_before(needle)
        if actual != expected:
            raise AssertionError(f'{label}: expected {expected} blank row(s) above {needle!r}, found {actual}')

    def assert_blank_line_before(self, needle, label):
        if self.blank_rows_before(needle) < 1:
            raise AssertionError(f'{label}: expected a blank row above {needle!r}')

    def assert_blank_line_after(self, needle, label):
        _, y = self.locate(needle)
        if y >= self.height or self.screen.display[y].strip(' │█'):
            raise AssertionError(f'{label}: expected a blank row below {needle!r}')

    def wait(self, needle, start=0, timeout=35):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.read(0.08)
            if needle in normalized(self.data[start:]):
                return
            if self.screen is not None and any(needle in line for line in self.screen.display):
                return
            if self.process.poll() is not None:
                break
        raise AssertionError(f'PTY did not show {needle!r}; exit={self.process.poll()}; tail={normalized(self.data[-5000:])!r}')

    def snapshot(self, name):
        self.read(0.2)
        path = self.output / f'{name}.ansi'
        path.write_bytes(self.data)
        self.snapshots.append({'name': name, 'columns': self.width, 'rows': self.height, 'raw': str(path), 'bytes': len(self.data)})

    def close(self):
        def wait_exit(timeout):
            deadline = time.monotonic() + timeout
            while self.process.poll() is None and time.monotonic() < deadline:
                self.read(0.1)
            return self.process.poll() is not None
        if self.process.poll() is None:
            try:
                self.send('\x1b')
                self.read(0.25)
                if self.process.poll() is None:
                    self.send('\x15/quit\r')
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
            if not wait_exit(12):
                os.killpg(self.process.pid, signal.SIGTERM)
                if not wait_exit(8):
                    os.killpg(self.process.pid, signal.SIGKILL)
                    self.process.wait(timeout=5)
        self.read(0.15)
        # Darwin revokes tcgetattr on a slave once its controlling session exits. The
        # supervisor checks the actual same tty before exiting, while it is still live.
        try:
            restored = self.before == termios.tcgetattr(self.slave)
        except termios.error:
            restored = b'VERIFY_TTY_RESTORED=True' in self.data
        (self.output / 'complete.ansi').write_bytes(self.data)
        os.close(self.master)
        os.close(self.slave)
        return {'exitCode': self.process.returncode, 'termiosRestored': restored,
                'bracketedPasteDisabled': self.data.rfind(b'\x1b[?2004l') > self.data.rfind(b'\x1b[?2004h'),
                'cursorShown': self.data.rfind(b'\x1b[?25h') > self.data.rfind(b'\x1b[?25l'), 'snapshots': self.snapshots}


def rpc_accounts(cli, root):
    child = subprocess.Popen(['node', str(cli), 'serve', '--state', str(root / 'state'), '--data', str(root / 'data')],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    serial = 0

    def call(method, params=None):
        nonlocal serial
        serial += 1
        child.stdin.write(json.dumps({'v': 1, 'id': str(serial), 'method': method, 'params': params or {}}) + '\n')
        child.stdin.flush()
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            line = child.stdout.readline()
            if not line:
                raise AssertionError('Account setup server exited: ' + child.stderr.read())
            value = json.loads(line)
            if value.get('id') == str(serial):
                if value.get('error'):
                    raise AssertionError(value['error'])
                return value.get('result')
        raise AssertionError('Account setup RPC timed out')
    try:
        first = call('accounts.create', {'label': 'Verifier First', 'authKind': 'apiKey'})
        second = call('accounts.create', {'label': 'Verifier Second', 'authKind': 'apiKey'})
        call('harness.shutdown')
        return first, second
    finally:
        child.stdin.close()
        child.wait(timeout=12)


def records(root):
    result = []
    for path in (root / 'data' / 'runs').glob('*/run.json'):
        record = json.loads(path.read_text())
        events = path.with_name('events.jsonl')
        record['_events'] = [json.loads(line) for line in events.read_text().splitlines()] if events.exists() else []
        result.append(record)
    return result


def wait_for_goal(terminal, root, goal, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        matching = [record for record in records(root) if record.get('goal') == goal]
        if matching and matching[-1].get('status') in {'completed', 'failed', 'interrupted'}:
            return matching[-1]
        terminal.read(0.1)
    raise AssertionError(f'Run for {goal!r} did not settle')


def save_evidence(report, source, destination):
    """Keep bounded replayable evidence, without copying disposable runtime/account data."""
    destination.mkdir(parents=True, exist_ok=True)
    wanted = {'40x20': ['welcome', 'settings-interaction', 'settings-keyboard'],
              '80x24': ['approval-0', 'question', 'plugin-light', 'question-batch'], '120x40': ['completed-transcript']}
    browser_captures = {'harness-browser', 'skills-browser', 'skill-inspector', 'browser-preserved-draft', 'skills-discover', 'community-filter', 'connections-browser', 'browser-resized'}
    captures = []
    for profile in report['profiles']:
        for snapshot in profile.get('snapshots', []):
            if snapshot['name'] not in wanted.get(profile['size'], []) and snapshot['name'] not in browser_captures:
                continue
            original = Path(snapshot['raw'])
            raw = original.read_bytes()
            archive = f"{profile['size']}-{snapshot['name']}.ansi.gz"
            compressed = gzip.compress(raw, compresslevel=9, mtime=0)
            (destination / archive).write_bytes(compressed)
            captures.append({'file': archive, 'kind': 'actual PTY cumulative raw ANSI stream',
                             'columns': snapshot['columns'], 'rows': snapshot['rows'],
                             'rawBytes': len(raw), 'rawSha256': hashlib.sha256(raw).hexdigest(),
                             'archiveBytes': len(compressed), 'archiveSha256': hashlib.sha256(compressed).hexdigest()})
    concise = {'passed': report.get('passed', False), 'implementation': report['implementation'],
               'cli': report['cli'], 'cliSha256': report['cliSha256'],
               'terminalBundleSha256': report.get('terminalBundleSha256'), 'verifierSha256': report['verifierSha256'],
               'provider': 'controlled loopback OpenAI-compatible streaming transport; no external model requests or user credentials',
               'requestCount': len(report.get('requests', [])),
               'profiles': [{key: value for key, value in profile.items() if key != 'snapshots'} for profile in report['profiles']],
               'captures': captures,
               'limits': ['The AgentSession, frontend, native tools, authorization and run writer are production code.',
                          'The controlled local transport supplies deterministic model responses and usage fixtures.',
                          'These functional checks do not establish external provider OAuth/service availability or visual equivalence to OMP.',
                          'Each compressed capture is a cumulative actual ANSI stream from PTY startup through the named interaction. Replay at its recorded dimensions.']}
    (destination / 'verification.json').write_text(json.dumps(concise, indent=2, ensure_ascii=False) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--sizes', help='Comma-separated terminal sizes to verify')
    parser.add_argument('--click-focus-only', action='store_true', help='Verify chat-click composer focus without running the full interaction suite')
    parser.add_argument('--composer-only', action='store_true', help='Verify normal, plan, and Bash composer modes and multiline gutters in an isolated PTY')
    parser.add_argument('--file-completion-only', action='store_true', help='Verify file and folder completion in an isolated PTY')
    parser.add_argument('--history-only', action='store_true', help='Verify active-session prompt history in an isolated PTY')
    parser.add_argument('--questions-only', action='store_true', help='Verify question choices, recommendation, and green action colors in an isolated PTY')
    parser.add_argument('--jump-latest-only', action='store_true', help='Verify the transcript jump-to-latest badge and click behavior in an isolated PTY (screen assertions use optional pyte)')
    parser.add_argument('--help-only', action='store_true', help='Verify grouped, wrapping /help output in an isolated PTY')
    parser.add_argument('--browser-only', action='store_true', help='Verify the unified resource browser, skills and discovery without model requests')
    parser.add_argument('--trajectory-only', action='store_true', help='Verify the full-screen searchable trajectory page in an isolated PTY')
    parser.add_argument('--palette-only', action='store_true', help='Verify two-column slash-command wrapping and selection in an isolated PTY')
    parser.add_argument('--markdown-only', action='store_true', help='Verify streamed Markdown rendering in an isolated PTY')
    parser.add_argument('--attachments-only', action='store_true', help='Verify pasted images, collapsed large pastes, whole-label deletion and image delivery in an isolated PTY')
    parser.add_argument('--thinking-only', action='store_true', help='Verify /thinking show, hide, and toggle in an isolated PTY')
    parser.add_argument('--compaction-only', action='store_true', help='Verify a persisted compaction card, collapsed summary and Ctrl+O expansion in an isolated PTY')
    parser.add_argument('--cli', type=Path, default=REPOSITORY / 'dist' / 'cli.js', help='Actual bundled Harness CLI to exercise (including an embedding sidecar CLI)')
    parser.add_argument('--save-evidence', type=Path, help='Save concise durable verification evidence and compressed representative PTY captures')
    args = parser.parse_args()
    output = args.output.resolve() if args.output else Path(tempfile.mkdtemp(prefix='harness-terminal-verify-')).resolve()
    output.mkdir(parents=True, exist_ok=True)
    cli = args.cli.resolve()
    if not cli.exists():
        raise SystemExit('Run npm run build before PTY verification.')
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), LocalProvider)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    report = {'output': str(output), 'provider': f'http://127.0.0.1:{server.server_port}',
              'implementation': 'production standalone CLI + real Pi SDK + loopback OpenAI SSE transport',
              'cli': str(cli), 'cliSha256': hashlib.sha256(cli.read_bytes()).hexdigest(),
              'terminalBundleSha256': hashlib.sha256((cli.parent / 'terminal-opentui.js').read_bytes()).hexdigest() if (cli.parent / 'terminal-opentui.js').exists() else None,
              'verifierSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'profiles': []}
    print(f'Isolated terminal evidence: {output}', flush=True)
    try:
        sizes = args.sizes.split(',') if args.sizes else ['40x20', '80x24', '120x40']
        if not args.sizes and args.palette_only:
            sizes = ['40x20', '80x24']
        elif not args.sizes and (args.help_only or args.trajectory_only):
            sizes = ['40x20', '80x24', '120x40']
        elif not args.sizes and (args.attachments_only or args.composer_only or args.file_completion_only or args.history_only or args.questions_only or args.jump_latest_only or args.thinking_only or args.compaction_only):
            sizes = ['80x24']
        elif not args.sizes and args.markdown_only:
            sizes = ['120x40']
        for dimensions in sizes:
            width, height = map(int, dimensions.split('x'))
            root = output / dimensions
            root.mkdir()
            (root / 'fixture.txt').write_text('LOCAL_FILE_CONTENT: real read tool executed. 知識 🧠\n')
            completion_fixture = root / 'completion-fixture'
            completion_fixture.mkdir()
            (completion_fixture / 'alpha.ts').write_text('')
            (completion_fixture / 'assets').mkdir()
            component = root / 'data' / 'registry' / 'skills' / 'verifier' / 'SKILL.md'
            component.parent.mkdir(parents=True)
            component.write_text('---\nname: Verifier skill\ndescription: Verify the terminal UI.\n---\nRead the current page.\n')
            LocalProvider.root = root
            shared = root / 'state' / 'accounts' / '_shared' / 'pi'
            shared.mkdir(parents=True)
            (shared / 'models.json').write_text(json.dumps({'providers': {'terminal-local': {
                'baseUrl': report['provider'] + '/v1', 'api': 'openai-completions', 'apiKey': 'isolated-loopback-fixture',
                'compat': {'supportsDeveloperRole': False, 'supportsReasoningEffort': False, 'supportsStore': False},
                'models': [{'id': 'terminal-verifier', 'name': 'Local terminal verifier', 'reasoning': True,
                            'input': ['text', 'image'] if args.attachments_only else ['text'], 'contextWindow': 32768, 'maxTokens': 2048,
                            'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}}]}}}))
            (shared / 'settings.json').write_text(json.dumps({'defaultProvider': 'terminal-local', 'defaultModel': 'terminal-verifier',
                                                              'defaultThinkingLevel': 'medium', 'enableAnalytics': False}))
            if args.browser_only:
                active_skill = shared / 'skills' / 'browser-active' / 'SKILL.md'
                active_skill.parent.mkdir(parents=True)
                active_skill.write_text('---\nname: browser-active\ndescription: Inspect a browser fixture.\n---\nRead the fixture.\n')
            extensions = shared / 'extensions'
            extensions.mkdir()
            (extensions / 'terminal-verifier.js').write_text('''export default function(pi) {
              pi.registerCommand('verify-plugin', { description: 'Disposable custom UI fixture', handler: async (_args, ctx) => {
                if (!ctx.ui.setTheme('light').success) throw new Error('Built-in light theme is unavailable');
                ctx.ui.setStatus('verifier', 'PLUGIN_STATUS');
                ctx.ui.setWidget('verifier', ['PLUGIN_WIDGET']);
                const result = await ctx.ui.custom((_tui, _theme, _keys, done) => ({
                  render: () => ['PLUGIN_CUSTOM_UI: Enter to accept'], invalidate() {},
                  handleInput(data) { if (data === '\\r') done('accepted') },
                  dispose() { ctx.ui.setStatus('verifier', undefined) }
                }));
                ctx.ui.setWidget('verifier', undefined);
                ctx.ui.setTheme('harness-titanium');
                ctx.ui.notify('PLUGIN_CUSTOM_DONE: ' + result);
              }});
              pi.registerCommand('verify-plugin-fatal', { description: 'Disposable fatal cleanup fixture', handler: async () => {
                setTimeout(() => { throw new Error('PLUGIN_FATAL_FIXTURE') }, 50);
                setTimeout(() => { throw new Error('PLUGIN_SECOND_FATAL_FIXTURE') }, 80);
              }});
              pi.registerCommand('verify-palette-short', { description: 'SHORT_DESC_START Wrap this description into several lines. SHORT_DESC_END', handler: async (_args, ctx) => {
                ctx.ui.notify('PALETTE_SHORT_EXECUTED');
              }});
              pi.registerCommand('verify-palette-with-a-deliberately-long-command-name-that-wraps', { description: 'LONG_DESC_START Wrap this description into several lines. LONG_DESC_END', handler: async (_args, ctx) => {
                ctx.ui.notify('PALETTE_LONG_EXECUTED');
              }});
            }''')
            rpc_accounts(cli, root)
            compaction_session = None
            if args.compaction_only:
                cwd = str(root.resolve())
                history_dir = root / 'data' / 'sessions' / 'terminal' / hashlib.sha256(cwd.encode()).hexdigest() / 'pi'
                history_dir.mkdir(parents=True, exist_ok=True)
                fixture = """
                  import { SessionManager } from '@earendil-works/pi-coding-agent'
                  const [cwd, sessionDir] = process.argv.slice(1)
                  const session = SessionManager.create(cwd, sessionDir, { id: 'compaction-verifier' })
                  session.appendMessage({ role: 'user', content: 'An earlier discussion is now represented by the compacted summary.' })
                  session.appendCompaction('COMPACTION_FIXTURE_BODY: Keep the implementation decision and restore the remaining state.', null, 12345)
                  session.appendMessage({ role: 'user', content: 'Please inspect the persisted compaction summary card.' })
                  console.log(session.getSessionFile())
                """
                compaction_session = os.path.realpath(subprocess.check_output(
                    ['node', '--input-type=module', '-e', fixture, cwd, str(history_dir)],
                    cwd=REPOSITORY, text=True
                ).strip())
            terminal = Terminal(['node', str(cli), '--state', str(root / 'state'), '--data', str(root / 'data')], root, width, height, root)
            profile = {'size': dimensions, 'checks': []}
            report['profiles'].append(profile)
            try:
                terminal.wait('Verifier First', timeout=50)
                terminal.read(2.0)
                terminal.snapshot('welcome')
                if args.markdown_only or args.jump_latest_only:
                    profile['checks'].append('welcome and isolated local session startup')
                else:
                    profile['checks'].append('welcome and real configured model')
                if args.trajectory_only:
                    start = len(terminal.data)
                    terminal.send('verify-trajectory')
                    terminal.send('\r')
                    terminal.wait('LOCAL_FINAL:', start, timeout=50)
                    record = wait_for_goal(terminal, root, 'verify-trajectory')
                    assert record.get('status') == 'completed', 'The trajectory fixture run did not complete'
                    terminal.send('/plugin:trajectory')
                    terminal.send('\r')
                    terminal.wait('Type to search', start, timeout=15)
                    terminal.snapshot('trajectory-runs-fullscreen')
                    if terminal.screen is not None:
                        visible = '\n'.join(terminal.screen.display)
                        assert 'Runs' in terminal.screen.display[0], f'Trajectory Runs did not fill the screen: {terminal.screen.display!r}'
                        assert 'Esc close' in terminal.screen.display[-1], f'Trajectory full-screen footer was not visible: {terminal.screen.display!r}'
                    terminal.send('\t')
                    terminal.wait('Event JSON', start, timeout=15)
                    search_start = len(terminal.data)
                    terminal.send('usage.updated')
                    terminal.wait('1 of', search_start, timeout=10)
                    terminal.snapshot('trajectory-events-search')
                    if terminal.screen is not None:
                        visible = '\n'.join(terminal.screen.display)
                        assert 'Events' in terminal.screen.display[0], f'Trajectory Events tab was not active: {terminal.screen.display!r}'
                        assert 'usage.updated' in visible and '1 of ' in visible, f'Event search did not filter the ledger: {terminal.screen.display!r}'
                        assert 'Event JSON · usage.updated' in visible, f'Selected-event JSON was not shown: {terminal.screen.display!r}'
                        if width >= 80:
                            event_line = next(line for line in terminal.screen.display if '❯' in line and 'usage.updated' in line)
                            detail_line = next(line for line in terminal.screen.display if 'Event JSON · usage.updated' in line)
                            assert detail_line.index('Event JSON') > event_line.index('usage.updated'), 'The JSON details did not appear beside the event list'
                    profile['checks'].append('full-screen Runs/Events tabs, event search, selected-event JSON, and responsive layout')
                    terminal.send('\x1b')
                    terminal.send('\x1b')
                    terminal.send('/quit')
                    terminal.send('\r')
                    continue
                if args.browser_only:
                    requests_before = len(LocalProvider.requests)
                    for command, marker in [('/harness', 'Foundation'), ('/skills', 'Available now')]:
                        start = len(terminal.data)
                        terminal.send(command)
                        terminal.send('\r')
                        terminal.wait(marker, start, timeout=15)
                        terminal.snapshot(command[1:] + '-browser')
                        if terminal.screen is not None:
                            top = terminal.screen.display[0]
                            assert ('Overview' if command == '/harness' else 'Skills') in top, f'Browser is not full-screen: {top!r}'
                        if command == '/harness':
                            terminal.send('\t\x1b[C')
                            terminal.wait('Fixed runtime', timeout=15)
                            terminal.send('\x1b[D')
                            terminal.send('\x1b[Z')
                            terminal.read(0.2)
                            if terminal.screen is not None and width >= 120:
                                top = terminal.screen.display[0]
                                terminal.click(top.index('Plugins') + 1, 1)
                                terminal.wait('Add plugin', timeout=15)
                                top = terminal.screen.display[0]
                                terminal.click(top.index('Overview') + 1, 1)
                                terminal.read(0.2)
                        terminal.send('\x1b')
                    start = len(terminal.data)
                    terminal.send('$browser-a')
                    terminal.wait('Inspect a browser', start)
                    terminal.snapshot('skill-completion')
                    terminal.send('\r')
                    terminal.read(0.2)
                    assert len(LocalProvider.requests) == requests_before, 'Skill completion submitted a model request'
                    terminal.send('\x03')
                    start = len(terminal.data)
                    terminal.send('/skills')
                    terminal.send('\r')
                    terminal.wait('Available now', start)
                    terminal.send('browser-active')
                    terminal.send('\r')
                    terminal.wait('Use $browser-active', start)
                    terminal.snapshot('skill-inspector')
                    terminal.send('\r')
                    terminal.wait('$browser-active', start)
                    terminal.send('\x03')
                    terminal.send('Keep my draft')
                    terminal.send('\x0b')
                    terminal.send('skills')
                    terminal.send('\r')
                    terminal.wait('Available now')
                    terminal.send('browser-active')
                    terminal.send('\r')
                    terminal.wait('Use $browser-active')
                    terminal.send('\r')
                    terminal.read(0.3)
                    terminal.snapshot('browser-preserved-draft')
                    if terminal.screen is not None:
                        shown = '\n'.join(terminal.screen.display)
                        assert '$browser-active' in shown and 'Keep my draft' in shown, f'Browser lost the existing draft: {shown!r}'
                    terminal.send('\x03')
                    start = len(terminal.data)
                    terminal.send('/skills')
                    terminal.send('\r')
                    terminal.wait('Available now', start)
                    terminal.send('\x1b[Z' * 3)
                    terminal.send('\x1b[C')
                    terminal.read(0.3)
                    terminal.snapshot('skills-discover')
                    terminal.send('\t')
                    terminal.send('\x1b[C')
                    terminal.read(0.2)
                    terminal.snapshot('community-filter')
                    terminal.wait('Filter: community')
                    if terminal.screen is not None:
                        position = terminal.locate('Filter: community')
                        terminal.click(*position)
                        terminal.wait('Choose view')
                        terminal.send('\x1b')
                        terminal.read(0.2)
                        if width >= 80:
                            terminal.resize(40, 20)
                            terminal.read(0.4)
                            terminal.snapshot('browser-resized')
                            assert 'Filter: community' in '\n'.join(terminal.screen.display), 'Resize lost source/filter state'
                            terminal.resize(width, height)
                            terminal.read(0.3)
                    profile['checks'].append('Ctrl+K preserves existing draft; mouse opens filters; responsive resize preserves filter state')
                    terminal.send('\x1b')
                    terminal.send('\x1b')
                    start = len(terminal.data)
                    terminal.send('/mcp')
                    terminal.send('\r')
                    terminal.wait('Add connection', start)
                    terminal.snapshot('connections-browser')
                    terminal.send('\x1b')
                    assert len(LocalProvider.requests) == requests_before, 'Browser actions sent a model request'
                    profile['checks'].append('full-screen persistent tabs, keyboard and mouse section selection, unified overview/skills/MCP, loaded skill completion and insertion, Discover and Community filter without model requests')
                    terminal.send('/quit')
                    terminal.send('\r')
                    continue
                if args.palette_only:
                    start = len(terminal.data)
                    terminal.send('/verify-palette')
                    terminal.read(0.4)
                    terminal.snapshot('palette-wrapped-columns')
                    if terminal.screen is not None:
                        rows = terminal.screen.display

                        def locate_row(fragment):
                            for row, line in enumerate(rows):
                                if fragment in line:
                                    return row, line.index(fragment)
                            raise AssertionError(f'Could not locate {fragment!r} in the palette: {rows!r}')

                        short_description = locate_row('SHORT_DESC_START')
                        long_description = locate_row('LONG_DESC_START')
                        assert short_description[1] == long_description[1], f'Description columns were not aligned: {rows!r}'
                        command_start = locate_row('/verify-palette')
                        command_end = locate_row('name-that-wraps')
                        assert command_start[0] != command_end[0], f'The long command name did not wrap: {rows!r}'
                        short_end = locate_row('SHORT_DESC_END')
                        long_end = locate_row('LONG_DESC_END')
                        assert short_description[0] != short_end[0] and long_description[0] != long_end[0], f'Descriptions did not wrap: {rows!r}'
                        profile['checks'].append('command and description columns align; long names and both descriptions wrap in the rendered PTY')
                    else:
                        rendered = normalized(bytes(terminal.data[start:]))
                        for marker in ['SHORT_DESC_START', 'SHORT_DESC_END', 'LONG_DESC_START', 'LONG_DESC_END', 'name-that-wraps']:
                            assert marker in rendered, f'The wrapped palette did not render {marker!r}'
                        profile['checks'].append('long command and descriptions render; column geometry skipped because optional pyte is unavailable')
                    terminal.send('\x1b[B')
                    terminal.send('\r')
                    terminal.wait('PALETTE_LONG_EXECUTED', start, timeout=10)
                    profile['checks'].append('Down and Enter activate the second wrapped palette row')
                    terminal.send('/quit')
                    terminal.send('\r')
                    continue
                if args.help_only:
                    start = len(terminal.data)
                    requests_before_help = len(LocalProvider.requests)
                    terminal.send('/help')
                    terminal.send('\r')
                    terminal.wait('LONG_DESC_END', start, timeout=10)
                    terminal.read(0.3)
                    terminal.snapshot('help-transcript')
                    if terminal.screen is not None:
                        terminal.send('\x1b[5~' * 20)
                        terminal.read(0.2)
                        top_rows = terminal.screen.display
                        top = '\n'.join(top_rows)
                        assert 'One run, done well.' not in top, f'/help left the welcome message visible: {top_rows!r}'
                        assert all(group in top for group in ['Core', '/help', '/hotkeys', '/quit']), f'/help Core group is not visible: {top_rows!r}'

                        def locate_help(fragment, rows):
                            for row, line in enumerate(rows):
                                if fragment in line:
                                    return row, line.index(fragment)
                            raise AssertionError(f'Could not locate {fragment!r} in /help: {rows!r}')

                        help_row = locate_help('/help', top_rows)[0]
                        hotkeys_row = locate_help('/hotkeys', top_rows)[0]
                        quit_row = locate_help('/quit', top_rows)[0]
                        assert all(line.strip() for line in top_rows[help_row:quit_row + 1]), f'/help inserted blank rows between Core choices: {top_rows!r}'
                        if width >= 80:
                            assert hotkeys_row == help_row + 1 and quit_row == hotkeys_row + 1, f'Core choices were not contiguous: {top_rows!r}'
                            help_description = locate_help('List the commands', top_rows)[1]
                            hotkeys_description = locate_help('Keyboard controls', top_rows)[1]
                            assert help_description == hotkeys_description, f'Help descriptions did not align: {top_rows!r}'

                        pages = [top]
                        for _ in range(20):
                            terminal.send('\x1b[6~')
                            pages.append('\n'.join(terminal.screen.display))
                        rendered = '\n'.join(pages)
                        for group in ['Run', 'Model', 'Session', 'Inspect', 'Harness', 'Extensions']:
                            assert group in rendered, f'/help did not render the {group} group while scrolling: {pages!r}'
                        wrapped_name = 'name-that-wraps' if width >= 80 else 'me-that-wraps'
                        for marker in ['SHORT_DESC_START', 'SHORT_DESC_END', 'LONG_DESC_START', 'LONG_DESC_END', wrapped_name]:
                            assert marker in rendered, f'/help did not render wrapped command content {marker!r}'
                        if width >= 80:
                            aligned_page = next((page.splitlines() for page in pages if 'SHORT_DESC_START' in page and 'LONG_DESC_START' in page), None)
                            assert aligned_page is not None, f'Could not inspect both extension descriptions in one view: {pages!r}'
                            short_column = locate_help('SHORT_DESC_START', aligned_page)[1]
                            long_column = locate_help('LONG_DESC_START', aligned_page)[1]
                            assert short_column == long_column, f'Extension descriptions did not align: {aligned_page!r}'
                        profile['checks'].append('/help groups commands, wraps both columns, and keeps choices contiguous at ' + dimensions)
                    else:
                        rendered = normalized(bytes(terminal.data[start:]))
                        for marker in ['LONG_DESC_START', 'LONG_DESC_END']:
                            assert marker in rendered, f'/help did not render wrapped content {marker!r}'
                        profile['checks'].append('/help command and description wrapping render; screen layout assertions skipped because optional pyte is unavailable')
                    assert len(LocalProvider.requests) == requests_before_help, '/help sent a model request'
                    terminal.send('/quit\r')
                    continue
                if args.jump_latest_only:
                    start = len(terminal.data)
                    terminal.send('verify-scroll-latest\r')
                    terminal.wait('LOCAL_SCROLL_TAIL', start, timeout=50)
                    record = wait_for_goal(terminal, root, 'verify-scroll-latest')
                    assert record.get('status') == 'completed', 'The long transcript fixture did not complete'
                    terminal.read(0.3)
                    assert has_slim_scrollbar_at_right_edge(bytes(terminal.data[start:]), width), 'The slim transcript scrollbar thumb was not emitted at the right edge'
                    if terminal.screen is not None:
                        assert 'Jump to latest' not in '\n'.join(terminal.screen.display), 'The jump badge appeared while pinned to the latest message'
                        assert any('▕' in line[-4:] for line in terminal.screen.display), 'The slim transcript scrollbar thumb was not rendered at the right edge'
                    terminal.scroll(max(1, width // 2), max(1, height // 2))
                    terminal.wait('Jump to latest', start, timeout=10)
                    assert has_slim_scrollbar_at_right_edge(bytes(terminal.data[start:]), width), 'The slim transcript scrollbar thumb disappeared from the right edge after scrolling away'
                    if terminal.screen is not None:
                        assert 'Jump to latest' in '\n'.join(terminal.screen.display), 'Mouse-wheel scrolling away did not show the jump badge'
                        assert any('▕' in line[-4:] for line in terminal.screen.display), 'The slim scrollbar thumb disappeared after scrolling away'
                        terminal.click_text('Jump to latest')
                        terminal.read(0.3)
                        visible = '\n'.join(terminal.screen.display)
                        assert 'Jump to latest' not in visible, 'Clicking the badge did not hide it at the latest message'
                        assert 'LOCAL_SCROLL_TAIL' in visible, 'Clicking the badge did not return to the latest transcript content'
                        terminal.send('\x1b[5~')
                        terminal.wait('Jump to latest', start, timeout=10)
                        terminal.click_text('Jump to latest')
                        terminal.read(0.3)
                        visible = '\n'.join(terminal.screen.display)
                        assert 'Jump to latest' not in visible and 'LOCAL_SCROLL_TAIL' in visible, 'Clicking the badge after PgUp did not return to the latest message'
                        profile['checks'].append('slim right-edge scrollbar thumb; badge hidden while pinned, shown after wheel and PageUp scrolling, and clicked to return to latest content')
                    else:
                        terminal.click(max(1, width - 10), max(1, height - 7))
                        terminal.read(0.3)
                        terminal.send('\x1b[5~')
                        terminal.wait('Jump to latest', start, timeout=10)
                        terminal.click(max(1, width - 10), max(1, height - 7))
                        terminal.read(0.3)
                        profile['checks'].append('slim right-edge glyph emitted; badge appears after wheel and PageUp scrolling; screen rendering assertions skipped because optional pyte is unavailable')
                    terminal.send('/quit\r')
                    continue
                if args.compaction_only:
                    start = len(terminal.data)
                    terminal.send(f'/resume {compaction_session}\r')
                    terminal.wait('Compacted from 12,345 tokens', start, timeout=20)
                    collapsed = normalized(bytes(terminal.data[start:]))
                    assert 'COMPACTION_FIXTURE_BODY' not in collapsed, 'Compaction summary was not collapsed by default'
                    if terminal.screen is not None:
                        visible = '\n'.join(terminal.screen.display)
                        assert visible.count('Compacted from 12,345 tokens') == 1, 'Reloaded history did not show exactly one compaction card'
                    terminal.snapshot('compaction-collapsed-after-resume')
                    start = len(terminal.data)
                    terminal.send('\x0f')
                    terminal.wait('COMPACTION_FIXTURE_BODY', start, timeout=15)
                    profile['checks'].append('persisted Pi compaction history reloads as one collapsed token-count card; Ctrl+O expands its Markdown summary')
                    continue
                if args.thinking_only:
                    start = len(terminal.data)
                    terminal.send('verify-thinking')
                    terminal.send('\r')
                    terminal.wait('LOCAL_FINAL:', start, timeout=50)
                    record = wait_for_goal(terminal, root, 'verify-thinking')
                    assert record.get('status') == 'completed', 'The thinking-visibility fixture did not complete'
                    terminal.read(0.3)
                    request_count = len(LocalProvider.requests)
                    thinking = 'LOCAL_THINKING: inspect the real isolated fixture.'
                    if terminal.screen is not None:
                        visible = '\n'.join(terminal.screen.display)
                        assert thinking in visible, f'Thinking should initially be visible: {terminal.screen.display!r}'
                    terminal.snapshot('thinking-visible')

                    start = len(terminal.data)
                    terminal.send('/thinking hide')
                    terminal.send('\r')
                    terminal.wait('Thinking blocks hidden.', start)
                    if terminal.screen is not None:
                        visible = '\n'.join(terminal.screen.display)
                        assert thinking not in visible, f'/thinking hide left thinking visible: {terminal.screen.display!r}'
                        assert 'LOCAL_FINAL:' in visible, 'Hiding thinking also hid the assistant response'
                    terminal.snapshot('thinking-hidden')

                    start = len(terminal.data)
                    terminal.send('/thinking show')
                    terminal.send('\r')
                    terminal.wait('Thinking blocks shown.', start)
                    terminal.read(0.2)
                    if terminal.screen is not None:
                        visible = '\n'.join(terminal.screen.display)
                        assert thinking in visible, f'/thinking show did not restore thinking: {terminal.screen.display!r}'
                    terminal.snapshot('thinking-shown')

                    start = len(terminal.data)
                    terminal.send('/thinking')
                    terminal.send('\r')
                    terminal.wait('Thinking blocks hidden.', start)
                    if terminal.screen is not None:
                        assert thinking not in '\n'.join(terminal.screen.display), '/thinking did not toggle thinking off'
                    terminal.send('/thinking')
                    terminal.send('\r')
                    terminal.wait('Thinking blocks shown.', start)
                    if terminal.screen is not None:
                        assert thinking in '\n'.join(terminal.screen.display), '/thinking did not toggle thinking on'
                    assert len(LocalProvider.requests) == request_count, '/thinking sent a model request instead of changing display settings'
                    if terminal.screen is None:
                        profile['checks'].append('/thinking show, hide, and bare toggle are handled without sending model requests')
                        profile['checks'].append('rendered visibility assertions skipped because pyte is unavailable')
                    else:
                        profile['checks'].append('/thinking show, hide, and bare toggle update rendered transcript visibility without sending model requests')
                    terminal.send('/quit')
                    terminal.send('\r')
                    continue
                if args.markdown_only:
                    start = len(terminal.data)
                    terminal.send('verify-markdown\r')
                    terminal.wait('LOCAL_MARKDOWN_START', start, timeout=50)
                    if terminal.screen is not None:
                        terminal.assert_blank_line_before('verify-markdown', 'user bubble top padding')
                        terminal.assert_blank_line_after('verify-markdown', 'user bubble bottom padding')
                        terminal.assert_blank_rows_before(
                            'LOCAL_THINKING: inspect the real isolated fixture.', 2,
                            'one user bubble bottom-padding row and one inter-entry row before thinking'
                        )
                        terminal.assert_blank_rows_before(
                            'LOCAL_MARKDOWN_START', 1, 'one row between thinking and assistant'
                        )
                    terminal.wait('LOCAL_MARKDOWN_DONE', start, timeout=50)
                    terminal.read(0.4)
                    raw = bytes(terminal.data[start:])
                    visible = '\n'.join(terminal.screen.display) if terminal.screen is not None else normalized(raw)
                    captured = normalized(raw)
                    for phrase in ['Primary heading', 'Secondary heading', 'Harness docs', 'bold', 'italic', 'deleted',
                                   'inline code', 'const answer = 42', 'Quoted guidance', 'unordered item',
                                   'ordered item', 'complete', 'pending', 'Name', 'Value', 'Markdown', 'Alt text',
                                   'R0%', 'LOCAL_MARKDOWN_DONE']:
                        assert phrase in visible or phrase in captured, f'Markdown PTY output did not include {phrase!r}'
                    assert 'https://example.test/docs' not in visible and 'https://example.test/docs' not in captured, 'Markdown displayed the link destination instead of only its label'
                    assert 'https://example.test/image.png' not in visible and 'https://example.test/image.png' not in captured, 'Markdown displayed an image destination instead of only its alt text'
                    assert re.search(rb'\x1b\[[0-9;]*38;2;138;180;248(?:;[0-9]+)*m', raw), 'Markdown link color was not emitted as Harness blue'
                    terminal.snapshot('markdown-transcript')
                    if terminal.screen is not None:
                        terminal.assert_blank_line_after('Primary heading', 'H1 bottom spacing')
                        profile['checks'].append('one row of user-bubble top/bottom padding, one row between entries, and Markdown H1 spacing')
                    else:
                        profile['checks'].append('transcript spacing assertions skipped because pyte is unavailable')
                    if terminal.screen is not None:
                        link_x, link_y = terminal.locate('Harness docs')
                        terminal.move(link_x, link_y)
                        terminal.wait('Click to open link', start, timeout=10)
                        terminal.snapshot('markdown-link-hover')
                        terminal.move(1, 1)
                        terminal.read(0.2)
                        assert 'Click to open link' not in '\n'.join(terminal.screen.display), 'Markdown link hover hint remained after moving away'
                        profile['checks'].append('label-only Markdown links, PTY mouse hover hint, and hover hint clears after pointer leaves')
                    else:
                        profile['checks'].append('label-only Markdown links; PTY hover inspection skipped because optional pyte is unavailable')
                    profile['checks'].append('streamed Markdown, status-bar cache rate, code, quotes, lists, tables, dividers and image alt text')
                    continue
                if args.file_completion_only:
                    start = len(terminal.data)
                    terminal.send('inspect completion-fixture/al')
                    terminal.send('\t')
                    terminal.wait('completion-fixture/alpha.ts', start)
                    terminal.snapshot('file-completion-list')
                    accepted = len(terminal.data)
                    terminal.send('\r')
                    terminal.read(0.2)
                    visible = '\n'.join(terminal.screen.display) if terminal.screen is not None else normalized(terminal.data[accepted:])
                    assert ('inspect completion-fixture/alpha.ts' in visible if terminal.screen is not None else 'pha.ts' in visible), 'Enter did not insert the selected file path into the prompt'

                    terminal.send('\x03')
                    start = len(terminal.data)
                    terminal.send('inspect completion-fixture/ass')
                    terminal.send('\t')
                    terminal.wait('completion-fixture/assets/', start)
                    terminal.snapshot('folder-completion-list')
                    accepted = len(terminal.data)
                    terminal.send('\t')
                    terminal.read(0.2)
                    visible = '\n'.join(terminal.screen.display) if terminal.screen is not None else normalized(terminal.data[accepted:])
                    assert ('inspect completion-fixture/assets/' in visible if terminal.screen is not None else 'ets/' in visible), 'Tab did not insert the selected folder with a trailing slash'
                    profile['checks'].append('Tab opens matching file/folder suggestions; Enter and Tab insert the selected path')
                    terminal.send('\x03')
                    terminal.send('/quit')
                    terminal.send('\r')
                    continue
                if args.questions_only:
                    start = len(terminal.data)
                    terminal.send('verify-batch\r')
                    terminal.wait('Approve ask_user?', start)
                    terminal.send('\r')
                    terminal.wait('1 of 2', start)
                    color_start = len(terminal.data)
                    terminal.send('\r')
                    terminal.read(0.2)
                    color_output = bytes(terminal.data[color_start:])
                    assert has_truecolor_background(color_output, QUESTION_SELECTED_BG), 'Selected question choice did not emit the dark-green row background'
                    assert has_truecolor_background(color_output, QUESTION_ACTION_BG), 'Continue action did not emit its green button background'
                    terminal.snapshot('question-selected')
                    terminal.send('\r')
                    terminal.wait('Something else…', start)
                    terminal.send('\t')
                    terminal.send('PTY grouped reason')
                    terminal.snapshot('question-something-else')
                    terminal.send('\r')
                    terminal.wait('LOCAL_FINAL', start)
                    terminal.read(0.4)
                    batch_record = next(item for item in records(root) if item.get('goal') == 'verify-batch')
                    batch_answers = [event['payload'] for event in batch_record['_events'] if event['type'] == 'question.answered']
                    assert len(batch_answers) == 2 and batch_answers[0]['batchId'] == batch_answers[1]['batchId'], 'Grouped answers lost their actual batch identity'
                    assert batch_answers[0]['selected'] == ['Batch A'] and batch_answers[1]['text'] == 'PTY grouped reason', 'Choice-backed Something else answer was not persisted exactly'
                    profile['checks'].append('recommended choice selection row and Continue/Submit button use green backgrounds; Something else remains available')
                    terminal.send('/quit')
                    terminal.send('\r')
                    continue
                if args.history_only:
                    def wait_for_history_runs(goal, count, native_session_id):
                        deadline = time.monotonic() + 30
                        while time.monotonic() < deadline:
                            completed = [record for record in records(root)
                                         if record.get('goal') == goal and record.get('status') == 'completed']
                            if len(completed) >= count and all(record.get('nativeSessionId') == native_session_id for record in completed):
                                return completed
                            terminal.read(0.1)
                        raise AssertionError(f'{count} completed history runs for {goal!r} were not recorded in session {native_session_id!r}')

                    first_goal = 'verify-history-first-session'
                    terminal.send(first_goal)
                    terminal.send('\r')
                    first_record = wait_for_goal(terminal, root, first_goal)
                    assert first_record.get('status') == 'completed', 'Initial prompt-history turn did not complete'
                    first_session = first_record.get('nativeSessionId')
                    assert first_session and Path(first_session).is_file(), 'Initial prompt history did not retain its native session'

                    terminal.send('/new\r')
                    terminal.read(0.8)
                    second_goal = 'verify-history-second-session'
                    terminal.send('\x1b[A')
                    terminal.send(second_goal)
                    terminal.send('\r')
                    second_record = wait_for_goal(terminal, root, second_goal)
                    assert second_record.get('status') == 'completed', 'The new session did not accept a fresh prompt after Up'
                    second_session = second_record.get('nativeSessionId')
                    assert second_session and second_session != first_session, 'The new prompt was not recorded in a distinct native session'

                    terminal.read(0.3)
                    terminal.send('\x1b[A')
                    terminal.send('\r')
                    wait_for_history_runs(second_goal, 2, second_session)

                    terminal.send(f'/resume {first_session}\r')
                    terminal.read(1)
                    terminal.send('\x1b[A')
                    terminal.send('\r')
                    wait_for_history_runs(first_goal, 2, first_session)
                    profile['checks'].append('empty-composer Up recalls only the active session prompt across /new and /resume; session history is persisted natively')
                    terminal.send('/quit')
                    terminal.send('\r')
                    continue
                if args.attachments_only:
                    image = root / 'dropped shot.png'
                    image.write_bytes(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='))
                    paste = lambda text: terminal.send('\x1b[200~' + text + '\x1b[201~')
                    visible = lambda: '\n'.join(terminal.screen.display) if terminal.screen is not None else terminal.data.decode(errors='ignore')
                    start = len(terminal.data)
                    paste(str(image).replace(' ', '\\ '))
                    terminal.wait('[Image #1]', start, timeout=10)
                    terminal.read(0.3)
                    assert b'38;2;94;161;255' in terminal.data[start:], 'The image label was not drawn in the attachment colour'
                    profile['checks'].append('a dropped image path becomes a blue [Image #1] label')
                    lines = '\r'.join(f'PASTED_LINE_{number}' for number in range(5))
                    terminal.send('describe ')
                    start = len(terminal.data)
                    paste(lines)
                    terminal.wait('[Pasted text #2 +5 lines]', start, timeout=10)
                    terminal.read(0.3)
                    assert 'PASTED_LINE_' not in visible(), 'A large paste was drawn in the composer instead of collapsing'
                    terminal.send('\x1b\x7f')
                    terminal.read(0.4)
                    assert '[Pasted' not in visible() and '+5 lines' not in visible(), 'Alt+Backspace left part of the pasted-text label'
                    assert '[Image #1]' in visible(), 'Word delete removed more than the pasted-text label'
                    start = len(terminal.data)
                    paste(lines)
                    terminal.wait('[Pasted text #3 +5 lines]', start, timeout=10)
                    terminal.send('\x7f')
                    terminal.read(0.4)
                    assert '[Pasted' not in visible() and 'lines]' not in visible(), 'Backspace did not remove the whole pasted-text label'
                    profile['checks'].append('large pastes collapse to labels; Backspace and Alt+Backspace remove a whole label')
                    start = len(terminal.data)
                    paste(lines)
                    terminal.wait('[Pasted text #4 +5 lines]', start, timeout=10)
                    terminal.send(' verify-attachments')
                    terminal.snapshot('attachments-composer')
                    sent = len(LocalProvider.requests)
                    terminal.send('\r')
                    terminal.wait('completed.', start, timeout=30)
                    request = next(item for item in LocalProvider.requests[sent:] if 'verify-attachments' in item['user'])
                    assert request['images'] == 1, f'The model did not receive the image: {request!r}'
                    assert 'PASTED_LINE_4' in request['user'] and '[Pasted text' not in request['user'], 'The pasted text was not expanded for the model'
                    assert '[Image #1]' in request['user'], 'The image label did not reach the model'
                    profile['checks'].append('the model receives the image as content and the pasted text expanded')
                    terminal.snapshot('attachments-sent')
                    terminal.send('/quit')
                    terminal.send('\r')
                    continue
                if args.composer_only:
                    terminal.send('explicit-first')
                    terminal.send('\x1b[13;2u')
                    terminal.send('explicit-second')
                    terminal.send(' ' + 'wrap-token ' * 18)
                    terminal.read(0.2)
                    terminal.snapshot('composer-multiline')
                    assert_prompt_gutter(terminal, '❯', 'explicit-first', 'explicit-second', 'wrap-token', 'normal composer')
                    start = len(terminal.data)
                    terminal.send('\r')
                    terminal.wait('LOCAL_FINAL', start)
                    terminal.read(0.3)
                    terminal.send('!')
                    terminal.send('bash-first')
                    terminal.send('\x1b[13;2u')
                    terminal.send('bash-second')
                    terminal.send(' ' + 'bash-wrap ' * 18)
                    terminal.read(0.2)
                    terminal.snapshot('composer-bash-multiline')
                    assert_prompt_gutter(terminal, '!', 'bash-first', 'bash-second', 'bash-wrap', 'Bash composer')
                    profile['checks'].append('normal and Bash markers appear only on the first row across explicit newlines and soft wraps')
                    terminal.send('\x03')
                    terminal.read(0.2)
                    terminal.send('\x1b[Z')
                    terminal.read(0.2)
                    terminal.snapshot('composer-plan-mode')
                    if terminal.screen is not None:
                        display = '\n'.join(terminal.screen.display)
                        assert 'plan mode' in display and 'Describe a plan…' in display, f'Plan mode did not replace the normal composer: {terminal.screen.display!r}'
                    terminal.send('!')
                    terminal.read(0.2)
                    terminal.snapshot('composer-bash-from-plan')
                    if terminal.screen is not None:
                        display = '\n'.join(terminal.screen.display)
                        assert 'Run a shell command…' in display and 'plan mode' not in display, f'Bash mode did not replace plan mode: {terminal.screen.display!r}'
                    terminal.send('cmd')
                    terminal.read(0.1)
                    terminal.send('\x1b[Z')
                    terminal.read(0.2)
                    terminal.snapshot('composer-plan-from-bash')
                    if terminal.screen is not None:
                        display = '\n'.join(terminal.screen.display)
                        assert 'plan mode' in display and 'cmd' in display and 'Run a shell command…' not in display, f'Shift+Tab did not switch Bash to plan while preserving the draft: {terminal.screen.display!r}'
                    terminal.send('\x1b[Z')
                    terminal.read(0.2)
                    terminal.snapshot('composer-normal-mode')
                    if terminal.screen is not None:
                        display = '\n'.join(terminal.screen.display)
                        assert 'plan mode' not in display and 'Run a shell command…' not in display, f'Turning plan mode off did not restore normal mode: {terminal.screen.display!r}'
                    profile['checks'].append('plan, Bash and normal composer modes are exclusive; Shift+Tab preserves the draft when switching')
                    terminal.send('\x03')
                    terminal.read(0.1)
                    terminal.send('/quit')
                    terminal.send('\r')
                    continue
                if args.click_focus_only:
                    click_x = max(1, width // 2)
                    click_y = max(2, height // 3)
                    start = len(terminal.data)
                    terminal.click(click_x, click_y)
                    terminal.send('verify-click-home')
                    terminal.wait('verify-click-home', start)
                    terminal.send('\r')
                    assert wait_for_goal(terminal, root, 'verify-click-home').get('status') == 'completed', 'Clicking the empty chat did not send through the composer'
                    terminal.read(0.4)
                    start = len(terminal.data)
                    terminal.click(min(6, width - 1), min(5, height - 1))
                    terminal.send('verify-click-transcript')
                    terminal.wait('verify-click-transcript', start)
                    terminal.send('\x15')
                    start = len(terminal.data)
                    terminal.click(click_x, click_y)
                    terminal.send('verify-click-transcript-empty')
                    terminal.wait('verify-click-transcript-empty', start)
                    terminal.send('\x15')
                    profile['checks'].extend([
                        'clicking the empty chat focuses the composer',
                        'clicking transcript text focuses the composer',
                        'clicking empty transcript space focuses the composer'
                    ])
                    terminal.send('/quit')
                    terminal.send('\r')
                    continue
                click_x = max(1, width // 2)
                click_y = max(2, height // 3)
                start = len(terminal.data)
                terminal.click(click_x, click_y)
                terminal.send('verify-click-home')
                terminal.wait('verify-click-home', start)
                terminal.send('\r')
                assert wait_for_goal(terminal, root, 'verify-click-home').get('status') == 'completed', 'Clicking the empty chat did not send through the composer'
                profile['checks'].append('clicking the empty chat focuses the composer')
                start = len(terminal.data)
                terminal.click(min(6, width - 1), min(5, height - 1))
                terminal.send('verify-click-transcript')
                terminal.wait('verify-click-transcript', start)
                terminal.send('\x15')
                profile['checks'].append('clicking the transcript focuses the composer')
                start = len(terminal.data)
                terminal.send('/settings')
                terminal.send('\r')
                terminal.wait('Appearance', start)
                if terminal.screen is not None:
                    assert 'Appearance' in terminal.screen.display[0], f'/settings did not fill the screen: {terminal.screen.display!r}'
                    assert 'Esc close' in terminal.screen.display[-1], f'/settings full-screen footer was not visible: {terminal.screen.display!r}'
                terminal.send('\t\t')
                terminal.snapshot('settings-interaction')
                terminal.send('Keyboard')
                terminal.wait('Keyboard controls', start)
                terminal.snapshot('settings-keyboard')
                clear_start = len(terminal.data)
                terminal.send('\x1b')
                terminal.wait('Skill commands', clear_start)
                terminal.send('\x1b')
                terminal.wait('Reply…', start)
                profile['checks'].append('actual settings tabs, section focus, keyboard search/control and Escape return')
                start = len(terminal.data)
                terminal.send('/acc')
                terminal.send('\t')
                terminal.snapshot('completion')
                terminal.send('\r')
                terminal.type_text('Second')
                terminal.snapshot('accounts')
                terminal.send('\x1b')
                terminal.send('\t')
                terminal.wait('New pool', start)
                terminal.snapshot('accounts-pools')
                terminal.send('\x1b')
                terminal.read(0.2)
                start = len(terminal.data)
                terminal.send('/permissions\r')
                terminal.wait('Full Permission', start)
                terminal.snapshot('permissions')
                terminal.send('\t')
                terminal.wait('Tools', start)
                terminal.snapshot('permissions-tools')
                terminal.send('\x1b')
                terminal.read(0.2)
                start = len(terminal.data)
                terminal.send('/components\r')
                terminal.wait('Verifier skill', start)
                terminal.snapshot('components-skills')
                terminal.send('testing')
                terminal.read(0.2)
                terminal.snapshot('components-library-search')
                terminal.send('\x1b')
                terminal.send('\x1b')
                terminal.read(0.2)
                profile['checks'].append('command autocomplete, Accounts and Permissions pages, and unified Library browser')
                if os.name == 'posix':
                    terminal.send('\x1a')
                    terminal.read(0.4)
                    assert termios.tcgetattr(terminal.slave) == terminal.before, 'Suspend did not restore terminal attributes'
                    os.killpg(terminal.process.pid, signal.SIGCONT)
                    terminal.read(0.5)
                    assert termios.tcgetattr(terminal.slave) != terminal.before, 'Resume did not restore interactive raw mode'
                    start = len(terminal.data)
                    terminal.send('/accounts\r')
                    terminal.wait('Verifier First', start)
                    terminal.send('\x1b')
                    terminal.read(0.2)
                    profile['checks'].append('suspend/resume restores cooked/raw terminal modes and page command input')
                start = len(terminal.data)
                terminal.send('verify-flow Unicode 知識 🧠\r')
                terminal.wait('LOCAL_STAGE_0', start)
                approval_count = 0
                question_answered = False
                deadline = time.monotonic() + 45
                cursor = start
                while time.monotonic() < deadline:
                    terminal.read(0.1)
                    recent = '\n'.join(terminal.screen.display) if terminal.screen is not None else normalized(terminal.data[cursor:])
                    flow_runs = [item for item in records(root) if item.get('goal') == 'verify-flow Unicode 知識 🧠']
                    if flow_runs and flow_runs[-1].get('status') == 'completed':
                        break
                    if any(label in recent for label in ('Allow ', 'Approve ')) and '?' in recent:
                        terminal.snapshot(f'approval-{approval_count}')
                        terminal.send('\r')
                        approval_count += 1
                        cursor = len(terminal.data)
                    elif not question_answered and any(item.get('status') == 'waiting_for_input' for item in records(root)):
                        terminal.snapshot('question')
                        if terminal.screen is not None:
                            option_x, option_y = terminal.locate('Other')
                            original_background = terminal.screen.buffer[option_y - 1][option_x - 1].bg
                            terminal.move(option_x, option_y)
                            terminal.read(0.15)
                            hovered_x, hovered_y = terminal.locate('Other')
                            hovered_background = terminal.screen.buffer[hovered_y - 1][hovered_x - 1].bg
                            assert hovered_background != original_background, 'Hovering a question option did not highlight it'
                            selected_start = len(terminal.data)
                            terminal.click(hovered_x, hovered_y)
                            terminal.read(0.15)
                            selected_output = bytes(terminal.data[selected_start:])
                            assert has_truecolor_background(selected_output, QUESTION_SELECTED_BG), 'Selecting a question option did not render the dark-green row background'
                            assert has_truecolor_background(selected_output, QUESTION_ACTION_BG), 'Continue and Submit did not render a green button background'
                            terminal.click_text('Continue and Submit')
                            profile['checks'].append('question option hover highlight, dark-green selected row, and green Continue/Submit button')
                        else:
                            terminal.send('\r')
                            terminal.send('\r')
                        question_answered = True
                        cursor = len(terminal.data)
                flow_record = wait_for_goal(terminal, root, 'verify-flow Unicode 知識 🧠')
                terminal.read(0.5)
                assert approval_count >= 1, 'No real approval dialog was exercised'
                assert question_answered, 'No real question dialog was exercised'
                terminal.snapshot('completed-transcript')
                start = len(terminal.data)
                terminal.click(max(1, width - 2), click_y)
                terminal.send('verify-click-transcript-empty')
                terminal.wait('verify-click-transcript-empty', start)
                terminal.send('\x15')
                profile['checks'].append('clicking empty transcript space focuses the composer')
                terminal.send('\x0f')
                terminal.snapshot('expanded-tools')
                terminal.resize(80 if width != 80 else 120, 30)
                terminal.send('\x1b[5~')
                terminal.snapshot('resized-scrollback')
                terminal.send('\x1b[6~')
                profile['checks'].append('Unicode, real streaming/thinking/read/bash/approval/question, expansion, resizing and scrolling')
                current = records(root)
                completed = [record for record in current if record.get('status') == 'completed' and 'verify-flow' in str(record.get('goal'))]
                assert completed, f'No completed real run record: {[(record.get("goal"), record.get("status")) for record in current]}'
                record = completed[-1]
                assert 'Unicode 知識 🧠' in str(record.get('goal')), 'Unicode input did not survive the real composer'
                events = record['_events']
                event_types = [event['type'] for event in events]
                for required in ['approval.requested', 'approval.resolved', 'question.requested', 'question.answered', 'tool.completed', 'usage.updated', 'completed']:
                    assert required in event_types, f'Missing persisted {required}: {event_types}'
                names = {event['payload'].get('name') for event in events if event['type'] == 'tool.completed' and event['payload'].get('ok')}
                assert {'read', 'bash', 'ask_user_question'} <= names, f'Real tools did not all succeed: {names}'
                expected_choice = 'Other' if terminal.screen is not None else 'Verified'
                assert any(event['type'] == 'question.answered' and event['payload'].get('selected') == [expected_choice] for event in events), 'Actual question answer was not persisted'
                native = record.get('nativeSessionId')
                assert native and Path(native).is_file(), 'Run did not retain its real native history'
                native_text = Path(native).read_text()
                assert 'LOCAL_FILE_CONTENT' in native_text and 'LOCAL_BASH_EXECUTED' in native_text, 'Native history lacks real tool outputs'
                start = len(terminal.data)
                terminal.send('\x1b[Z')
                terminal.read(0.3)
                terminal.send('verify-plan Unicode 知識\r')
                terminal.wait('Plan ready', start)
                terminal.read(0.5)
                terminal.snapshot('plan-choice')
                plan_view = normalized(terminal.data[start:])
                assert 'LOCAL_PLAN' in plan_view and 'Implement "Verified plan"' in plan_view, 'Plan reply did not offer the choice'
                terminal.send('\x1b[B')
                terminal.read(0.2)
                terminal.send('\r')
                terminal.wait('Describe what to change', start)
                terminal.read(0.3)
                start = len(terminal.data)
                terminal.send('verify-plan revise\r')
                terminal.wait('Plan ready', start)
                terminal.read(0.5)
                terminal.snapshot('plan-revised')
                start = len(terminal.data)
                terminal.send('\r')
                terminal.wait('LOCAL_IMPLEMENTED', start)
                terminal.read(0.5)
                terminal.snapshot('plan-implemented')
                assert 'Implement the plan: Verified plan' in normalized(terminal.data[start:]), 'Implement did not send the plan prompt'
                plan_runs = [record for record in records(root) if 'verify-plan' in str(record.get('goal'))]
                assert len(plan_runs) >= 2 and all(record.get('status') == 'completed' for record in plan_runs[-2:]), f'Plan runs were not recorded as completed: {[(record.get("goal"), record.get("status")) for record in plan_runs]}'
                plan_requests = [item for item in LocalProvider.requests if 'verify-plan' in item.get('user', '')]
                implement_requests = [item for item in LocalProvider.requests if 'Implement the plan' in item.get('user', '')]
                assert plan_requests and implement_requests, 'Provider did not see the plan and implement prompts'
                assert 'bash' not in plan_requests[-1]['tools'] and 'bash' in implement_requests[-1]['tools'], 'Plan run did not stay read-only, or Implement did not restore normal tools'
                profile['checks'].append('plan mode: plan card and choice block, Edit revises, Implement restores normal tools')
                start = len(terminal.data)
                terminal.send('/verify-plugin\r')
                terminal.wait('PLUGIN_CUSTOM_UI', start)
                terminal.snapshot('plugin-light')
                terminal.send('\r')
                terminal.wait('PLUGIN_CUSTOM_DONE: accepted', start)
                profile['checks'].append('trusted plugin custom overlay, widget, status and disposal')
                start = len(terminal.data)
                terminal.send('verify-batch\r')
                terminal.wait('Approve ask_user?', start)
                terminal.send('\r')
                terminal.wait('1 of 2', start)
                terminal.send('\r')
                terminal.send('\r')
                terminal.wait('Something else…', start)
                terminal.snapshot('question-batch')
                if terminal.screen is not None:
                    terminal.click_text('Something else…')
                    terminal.send('PTY grouped reason')
                    terminal.read(0.2)
                    assert 'PTY grouped reason' in '\n'.join(terminal.screen.display), 'Question answer typing did not reach its editor'
                    terminal.send('\r')
                else:
                    terminal.send('\tPTY grouped reason\r')
                terminal.wait('LOCAL_FINAL', start)
                terminal.read(0.4)
                batch_record = next(item for item in records(root) if item.get('goal') == 'verify-batch')
                batch_answers = [event['payload'] for event in batch_record['_events'] if event['type'] == 'question.answered']
                assert len(batch_answers) == 2 and batch_answers[0]['batchId'] == batch_answers[1]['batchId'], 'Grouped answers lost their actual batch identity'
                assert batch_answers[0]['selected'] == ['Batch A'] and batch_answers[1]['text'] == 'PTY grouped reason', 'Grouped answers were not persisted exactly'
                profile['checks'].append('grouped question progress and atomic choice/text answers through real registry')
                for scenario, decision in [('verify-deny', '\x1b[B\x1b[B\r'), ('verify-approval-cancel', '\x1b')]:
                    start = len(terminal.data)
                    terminal.send(scenario + '\r')
                    terminal.wait('Approve bash?', start)
                    terminal.send(decision)
                    terminal.wait('LOCAL_FINAL', start)
                    terminal.read(0.4)
                    denied = next(item for item in records(root) if item.get('goal') == scenario)
                    assert any(event['type'] == 'approval.resolved' and event['payload'].get('decision') == 'denied' for event in denied['_events']), 'Denial was not persisted'
                    assert not (root / 'decision-must-not-execute.txt').exists(), 'A denied tool executed'
                profile['checks'].append('approval deny and Escape cancellation prevent actual tool execution')
                start = len(terminal.data)
                terminal.send('verify-question-cancel\r')
                terminal.wait('Approve ask_user_question?', start)
                terminal.send('\r')
                terminal.wait('LOCAL_CANCEL_QUESTION', start)
                terminal.send('\x1b')
                terminal.read(1)
                cancelled = [item for item in records(root) if item.get('goal') == 'verify-question-cancel']
                assert cancelled and cancelled[-1]['status'] == 'interrupted', 'Question cancellation did not interrupt the real run'
                profile['checks'].append('question Escape cancellation settles pending tools and interrupts run')
                terminal.send('/new\r')
                terminal.read(0.8)
                terminal.send(f'/resume {native}\r')
                terminal.read(1)
                terminal.snapshot('resumed')
                terminal.send('/name PTY verified 知識\r')
                terminal.read(0.4)
                profile['checks'].append('new session, explicit scoped resume and session naming')
                start = len(terminal.data)
                terminal.send('verify-cancel\r')
                terminal.wait('CANCEL_STREAM_', start)
                terminal.send('\x1b')
                terminal.read(1)
                terminal.snapshot('cancelled')
                assert any(record.get('status') == 'interrupted' and 'verify-cancel' in str(record.get('goal')) for record in records(root)), 'Cancellation was not persisted as interrupted'
                profile['checks'].append('actual Escape stream cancellation and interrupted run record')
                start = len(terminal.data)
                terminal.send('verify-stop\r')
                terminal.wait('CANCEL_STREAM_', start)
                terminal.send('/stop\r')
                terminal.read(0.8)
                terminal.snapshot('stopped-command')
                stopped = [record for record in records(root) if 'verify-stop' in str(record.get('goal'))]
                assert stopped and stopped[-1]['status'] == 'interrupted', 'The /stop command did not interrupt and persist the active run'
                profile['checks'].append('/stop interrupts the live stream and records an interrupted run')
                start = len(terminal.data)
                terminal.send('/accounts\r')
                terminal.wait('Accounts', start)
                terminal.type_text('Second')
                terminal.send('\r')
                terminal.wait('Use for this session', start)
                terminal.send('\r')
                terminal.wait("terminal's Pi process", start)
                terminal.send('\r')
                marker = 'Switching this session to account Verifier Second.'
                terminal.wait(marker, start, timeout=40)
                restarted = terminal.data.index(marker.encode(), start) + len(marker.encode())
                terminal.wait('Reply…', restarted, timeout=40)
                terminal.read(0.5)
                terminal.snapshot('account-switched')
                start = len(terminal.data)
                terminal.send('verify-after-switch\r')
                terminal.wait('LOCAL_FINAL', start)
                terminal.read(0.6)
                switched = [item for item in records(root) if 'verify-after-switch' in str(item.get('goal'))]
                assert switched and switched[-1].get('status') == 'completed', 'Switched account did not complete a real run'
                assert switched[-1].get('accountId') != record.get('accountId'), 'Account switch did not change the pinned account'
                profile['checks'].append('explicit account switching, process restart and real run on newly pinned account')
                profile['persistedRunCount'] = len(records(root))
            except Exception as error:
                profile['error'] = str(error)
                terminal.snapshot('failure')
                raise
            finally:
                profile.update(terminal.close())
                assert profile['exitCode'] == 0 or 'error' in profile, f'Frontend exited {profile["exitCode"]}'
                assert profile['termiosRestored'] or 'error' in profile, 'Frontend did not restore terminal attributes'
                assert (profile['bracketedPasteDisabled'] and profile['cursorShown']) or 'error' in profile, 'Frontend did not restore paste/cursor modes'
            fatal_output = root / 'fatal'
            fatal_output.mkdir()
            fatal = Terminal(['node', str(cli), '--state', str(root / 'state'), '--data', str(root / 'data')], root, width, height, fatal_output)
            try:
                fatal.wait('Verifier First', timeout=50)
                fatal.send('/verify-plugin-fatal\r')
                fatal.wait('PLUGIN_FATAL_FIXTURE')
            finally:
                cleanup = fatal.close()
            assert cleanup['exitCode'] == 1 and cleanup['termiosRestored'] and cleanup['bracketedPasteDisabled'] and cleanup['cursorShown'], f'Fatal cleanup failed: {cleanup}'
            profile['fatalCleanup'] = {key: value for key, value in cleanup.items() if key != 'snapshots'}
            profile['checks'].append('fatal asynchronous plugin failure exits 1 and restores terminal modes')
            startup_fixture = extensions / 'startup-failure.js'
            startup_fixture.write_text("throw new Error('STARTUP_FAILURE_FIXTURE'); export default function() {}")
            startup_output = root / 'startup-failure'
            startup_output.mkdir()
            startup = Terminal(['node', str(cli), '--state', str(root / 'state'), '--data', str(root / 'data')], root, width, height, startup_output)
            try:
                startup.wait('STARTUP_FAILURE_FIXTURE', timeout=50)
            finally:
                try:
                    startup_cleanup = startup.close()
                finally:
                    startup_fixture.unlink()
            assert startup_cleanup['exitCode'] == 1 and startup_cleanup['termiosRestored'] and startup_cleanup['bracketedPasteDisabled'] and startup_cleanup['cursorShown'], f'Startup cleanup failed: {startup_cleanup}'
            profile['startupCleanup'] = {key: value for key, value in startup_cleanup.items() if key != 'snapshots'}
            profile['checks'].append('plugin startup failure exits 1 and restores terminal modes')
            print(f'PASS {dimensions}: {len(profile["checks"])} interaction groups; tty restored', flush=True)
        report['passed'] = True
    except Exception as error:
        report['passed'] = False
        report['error'] = str(error)
        print(f'FAIL: {error}', flush=True)
    finally:
        server.shutdown()
        report['requests'] = LocalProvider.requests
        (output / 'report.json').write_text(json.dumps(report, indent=2, ensure_ascii=False))
        if args.save_evidence:
            save_evidence(report, output, args.save_evidence.resolve())
    return 0 if report.get('passed') else 1


if __name__ == '__main__':
    raise SystemExit(main())
