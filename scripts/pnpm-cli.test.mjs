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

  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args, ['--version']);
  assert.match(execFileSync(invocation.command, invocation.args, { encoding: 'utf8' }), /^v\d+/);
});
