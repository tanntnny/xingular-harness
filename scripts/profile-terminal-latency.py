#!/usr/bin/env python3
"""Measure keystroke-to-screen latency of the Harness terminal, opencode and pure Pi.

Each target runs in a real PTY. Keys are written at a fixed human-fast interval and a pyte
virtual screen records when each typed prefix first becomes visible. A loopback
OpenAI-compatible server feeds every target the same deterministic replies. Credentialed
runs are restricted to one Xingular stream using its existing account.

Scenarios:
  idle     fresh session, nothing running
  history  after a ~240-message tool loop has finished (transcript length cost)
  stream   while a reply streams at a regular cadence
  burst    while a reply arrives in short bursts with pauses
  question Harness-only typing while a plan-mode ask_user waits above the composer

Run `npm run build` first. Fixture runs use isolated temporary profiles and a local
OpenAI-compatible provider; the Xingular-only `--real` mode uses its existing account. Example:
  python3 scripts/profile-terminal-latency.py --targets xingular,pi,opencode --repeats 5 --output /tmp/lat
"""
import argparse
import errno
import fcntl
import http.server
import json
import os
from pathlib import Path
import platform
import pty
import random
import select
import shutil
import signal
import statistics
import struct
import subprocess
import tempfile
import termios
import threading
import time

import pyte

REPOSITORY = Path(__file__).resolve().parent.parent
TYPED = 'zqxjkvwy'  # Never produced by the loopback replies, so a match is the typed text.
FILLER = ('the agent reads each file and then plans a change . it runs the tests and reports '
          'one result per line . nothing else is done here . the harness records the run and '
          'its tool calls so that a person can follow the trail later . ').split(' ')
HISTORY_TURNS = 80
DEFAULT_STREAM_SECONDS = 30


def filler_words(count, rng):
    return ' '.join(rng.choice(FILLER) for _ in range(count))


def user_text(messages):
    for message in reversed(messages):
        if message.get('role') != 'user':
            continue
        content = message.get('content')
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return ' '.join(str(part.get('text', '')) for part in content if isinstance(part, dict))
    return ''


class Provider(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    fixture = None
    requests = 0
    stream_seconds = DEFAULT_STREAM_SECONDS

    def log_message(self, *args):
        pass

    def do_GET(self):
        body = json.dumps({'object': 'list', 'data': [{'id': 'latency-model', 'object': 'model'}]}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        Provider.requests += 1
        messages = request.get('messages', [])
        text = user_text(messages)
        last_user = max((i for i, m in enumerate(messages) if m.get('role') == 'user'), default=-1)
        tool_results = sum(1 for m in messages[last_user + 1:] if m.get('role') == 'tool')
        tools = {t.get('function', {}).get('name'): t.get('function', {}) for t in request.get('tools', [])}
        rng = random.Random(Provider.requests)
        streaming = request.get('stream', True)
        if not streaming:
            body = json.dumps({'id': 'l', 'object': 'chat.completion', 'created': int(time.time()), 'model': 'latency-model',
                               'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': 'Latency title'}, 'finish_reason': 'stop'}],
                               'usage': {'prompt_tokens': 10, 'completion_tokens': 2, 'total_tokens': 12}}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Connection', 'close')
        self.end_headers()

        def chunk(delta=None, finish=None, usage=None):
            value = {'id': 'latency', 'object': 'chat.completion.chunk', 'created': int(time.time()), 'model': 'latency-model',
                     'choices': [{'index': 0, 'delta': delta or {}, 'finish_reason': finish}]}
            if usage:
                value['usage'] = usage
            self.wfile.write(('data: ' + json.dumps(value) + '\n\n').encode())
            self.wfile.flush()

        def done(finish='stop'):
            chunk(finish=finish, usage={'prompt_tokens': 1000 + len(messages), 'completion_tokens': 50, 'total_tokens': 1050 + len(messages)})
            self.wfile.write(b'data: [DONE]\n\n')
            self.wfile.flush()

        try:
            chunk({'role': 'assistant'})
            if not tools:
                chunk({'content': 'Latency title'})
                done()
                return
            if 'latency-history' in text and tool_results < HISTORY_TURNS and 'read' in tools:
                properties = tools['read'].get('parameters', {}).get('properties', {})
                key = next((name for name in ['filePath', 'path', 'file_path'] if name in properties), 'path')
                chunk({'content': f'step {tool_results} . {filler_words(30, rng)}\n'})
                chunk({'tool_calls': [{'index': 0, 'id': f'call_{tool_results}', 'type': 'function',
                                       'function': {'name': 'read', 'arguments': json.dumps({key: str(Provider.fixture)})}}]})
                done('tool_calls')
                return
            if 'latency-question' in text and tool_results == 0 and 'ask_user' in tools:
                chunk({'content': 'one question first .\n'})
                arguments = {'questions': [{'summary': 'Pick one', 'question': 'Which path should the run take',
                                            'options': [{'label': 'First', 'description': 'the first path'}, {'label': 'Second', 'description': 'the second path'}]}]}
                chunk({'tool_calls': [{'index': 0, 'id': 'call_question', 'type': 'function',
                                       'function': {'name': 'ask_user', 'arguments': json.dumps(arguments)}}]})
                done('tool_calls')
                return
            if 'latency-stream' in text or 'latency-burst' in text:
                chunk({'reasoning_content': filler_words(40, rng)})
                deadline = time.monotonic() + Provider.stream_seconds
                line = 0
                bursting = 'latency-burst' in text
                while time.monotonic() < deadline:
                    count = 18 if bursting else 1
                    for _ in range(count):
                        if time.monotonic() >= deadline:
                            break
                        line += 1
                        if line % 25 == 1:
                            chunk({'content': f'\n## section {line // 25 + 1}\n\n'})
                        elif line % 25 == 12:
                            chunk({'content': '\n```\nconst result = run ( task )\n```\n'})
                        else:
                            chunk({'content': f'- {filler_words(3, rng)}' + ('\n' if line % 4 == 0 else ' ')})
                    time.sleep(0.3 if bursting else 1 / 60)
                done()
                return
            chunk({'content': 'finished . ' + filler_words(20, rng)})
            done()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            self.close_connection = True


class Terminal:
    def __init__(self, command, cwd, env, width, height):
        self.started_at = time.monotonic()
        self.first_output_at = None
        self.first_visible_at = None
        self.last_output_at = None
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', height, width, 0, 0))
        self.screen = pyte.Screen(width, height)
        self.stream = pyte.ByteStream(self.screen)
        self.bytes = 0

        def control_terminal():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)
        self.process = subprocess.Popen(command, cwd=cwd, env=env, stdin=slave, stdout=slave, stderr=slave,
                                        preexec_fn=control_terminal, close_fds=True)
        os.close(slave)

    def pump(self, timeout=0.0):
        ready, _, _ = select.select([self.master], [], [], timeout)
        if not ready:
            return False
        try:
            part = os.read(self.master, 1 << 17)
        except OSError as error:
            if error.errno == errno.EIO:
                return False
            raise
        if not part:
            return False
        self.bytes += len(part)
        now = time.monotonic()
        self.first_output_at = self.first_output_at or now
        self.last_output_at = now
        # Answer the terminal queries a real emulator would, so startup does not wait on timeouts.
        for query, reply in [(b'\x1b[6n', b'\x1b[1;1R'), (b'\x1b[c', b'\x1b[?1;2c'), (b'\x1b[?u', b'\x1b[?0u')]:
            if query in part:
                try:
                    os.write(self.master, reply)
                except OSError:
                    pass
        try:
            self.stream.feed(part)
            if self.first_visible_at is None and any(line.strip() for line in self.screen.display):
                self.first_visible_at = time.monotonic()
        except Exception:
            pass
        return True

    def wait_for_initial_screen(self, quiet=0.75, timeout=60):
        deadline = self.started_at + timeout
        while time.monotonic() < deadline:
            self.pump(0.05)
            now = time.monotonic()
            if self.first_visible_at is not None and self.last_output_at is not None and now - self.last_output_at >= quiet:
                return {
                    'launchToFirstOutputMs': round((self.first_output_at - self.started_at) * 1000, 2),
                    'launchToFirstVisibleMs': round((self.first_visible_at - self.started_at) * 1000, 2),
                    'launchToQuietScreenMs': round((now - self.started_at) * 1000, 2)
                }
            if self.process.poll() is not None:
                break
        raise AssertionError(f'Terminal did not reach a visible, quiet screen; exit={self.process.poll()}\n{self.text()}')

    def read(self, seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.pump(max(0.0, min(0.02, deadline - time.monotonic())))

    def text(self):
        return '\n'.join(self.screen.display)

    def flat(self):
        return ''.join(line.rstrip() for line in self.screen.display)

    def wait(self, needle, timeout=60):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.pump(0.05)
            if needle in self.text():
                return True
            if self.process.poll() is not None:
                break
        raise AssertionError(f'Screen never showed {needle!r}; exit={self.process.poll()}\n{self.text()}')

    def settle(self, quiet=1.0, timeout=30):
        deadline = time.monotonic() + timeout
        last = time.monotonic()
        while time.monotonic() < deadline:
            if self.pump(0.05):
                last = time.monotonic()
            elif time.monotonic() - last > quiet:
                return

    def send(self, data):
        os.write(self.master, data.encode() if isinstance(data, str) else data)

    def cpu_seconds(self):
        """CPU time of the whole process tree, from ps."""
        out = subprocess.run(['ps', '-A', '-o', 'pid=,ppid=,time='], capture_output=True, text=True).stdout
        children, times = {}, {}
        for line in out.splitlines():
            pid, ppid, cpu = line.split(None, 2)
            children.setdefault(int(ppid), []).append(int(pid))
            parts = cpu.strip().replace('-', ':').split(':')
            seconds = 0.0
            for part in parts:
                seconds = seconds * 60 + float(part)
            times[int(pid)] = seconds
        total, stack = 0.0, [self.process.pid]
        while stack:
            pid = stack.pop()
            total += times.get(pid, 0.0)
            stack.extend(children.get(pid, []))
        return total

    def rss_kb(self):
        """Resident set size in KiB for the whole process tree."""
        out = subprocess.run(['ps', '-A', '-o', 'pid=,ppid=,rss='], capture_output=True, text=True).stdout
        children, rss = {}, {}
        for line in out.splitlines():
            pid, ppid, size = line.split(None, 2)
            children.setdefault(int(ppid), []).append(int(pid))
            rss[int(pid)] = int(size)
        total, stack = 0, [self.process.pid]
        while stack:
            pid = stack.pop()
            total += rss.get(pid, 0)
            stack.extend(children.get(pid, []))
        return total

    def close(self):
        if self.process.poll() is None:
            try:
                os.killpg(self.process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            deadline = time.monotonic() + 5
            while self.process.poll() is None and time.monotonic() < deadline:
                self.pump(0.05)
            if self.process.poll() is None:
                os.killpg(self.process.pid, signal.SIGKILL)
                self.process.wait(5)
        os.close(self.master)


def percentile(values, p):
    if not values:
        return None
    ordered = sorted(values)
    return round(ordered[min(len(ordered) - 1, max(0, int(round(p / 100 * len(ordered) + 0.5)) - 1))], 2)


def type_rounds(terminal, rounds, length, interval, rng, timeout=3.0):
    """Type `rounds` strings; return per-key latency in ms (None when never seen within timeout)."""
    latencies = []
    cpu_before, rss_before, bytes_before = terminal.cpu_seconds(), terminal.rss_kb(), terminal.bytes
    wall_before = time.monotonic()
    for _ in range(rounds):
        text = ''.join(rng.choice(TYPED) for _ in range(length))
        sent = []
        seen = [None] * length
        next_key = 0
        next_at = time.monotonic()
        while True:
            now = time.monotonic()
            if next_key < length and now >= next_at:
                terminal.send(text[next_key])
                sent.append(time.monotonic())
                next_key += 1
                next_at += interval
            terminal.pump(0.001)
            flat = None
            for index in range(len(sent)):
                if seen[index] is not None:
                    continue
                if flat is None:
                    flat = terminal.flat()
                start = max(0, index + 1 - 10)
                if text[start:index + 1] in flat and (index >= 9 or text[:index + 1] in flat):
                    stamp = time.monotonic()
                    for earlier in range(index + 1):
                        if seen[earlier] is None:
                            seen[earlier] = stamp
            if next_key == length and (all(s is not None for s in seen) or time.monotonic() - sent[-1] > timeout):
                break
        for index in range(8, length):  # The first keys are too short to be unique on screen.
            latencies.append(None if seen[index] is None else (seen[index] - sent[index]) * 1000)
        terminal.send('\x7f' * length)
        terminal.read(0.6)
    wall = time.monotonic() - wall_before
    cpu = terminal.cpu_seconds() - cpu_before
    rss_after = terminal.rss_kb()
    measured = [value for value in latencies if value is not None]
    return {
        'keys': len(latencies), 'missed': len(latencies) - len(measured),
        'p50': percentile(measured, 50), 'p95': percentile(measured, 95), 'p99': percentile(measured, 99),
        'max': round(max(measured), 2) if measured else None,
        'cpuPercent': round(100 * cpu / wall, 1), 'rssBeforeKb': rss_before, 'rssAfterKb': rss_after,
        'bytesPerKey': round((terminal.bytes - bytes_before) / max(1, len(latencies) + 8 * rounds))
    }


def idle_usage(terminal, seconds):
    cpu_before = terminal.cpu_seconds()
    rss_before = terminal.rss_kb()
    started = time.monotonic()
    terminal.read(seconds)
    elapsed = time.monotonic() - started
    cpu = terminal.cpu_seconds() - cpu_before
    rss_after = terminal.rss_kb()
    return {
        'durationSeconds': round(elapsed, 2),
        'cpuPercent': round(100 * cpu / elapsed, 1),
        'rssBeforeKb': rss_before,
        'rssAfterKb': rss_after
    }


def base_env():
    env = {key: value for key, value in os.environ.items()
           if not key.upper().endswith(('_API_KEY', '_AUTH_TOKEN', '_OAUTH_TOKEN', '_ACCESS_TOKEN'))
           and key not in ['PI_CODING_AGENT_DIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCODE_CONFIG']}
    env.update({'TERM': 'xterm-256color', 'COLORTERM': 'truecolor'})
    return env


def command_version(command):
    if not command or not command[0]:
        return None
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=8)
        value = (result.stdout or result.stderr).strip()
        return value.splitlines()[0] if result.returncode == 0 and value else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def opencode_binary():
    return shutil.which('opencode') or str(Path.home() / '.opencode/bin/opencode')


def benchmark_metadata():
    package = json.loads((REPOSITORY / 'package.json').read_text())
    pi_package = REPOSITORY / 'node_modules/@earendil-works/pi-coding-agent/package.json'
    pi_version = json.loads(pi_package.read_text()).get('version') if pi_package.exists() else None
    commit = command_version(['git', 'rev-parse', '--short', 'HEAD'])
    dirty = subprocess.run(['git', 'status', '--porcelain'], cwd=REPOSITORY, capture_output=True, text=True)
    return {
        'commit': commit,
        'workingTreeDirty': bool(dirty.stdout.strip()),
        'dirtyPathCount': len(dirty.stdout.splitlines()),
        'platform': platform.platform(),
        'machine': platform.machine(),
        'cpuCount': os.cpu_count(),
        'python': platform.python_version(),
        'node': command_version(['node', '--version']),
        'bun': command_version(['bun', '--version']),
        'harnessVersion': package.get('version'),
        'piVersion': pi_version,
        'opencodeVersion': command_version([opencode_binary(), '--version'])
    }


def model_entry(provider_url):
    return {'baseUrl': provider_url + '/v1', 'api': 'openai-completions', 'apiKey': 'loopback-latency-fixture',
            'compat': {'supportsDeveloperRole': False, 'supportsReasoningEffort': False, 'supportsStore': False},
            'models': [{'id': 'latency-model', 'name': 'Latency model', 'reasoning': True, 'input': ['text'],
                        'contextWindow': 200000, 'maxTokens': 4096,
                        'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}}]}


def create_harness_account(cli, root):
    child = subprocess.Popen(['node', str(cli), 'serve', '--state', str(root / 'state'), '--data', str(root / 'data')],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        for serial, (method, params) in enumerate([('accounts.create', {'label': 'Latency', 'authKind': 'apiKey'}), ('harness.shutdown', {})], 1):
            child.stdin.write(json.dumps({'v': 1, 'id': str(serial), 'method': method, 'params': params}) + '\n')
            child.stdin.flush()
            while True:
                line = child.stdout.readline()
                if not line:
                    raise AssertionError('Harness serve exited: ' + child.stderr.read())
                value = json.loads(line)
                if value.get('id') == str(serial):
                    if value.get('error'):
                        raise AssertionError(value['error'])
                    break
    finally:
        child.stdin.close()
        child.wait(timeout=15)


def launch(target, root, project, provider_url, real, cli):
    env = base_env()
    if target == 'xingular':
        if real:
            return ['node', str(cli)], env
        shared = root / 'state' / 'accounts' / '_shared' / 'pi'
        shared.mkdir(parents=True, exist_ok=True)
        (shared / 'models.json').write_text(json.dumps({'providers': {'latency': model_entry(provider_url)}}))
        (shared / 'settings.json').write_text(json.dumps({'defaultProvider': 'latency', 'defaultModel': 'latency-model',
                                                          'defaultThinkingLevel': 'medium', 'enableAnalytics': False}))
        create_harness_account(cli, root)
        return ['node', str(cli), '--state', str(root / 'state'), '--data', str(root / 'data')], env
    if target == 'pi':
        agent = root / 'pi-agent'
        agent.mkdir(parents=True, exist_ok=True)
        if not real:
            (agent / 'models.json').write_text(json.dumps({'providers': {'latency': model_entry(provider_url)}}))
            (agent / 'settings.json').write_text(json.dumps({'defaultProvider': 'latency', 'defaultModel': 'latency-model',
                                                             'defaultThinkingLevel': 'medium', 'enableAnalytics': False}))
        env['PI_CODING_AGENT_DIR'] = str(agent)
        return ['node', str(REPOSITORY / 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js')], env
    if target == 'opencode':
        binary = opencode_binary()
        if real:
            return [binary], env
        for name in ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']:
            path = root / 'opencode-xdg' / name
            path.mkdir(parents=True, exist_ok=True)
            env[name] = str(path)
        config = root / 'opencode.json'
        config.write_text(json.dumps({
            '$schema': 'https://opencode.ai/config.json', 'autoupdate': False, 'share': 'disabled',
            'model': 'latency/latency-model', 'small_model': 'latency/latency-model',
            'provider': {'latency': {'npm': '@ai-sdk/openai-compatible', 'name': 'Latency',
                                     'options': {'baseURL': provider_url + '/v1', 'apiKey': 'loopback-latency-fixture'},
                                     'models': {'latency-model': {'name': 'Latency model'}}}}}))
        env['OPENCODE_CONFIG'] = str(config)
        # A private server, so the person's own opencode background service is never touched.
        return [binary, '--standalone'], env
    raise SystemExit(f'Unknown target {target}')


def submit(terminal, text):
    for character in text:
        terminal.send(character)
        terminal.read(0.01)
    terminal.read(0.3)
    terminal.send('\r')


def enable_plan_mode(terminal):
    if 'plan mode' in terminal.text():
        return
    submit(terminal, '/plan')
    terminal.wait('plan mode', timeout=10)
    terminal.settle(0.5, 10)


def run_target(target, args, output, provider_url, repeat):
    root = output / target if args.repeats == 1 else output / f'run-{repeat + 1:02d}' / target
    root.mkdir(parents=True, exist_ok=True)
    project = root / 'project'
    project.mkdir(exist_ok=True)
    (project / 'fixture.txt').write_text('\n'.join(filler_words(12, random.Random(i)) for i in range(40)) + '\n')
    Provider.fixture = (project / 'fixture.txt').resolve()
    subprocess.run(['git', 'init', '-q'], cwd=project)
    command, env = launch(target, root, project, provider_url, args.real, args.cli.resolve())
    rng = random.Random(7)
    result = {'target': target, 'repeat': repeat + 1, 'command': command[0], 'scenarios': {}}
    terminal = Terminal(command, project, env, args.width, args.height)
    try:
        result['startup'] = terminal.wait_for_initial_screen()
        result['startup']['rssKb'] = terminal.rss_kb()
        terminal.read(args.warm_idle_seconds)
        result['idleResourceUsage'] = idle_usage(terminal, args.idle_seconds)
        for keys in args.setup:  # For example a model choice: --setup /model '\r' codex '\r'
            terminal.send(keys.encode().decode('unicode_escape'))
            terminal.read(1.5)
        (root / 'startup.txt').write_text(terminal.text())
        scenarios = ['stream'] if args.real else args.scenarios.split(',')
        for scenario in scenarios:
            if scenario == 'idle':
                result['scenarios']['idle'] = type_rounds(terminal, args.rounds, args.length, args.interval, rng)
            elif scenario == 'history':
                started = time.monotonic()
                submit(terminal, 'latency-history: please loop')
                terminal.wait(f'step {HISTORY_TURNS - 1}', timeout=240)
                terminal.settle(2.0, 120)
                (root / 'history.txt').write_text(terminal.text())
                stats = type_rounds(terminal, args.rounds, args.length, args.interval, rng)
                stats['historySetupSeconds'] = round(time.monotonic() - started, 1)
                result['scenarios']['history'] = stats
            elif scenario == 'question':
                enable_plan_mode(terminal)
                submit(terminal, 'latency-question: ask me')
                deadline = time.monotonic() + 60
                while 'Which path' not in terminal.text() and 'Allow once' not in terminal.text() and time.monotonic() < deadline:
                    terminal.pump(0.05)
                terminal.settle(1.0, 20)
                if 'Allow once' in terminal.text():  # A fresh account asks before ask_user runs.
                    (root / 'approval.txt').write_text(terminal.text())
                    result['scenarios']['approval'] = type_rounds(terminal, args.rounds, args.length, args.interval, rng)
                    print(target, 'approval', json.dumps(result['scenarios']['approval']), flush=True)
                    terminal.send('\r')
                    deadline = time.monotonic() + 30
                    while 'Allow once' in terminal.text() and time.monotonic() < deadline:
                        terminal.pump(0.05)
                terminal.wait('Which path', timeout=60)
                terminal.settle(1.0, 20)
                (root / 'question.txt').write_text(terminal.text())
                result['scenarios']['question'] = type_rounds(terminal, args.rounds, args.length, args.interval, rng)
                terminal.send('\x1b')
                terminal.settle(1.0, 20)
            elif scenario in ('stream', 'burst'):
                marker = 'latency-burst' if scenario == 'burst' else 'latency-stream'
                prompt = ('Write a long, detailed markdown essay (at least 1500 words, many headings and bullet lists) '
                          'about how terminal user interfaces render text. Do not use any tools.') if args.real else f'{marker}: go'
                submit(terminal, prompt)
                terminal.read(10 if args.real else 2)  # A real model may think before it streams.
                (root / f'{scenario}-start.txt').write_text(terminal.text())
                result['scenarios'][scenario] = type_rounds(terminal, max(1, args.rounds - 1), args.length, args.interval, rng)
                (root / f'{scenario}-end.txt').write_text(terminal.text())
                terminal.read(args.stream_seconds if not args.real else 5)
                terminal.settle(2.0, 120)
            print(target, repeat + 1, scenario, json.dumps(result['scenarios'][scenario]), flush=True)
    finally:
        (root / 'final.txt').write_text(terminal.text())
        terminal.close()
    return result


def numeric_medians(rows):
    summary = {'runs': len(rows)}
    keys = sorted({key for row in rows for key, value in row.items()
                   if isinstance(value, (int, float)) and not isinstance(value, bool)})
    for key in keys:
        values = [row[key] for row in rows if isinstance(row.get(key), (int, float)) and not isinstance(row.get(key), bool)]
        summary[key] = round(statistics.median(values), 2)
    return summary


def summarize_results(results):
    targets = sorted({result['target'] for result in results if 'target' in result})
    summary = []
    for target in targets:
        runs = [result for result in results if result.get('target') == target and not result.get('error')]
        item = {'target': target, 'runs': len(runs)}
        for section in ['startup', 'idleResourceUsage']:
            rows = [run[section] for run in runs if isinstance(run.get(section), dict)]
            if rows:
                item[section] = numeric_medians(rows)
        scenario_names = sorted({name for run in runs for name in run.get('scenarios', {})})
        item['scenarios'] = {}
        for name in scenario_names:
            rows = [run['scenarios'][name] for run in runs if isinstance(run.get('scenarios', {}).get(name), dict)]
            item['scenarios'][name] = numeric_medians(rows)
        summary.append(item)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--targets', default='xingular,pi,opencode')
    parser.add_argument('--scenarios', default='idle,history,stream,burst')
    parser.add_argument('--rounds', type=int, default=4)
    parser.add_argument('--repeats', type=int, default=1, help='Independent PTY launches per target; target order rotates per repeat')
    parser.add_argument('--length', type=int, default=60)
    parser.add_argument('--interval', type=float, default=0.035)
    parser.add_argument('--width', type=int, default=160)
    parser.add_argument('--height', type=int, default=45)
    parser.add_argument('--warm-idle-seconds', type=float, default=2)
    parser.add_argument('--idle-seconds', type=float, default=3)
    parser.add_argument('--stream-seconds', type=float, default=DEFAULT_STREAM_SECONDS)
    parser.add_argument('--real', action='store_true', help='Run one Xingular-only live stream with its existing account (never copies credentials)')
    parser.add_argument('--setup', nargs='*', default=[], help='Key strings (backslash escapes allowed) sent after startup, before measuring')
    parser.add_argument('--cli', type=Path, default=REPOSITORY / 'dist' / 'cli.js')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if args.repeats < 1 or args.rounds < 1 or args.warm_idle_seconds < 0 or args.idle_seconds <= 0 or args.stream_seconds <= 0:
        parser.error('repeats and rounds must be positive; idle-seconds and stream-seconds must be positive; warm-idle-seconds cannot be negative')
    targets = [target.strip() for target in args.targets.split(',') if target.strip()]
    if not targets:
        parser.error('at least one target is required')
    if args.real and (targets != ['xingular'] or args.repeats != 1):
        parser.error('--real is restricted to one Xingular run; use loopback for Pi and OpenCode comparisons')
    scenarios = [scenario.strip() for scenario in args.scenarios.split(',') if scenario.strip()]
    if any(scenario not in {'idle', 'history', 'stream', 'burst', 'question'} for scenario in scenarios):
        parser.error('scenarios must be idle, history, stream, burst, or question')
    if 'question' in scenarios and targets != ['xingular']:
        parser.error('question is a Harness-only scenario; use --targets xingular for question latency')
    Provider.stream_seconds = args.stream_seconds
    output = (args.output or Path(tempfile.mkdtemp(prefix='terminal-latency-'))).resolve()
    output.mkdir(parents=True, exist_ok=True)
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    provider_url = f'http://127.0.0.1:{server.server_port}'
    print(f'Output: {output}', flush=True)
    report = {
        'metadata': benchmark_metadata(),
        'interval': args.interval, 'length': args.length, 'rounds': args.rounds,
        'repeats': args.repeats, 'size': f'{args.width}x{args.height}',
        'warmIdleSeconds': args.warm_idle_seconds,
        'idleSeconds': args.idle_seconds, 'streamSeconds': args.stream_seconds,
        'scenarios': scenarios, 'real': args.real, 'results': []
    }
    for repeat in range(args.repeats):
        ordered = targets[repeat % len(targets):] + targets[:repeat % len(targets)]
        for target in ordered:
            try:
                report['results'].append(run_target(target, args, output, provider_url, repeat))
            except Exception as error:  # Keep measuring the other targets.
                report['results'].append({'target': target, 'repeat': repeat + 1, 'error': str(error)[:4000]})
                print(target, repeat + 1, 'failed:', str(error)[:2000], flush=True)
    report['summary'] = summarize_results(report['results'])
    (output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
