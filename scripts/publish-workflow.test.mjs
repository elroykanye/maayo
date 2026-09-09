import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');
const packageNames = ['protocol', 'client', 'angular', 'react', 'nest', 'express'];

test('supports a deliberate npm-only recovery run', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /force_npm:/);
  assert.match(workflow, /if \[ "\$\{\{ inputs\.force_npm \}\}" = "true" \]/);
});

test('publishes pnpm-packed tarballs through the npm trusted-publishing client', () => {
  assert.match(workflow, /node-version: 24/);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN/);

  for (const packageName of packageNames) {
    assert.match(
      workflow,
      new RegExp(`node scripts/publish-npm-package\\.mjs packages/${packageName}`),
    );
    assert.doesNotMatch(
      workflow,
      new RegExp(`pnpm --filter @maayo/${packageName} publish`),
    );
  }
});
