import { execFileSync } from 'node:child_process';
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { resolvePnpmInvocation } from './pnpm-cli.mjs';

test('runs JavaScript pnpm entry points through Node', () => {
  const invocation = resolvePnpmInvocation('/tmp/pnpm.cjs', ['pack']);

  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args, ['/tmp/pnpm.cjs', 'pack']);
});

test('runs a native package-manager executable directly', () => {
  const invocation = resolvePnpmInvocation(process.execPath, ['--version']);
  const setupPnpmInvocation = resolvePnpmInvocation(
    '/home/runner/setup-pnpm/node_modules/.pnpm/pnpm@12.3.4/node_modules/pnpm/pnpm',
    ['pack'],
  );

  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args, ['--version']);
  assert.match(execFileSync(invocation.command, invocation.args, { encoding: 'utf8' }), /^v\d+/);
  assert.deepEqual(setupPnpmInvocation, {
    command: '/home/runner/setup-pnpm/node_modules/.pnpm/pnpm@12.3.4/node_modules/pnpm/pnpm',
    args: ['pack'],
  });
});

test('falls back to pnpm on PATH when launched outside a pnpm script', () => {
  assert.deepEqual(resolvePnpmInvocation(undefined, ['pack'], 'linux'), {
    command: 'pnpm',
    args: ['pack'],
  });
  assert.deepEqual(resolvePnpmInvocation(undefined, ['pack'], 'win32'), {
    command: 'pnpm.cmd',
    args: ['pack'],
  });
});
