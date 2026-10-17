#!/usr/bin/env python3
"""Exercise the production Harness terminal and Pi SDK against a loopback SSE provider.

This is a transport fixture, not an AgentSession replacement. Every request goes through
Pi model selection, request streaming, real native tools, the Harness gate/socket, actual
terminal input, and the production run writer. No user credentials or private profiles load.
Run `npm run build` first, then `python3 scripts/verify-terminal.py`.
The report and raw PTY captures are retained in the printed disposable output directory.
"""
import argparse
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
ANSI = re.compile(r'\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][A-Z0-9]|\x1b[=>]')


def normalized(value):
    return ANSI.sub('', value.decode('utf-8', errors='replace') if isinstance(value, (bytes, bytearray)) else value)


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
                ('ask_user_question', {'question': 'LOCAL_QUESTION: choose the actual option', 'options': [{'label': 'Verified', 'description': 'Exercise the real question bridge'}, {'label': 'Other'}]})]
        elif 'verify-batch' in user:
            sequence = [('ask_user', {'questions': [
                {'summary': 'Batch choice', 'question': 'LOCAL_BATCH_CHOICE', 'options': [{'label': 'Batch A', 'description': 'First batch answer'}]},
                {'summary': 'Batch reason', 'question': 'LOCAL_BATCH_REASON'}]})]
        elif 'verify-deny' in user or 'verify-approval-cancel' in user:
            sequence = [('bash', {'command': "printf 'blocked' > decision-must-not-execute.txt"})]
        elif 'verify-question-cancel' in user:
            sequence = [('ask_user_question', {'question': 'LOCAL_CANCEL_QUESTION', 'options': [{'label': 'Continue'}]})]
        LocalProvider.requests.append({'at': time.time(), 'path': self.path, 'user': user, 'toolResults': index})
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
            if 'verify-cancel' in user:
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
                for text in ['LOCAL_FINAL: ', 'real SDK ', 'and terminal ', 'completed. ', 'Unicode 知識 🧠.\n']:
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

    def wait(self, needle, start=0, timeout=35):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.read(0.08)
            if needle in normalized(self.data[start:]):
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


def save_evidence(report, source, destination):
    """Keep bounded replayable evidence, without copying disposable runtime/account data."""
    destination.mkdir(parents=True, exist_ok=True)
    wanted = {'40x20': ['welcome', 'settings-interaction', 'settings-keyboard'],
              '80x24': ['approval-0', 'question', 'plugin-light', 'question-batch'], '120x40': ['completed-transcript']}
    captures = []
    for profile in report['profiles']:
        for snapshot in profile.get('snapshots', []):
            if snapshot['name'] not in wanted.get(profile['size'], []):
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
               'cli': report['cli'], 'cliSha256': report['cliSha256'], 'verifierSha256': report['verifierSha256'],
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
    parser.add_argument('--sizes', default='40x20,80x24,120x40')
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
              'verifierSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'profiles': []}
    print(f'Isolated terminal evidence: {output}', flush=True)
    try:
        for dimensions in args.sizes.split(','):
            width, height = map(int, dimensions.split('x'))
            root = output / dimensions
            root.mkdir()
            (root / 'fixture.txt').write_text('LOCAL_FILE_CONTENT: real read tool executed. 知識 🧠\n')
            LocalProvider.root = root
            shared = root / 'state' / 'accounts' / '_shared' / 'pi'
            shared.mkdir(parents=True)
            (shared / 'models.json').write_text(json.dumps({'providers': {'terminal-local': {
                'baseUrl': report['provider'] + '/v1', 'api': 'openai-completions', 'apiKey': 'isolated-loopback-fixture',
                'compat': {'supportsDeveloperRole': False, 'supportsReasoningEffort': False, 'supportsStore': False},
                'models': [{'id': 'terminal-verifier', 'name': 'Local terminal verifier', 'reasoning': True,
                            'input': ['text'], 'contextWindow': 32768, 'maxTokens': 2048,
                            'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}}]}}}))
            (shared / 'settings.json').write_text(json.dumps({'defaultProvider': 'terminal-local', 'defaultModel': 'terminal-verifier',
                                                              'defaultThinkingLevel': 'medium', 'enableAnalytics': False}))
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
            }''')
            rpc_accounts(cli, root)
            terminal = Terminal(['node', str(cli), '--state', str(root / 'state'), '--data', str(root / 'data')], root, width, height, root)
            profile = {'size': dimensions, 'checks': []}
            report['profiles'].append(profile)
            try:
                terminal.wait('Local terminal verifier', timeout=50)
                terminal.snapshot('welcome')
                profile['checks'].append('welcome and real configured model')
                start = len(terminal.data)
                terminal.send('/settings\r')
                terminal.wait('Settings', start)
                terminal.send('\x1b[C\x1b[C')
                terminal.send('\t')
                terminal.snapshot('settings-interaction')
                terminal.send('Keyboard')
                terminal.wait('Keyboard controls', start)
                terminal.snapshot('settings-keyboard')
                terminal.send('\t\r')
                terminal.read(0.3)
                terminal.send('\x1b')
                terminal.wait('escape: interrupt', start)
                profile['checks'].append('actual settings tabs, section focus, keyboard search/control and Escape return')
                start = len(terminal.data)
                terminal.send('/acc')
                terminal.send('\t')
                terminal.snapshot('completion')
                terminal.send('\r')
                terminal.read(0.3)
                if 'Verifier Second' not in normalized(terminal.data[start:]):
                    terminal.send('\r')
                terminal.wait('Verifier Second', start)
                terminal.snapshot('accounts')
                terminal.send('\x1b')
                terminal.read(0.2)
                profile['checks'].append('command autocomplete and real accounts selector')
                if os.name == 'posix':
                    terminal.send('\x1a')
                    terminal.read(0.4)
                    assert termios.tcgetattr(terminal.slave) == terminal.before, 'Suspend did not restore terminal attributes'
                    os.killpg(terminal.process.pid, signal.SIGCONT)
                    terminal.read(0.5)
                    assert termios.tcgetattr(terminal.slave) != terminal.before, 'Resume did not restore interactive raw mode'
                    start = len(terminal.data)
                    terminal.send('/help\r')
                    terminal.wait('Available terminal commands', start)
                    profile['checks'].append('suspend/resume restores cooked/raw terminal modes and command input')
                start = len(terminal.data)
                terminal.send('verify-flow Unicode 知識 🧠\r')
                terminal.wait('LOCAL_STAGE_0', start)
                approval_count = 0
                question_answered = False
                deadline = time.monotonic() + 45
                cursor = start
                while time.monotonic() < deadline:
                    terminal.read(0.1)
                    recent = normalized(terminal.data[cursor:])
                    if 'LOCAL_FINAL' in recent:
                        break
                    if 'Allow ' in recent and '?' in recent:
                        terminal.snapshot(f'approval-{approval_count}')
                        terminal.send('\r')
                        approval_count += 1
                        cursor = len(terminal.data)
                    elif not question_answered and any(item.get('status') == 'waiting_for_input' for item in records(root)):
                        terminal.snapshot('question')
                        terminal.send('\r')
                        question_answered = True
                        cursor = len(terminal.data)
                terminal.wait('LOCAL_FINAL', start)
                terminal.read(0.5)
                assert approval_count >= 1, 'No real approval dialog was exercised'
                assert question_answered, 'No real question dialog was exercised'
                terminal.snapshot('completed-transcript')
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
                assert any(event['type'] == 'question.answered' and event['payload'].get('selected') == ['Verified'] for event in events), 'Actual question answer was not persisted'
                native = record.get('nativeSessionId')
                assert native and Path(native).is_file(), 'Run did not retain its real native history'
                native_text = Path(native).read_text()
                assert 'LOCAL_FILE_CONTENT' in native_text and 'LOCAL_BASH_EXECUTED' in native_text, 'Native history lacks real tool outputs'
                start = len(terminal.data)
                terminal.send('/verify-plugin\r')
                terminal.wait('PLUGIN_CUSTOM_UI', start)
                terminal.snapshot('plugin-light')
                terminal.send('\r')
                terminal.wait('PLUGIN_CUSTOM_DONE: accepted', start)
                profile['checks'].append('trusted plugin custom overlay, widget, status and disposal')
                start = len(terminal.data)
                terminal.send('verify-batch\r')
                terminal.wait('Allow ask_user?', start)
                terminal.send('\r')
                terminal.wait('1 of 2', start)
                terminal.send('\r')
                terminal.wait('2 of 2', start)
                terminal.snapshot('question-batch')
                terminal.send('PTY grouped reason\r')
                terminal.wait('LOCAL_FINAL', start)
                terminal.read(0.4)
                batch_record = next(item for item in records(root) if item.get('goal') == 'verify-batch')
                batch_answers = [event['payload'] for event in batch_record['_events'] if event['type'] == 'question.answered']
                assert len(batch_answers) == 2 and batch_answers[0]['batchId'] == batch_answers[1]['batchId'], 'Grouped answers lost their actual batch identity'
                assert batch_answers[0]['selected'] == ['Batch A'] and batch_answers[1]['text'] == 'PTY grouped reason', 'Grouped answers were not persisted exactly'
                profile['checks'].append('grouped question progress and atomic choice/text answers through real registry')
                for scenario, decision in [('verify-deny', '\x1b[B\r'), ('verify-approval-cancel', '\x1b')]:
                    start = len(terminal.data)
                    terminal.send(scenario + '\r')
                    terminal.wait('Allow bash?', start)
                    terminal.send(decision)
                    terminal.wait('LOCAL_FINAL', start)
                    terminal.read(0.4)
                    denied = next(item for item in records(root) if item.get('goal') == scenario)
                    assert any(event['type'] == 'approval.resolved' and event['payload'].get('decision') == 'denied' for event in denied['_events']), 'Denial was not persisted'
                    assert not (root / 'decision-must-not-execute.txt').exists(), 'A denied tool executed'
                profile['checks'].append('approval deny and Escape cancellation prevent actual tool execution')
                start = len(terminal.data)
                terminal.send('verify-question-cancel\r')
                terminal.wait('Allow ask_user_question?', start)
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
                profile['checks'].append('actual stream cancellation and interrupted run record')
                start = len(terminal.data)
                terminal.send('/accounts\r')
                terminal.wait('Verifier Second', start)
                terminal.send('\x1b[B\r')
                terminal.wait('Use for this session', start)
                terminal.send('\r')
                terminal.wait('Switch this session?', start)
                terminal.send('\r')
                marker = 'Switching this session to account Verifier Second.'
                terminal.wait(marker, start, timeout=40)
                restarted = terminal.data.index(marker.encode(), start) + len(marker.encode())
                terminal.wait('Local terminal verifier', restarted, timeout=40)
                terminal.read(0.2)
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
                fatal.wait('Local terminal verifier', timeout=50)
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
