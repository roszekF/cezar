#!/usr/bin/env node
/**
 * A stand-in for the Docker Sandboxes `sbx` CLI, for tests (`CEZ_SBX_BIN=<this file>`).
 * It implements the subset cezar uses — version, create (+ --help), ls, exec, stop, rm —
 * over a JSON state file, and `exec` runs the command LOCALLY in `-w`. It proves wiring,
 * never isolation: isolation is asserted only by the gated real-sbx suite.
 *
 * Env knobs:
 *   FAKE_SBX_STATE    state file (default: <tmpdir>/fake-sbx-state.json)
 *   FAKE_SBX_VERSION  client version to report (default v0.45.0)
 *   FAKE_SBX_BROKEN   "version" → `version` exits 1; "help" → `create --help` lacks --skills
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const statePath = process.env.FAKE_SBX_STATE ?? join(tmpdir(), 'fake-sbx-state.json');
const load = () => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { sandboxes: [] });
const save = (state) => writeFileSync(statePath, JSON.stringify(state, null, 2));
const fail = (message, code = 1) => {
  process.stderr.write(`error: ${message}\n`);
  process.exit(code);
};

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case 'version': {
    if (process.env.FAKE_SBX_BROKEN === 'version') fail('broken');
    const version = process.env.FAKE_SBX_VERSION ?? 'v0.45.0';
    process.stdout.write(JSON.stringify({ client: { version }, server: { state: 'unavailable' } }, null, 2) + '\n');
    break;
  }
  case 'create': {
    if (rest.includes('--help')) {
      const flags = ['--pull', '--template', '--name', '--memory'];
      if (process.env.FAKE_SBX_BROKEN !== 'help') flags.push('--skills');
      process.stdout.write(`Usage:\n  sbx create [flags] AGENT [PATH...]\n\nFlags:\n${flags.map((f) => `      ${f}`).join('\n')}\n`);
      break;
    }
    let name;
    const positional = [];
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === '--name') name = rest[++i];
      else if (['--pull', '--skills', '--template', '-t', '--memory', '-m'].includes(arg)) i++;
      else if (!arg.startsWith('-')) positional.push(arg);
    }
    const [agent, ...workspaces] = positional;
    name ??= `${agent}-sandbox`;
    const state = load();
    if (state.sandboxes.some((s) => s.name === name)) fail(`sandbox "${name}" already exists`);
    state.sandboxes.push({ name, agent, status: 'running', workspaces, created_at: new Date().toISOString() });
    save(state);
    break;
  }
  case 'ls': {
    process.stdout.write(JSON.stringify({ sandboxes: load().sandboxes }, null, 2) + '\n');
    break;
  }
  case 'exec': {
    let cwd = process.cwd();
    const env = { ...process.env };
    let i = 0;
    for (; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === '-i' || arg === '-t' || arg === '-it' || arg === '--interactive' || arg === '--tty') continue;
      if (arg === '-w' || arg === '--workdir') cwd = rest[++i];
      else if (arg === '-e' || arg === '--env') {
        const [key, ...value] = rest[++i].split('=');
        env[key] = value.join('=');
      } else if (arg === '--env-file') {
        for (const line of readFileSync(rest[++i], 'utf8').split('\n')) {
          const eq = line.indexOf('=');
          if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
        }
      } else break;
    }
    const [name, bin, ...args] = rest.slice(i);
    const state = load();
    const box = state.sandboxes.find((s) => s.name === name);
    if (!box) fail(`sandbox "${name}" not found`);
    box.status = 'running';
    save(state);
    const child = spawn(bin, args, { cwd, env: { ...env, SANDBOX_NAME: name }, stdio: 'inherit' });
    child.on('error', (err) => fail(err.message, 127));
    child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 + 15 : 1)));
    break;
  }
  case 'stop':
  case 'rm': {
    const names = rest.filter((a) => !a.startsWith('-'));
    const state = load();
    for (const name of names) {
      const box = state.sandboxes.find((s) => s.name === name);
      if (!box) fail(`sandbox "${name}" not found`);
      if (command === 'stop') box.status = 'stopped';
    }
    if (command === 'rm') state.sandboxes = state.sandboxes.filter((s) => !names.includes(s.name));
    save(state);
    break;
  }
  default:
    fail(`unknown command "${command}"`);
}
