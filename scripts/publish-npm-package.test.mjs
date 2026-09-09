import { strict as assert } from 'node:assert';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { publishPackage } from './publish-npm-package.mjs';

test('packs workspace dependencies with pnpm and publishes the tarball with npm OIDC', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'maayo-publish-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const packageDir = join(scratch, 'packages', 'client');
  const tarballDir = join(scratch, 'tarballs');
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: '@maayo/client',
    version: '0.3.3',
  }));

  const calls = [];
  const runPnpmCommand = (args, cwd) => {
    calls.push({ tool: 'pnpm', args, cwd });
    mkdirSync(tarballDir, { recursive: true });
    writeFileSync(join(tarballDir, 'maayo-client-0.3.3.tgz'), 'packed');
  };
  const execFile = (command, args, options) => {
    calls.push({ tool: 'npm', command, args, options });
  };

  await publishPackage(packageDir, {
    execFile,
    fetchImpl: async () => ({ status: 404 }),
    npmCommand: 'npm',
    runPnpmCommand,
    tarballDir,
    env: { NODE_AUTH_TOKEN: 'stale-token', KEEP_ME: 'yes' },
  });

  assert.deepEqual(calls[0], {
    tool: 'pnpm',
    args: ['pack', '--pack-destination', tarballDir],
    cwd: packageDir,
  });
  assert.equal(calls[1].command, 'npm');
  assert.deepEqual(calls[1].args, [
    'publish',
    join(tarballDir, 'maayo-client-0.3.3.tgz'),
    '--access',
    'public',
  ]);
  assert.equal(calls[1].options.env.NODE_AUTH_TOKEN, undefined);
  assert.equal(calls[1].options.env.KEEP_ME, 'yes');
});

test('skips a package version that is already published', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'maayo-publish-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const packageDir = join(scratch, 'packages', 'protocol');
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: '@maayo/protocol',
    version: '0.3.1',
  }));

  let commandCalled = false;
  const result = await publishPackage(packageDir, {
    execFile: () => { commandCalled = true; },
    fetchImpl: async () => ({ status: 200 }),
    runPnpmCommand: () => { commandCalled = true; },
  });

  assert.equal(result, null);
  assert.equal(commandCalled, false);
});
