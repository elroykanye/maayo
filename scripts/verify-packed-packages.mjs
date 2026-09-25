import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPnpm } from './pnpm-cli.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageNames = [
  '@maayo/protocol',
  '@maayo/client',
  '@maayo/react',
  '@maayo/angular',
  '@maayo/nest',
  '@maayo/express',
];
const packageDirs = packageNames.map((name) => join(root, 'packages', name.slice('@maayo/'.length)));
const scratch = mkdtempSync(join(tmpdir(), 'maayo-packed-consumer-'));
const tarballDir = join(scratch, 'tarballs');
const consumerDir = join(scratch, 'consumer');

try {
  mkdirSync(tarballDir);
  mkdirSync(consumerDir);

  for (const packageDir of packageDirs) {
    runPnpm(['pack', '--pack-destination', tarballDir], packageDir);
  }

  const tarballs = readdirSync(tarballDir)
    .filter((file) => file.endsWith('.tgz'))
    .map((file) => join(tarballDir, file));
  if (tarballs.length !== packageNames.length) {
    throw new Error(`Expected ${packageNames.length} tarballs, found ${tarballs.length}`);
  }

  const packedDependencies = Object.fromEntries(packageNames.map((packageName) => {
    const prefix = `${packageName.replace('@', '').replace('/', '-')}-`;
    const tarball = tarballs.find((file) => file.split(/[\\/]/).at(-1)?.startsWith(prefix));
    if (!tarball) throw new Error(`No tarball found for ${packageName}`);
    return [packageName, `file:${tarball.replaceAll('\\', '/')}`];
  }));

  writeFileSync(join(consumerDir, 'package.json'), JSON.stringify({
    name: 'maayo-packed-consumer',
    private: true,
    type: 'module',
    dependencies: packedDependencies,
  }, null, 2));
  writeFileSync(join(consumerDir, 'pnpm-workspace.yaml'), [
    'packages:',
    "  - '.'",
    'overrides:',
    ...Object.entries(packedDependencies).map(([name, spec]) =>
      `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`),
  ].join('\n'));
  runPnpm(['install'], consumerDir);

  const installedManifest = (name) => JSON.parse(readFileSync(
    join(consumerDir, 'node_modules', ...name.split('/'), 'package.json'),
    'utf8',
  ));
  const angularManifest = installedManifest('@maayo/angular');
  const clientManifest = installedManifest('@maayo/client');
  const protocolManifest = installedManifest('@maayo/protocol');
  if (angularManifest.dependencies?.['@maayo/client'] !== clientManifest.version) {
    throw new Error(`Packed Angular depends on client ${angularManifest.dependencies?.['@maayo/client']}; expected ${clientManifest.version}`);
  }
  if (angularManifest.dependencies?.['@maayo/protocol'] !== protocolManifest.version) {
    throw new Error(`Packed Angular depends on protocol ${angularManifest.dependencies?.['@maayo/protocol']}; expected ${protocolManifest.version}`);
  }

  const requireFromConsumer = createRequire(join(consumerDir, 'commonjs-consumer.cjs'));
  for (const packageName of packageNames) {
    const required = requireFromConsumer(packageName);
    if (!required || Object.keys(required).length === 0) {
      throw new Error(`${packageName} exposed no CommonJS exports`);
    }
    if (packageName === '@maayo/client' && typeof required.SyncEngine?.prototype.syncOnce !== 'function') {
      throw new Error('@maayo/client exposed no CommonJS syncOnce API');
    }
  }

  const esmCheck = join(consumerDir, 'esm-consumer.mjs');
  writeFileSync(esmCheck, [
    "import { createRequire } from 'node:module';",
    ...packageNames.map((name, index) => `import * as package${index} from ${JSON.stringify(name)};`),
    ...packageNames.map((name, index) =>
      `if (Object.keys(package${index}).length === 0) throw new Error(${JSON.stringify(`${name} exposed no ESM exports`)});`),
    "if (typeof package1.SyncEngine?.prototype.syncOnce !== 'function') throw new Error('@maayo/client exposed no ESM syncOnce API');",
    "const require = createRequire(import.meta.url);",
    "const cjsProtocol = require('@maayo/protocol');",
    "const cjsError = new cjsProtocol.DuplicateMutationError();",
    "const esmError = new package0.DuplicateMutationError();",
    "if (!package0.isDuplicateMutationError(cjsError)) throw new Error('ESM protocol did not recognize the CommonJS duplicate error');",
    "if (!cjsProtocol.isDuplicateMutationError(esmError)) throw new Error('CommonJS protocol did not recognize the ESM duplicate error');",
    "async function probeExpress(makeRouter, Conflict) {",
    "  let persisted = false;",
    "  const mutation = { id: '01PACKED00000000000000001', channel: 'org:packed', entityType: 'Student', entityId: 'student-1', op: 'CREATE', payload: '{}', authorIdentityId: 'user-1', deviceId: 'device-1', clientTs: '2026-09-02T00:00:00Z', parentIds: [] };",
    "  const store = { existsById: async () => persisted, saveAll: async () => { persisted = true; throw new Conflict(); }, findChanges: async () => [] };",
    "  const router = makeRouter({ store });",
    "  const handler = router.stack[0].route.stack[0].handle;",
    "  let body;",
    "  const response = { json: (value) => { body = value; }, status: () => response };",
    "  await handler({ body: { mutations: [mutation] }, query: {} }, response);",
    "  if (body?.accepted?.[0]?.id !== mutation.id) throw new Error('Express adapter did not recover a cross-format duplicate conflict');",
    "}",
    "const cjsExpress = require('@maayo/express');",
    "await probeExpress(package5.maayoRouter, cjsProtocol.DuplicateMutationError);",
    "await probeExpress(cjsExpress.maayoRouter, package0.DuplicateMutationError);",
  ].join('\n'));
  execFileSync(process.execPath, [esmCheck], {
    cwd: consumerDir,
    stdio: 'inherit',
  });

  console.log(`Verified CommonJS and ESM consumers for ${packageNames.length} packed packages.`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
