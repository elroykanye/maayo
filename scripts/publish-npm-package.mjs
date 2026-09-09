import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPnpm } from './pnpm-cli.mjs';

export function packageTarballName(name, version) {
  return `${name.replace(/^@/, '').replaceAll('/', '-')}-${version}.tgz`;
}

export async function publishPackage(packageDir, options = {}) {
  const resolvedPackageDir = resolve(packageDir);
  const manifestPath = join(resolvedPackageDir, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!manifest.name?.startsWith('@maayo/') || !manifest.version) {
    throw new Error(`Expected a versioned @maayo package in ${manifestPath}`);
  }

  const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(manifest.name)}/${encodeURIComponent(manifest.version)}`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const registryResponse = await fetchImpl(registryUrl);
  if (registryResponse.status === 200) {
    console.log(`${manifest.name}@${manifest.version} is already published; skipping.`);
    return null;
  }
  if (registryResponse.status !== 404) {
    throw new Error(
      `Could not check ${manifest.name}@${manifest.version} in the npm registry (status ${registryResponse.status})`,
    );
  }

  const tarballDir = resolve(
    options.tarballDir ?? join(process.env.RUNNER_TEMP ?? tmpdir(), 'maayo-tarballs'),
  );
  mkdirSync(tarballDir, { recursive: true });

  const runPnpmCommand = options.runPnpmCommand ?? runPnpm;
  runPnpmCommand(['pack', '--pack-destination', tarballDir], resolvedPackageDir);

  const tarball = join(tarballDir, packageTarballName(manifest.name, manifest.version));
  if (!existsSync(tarball)) {
    throw new Error(`pnpm did not create the expected tarball: ${tarball}`);
  }

  const publishEnv = { ...(options.env ?? process.env) };
  delete publishEnv.NODE_AUTH_TOKEN;
  const npmCommand = options.npmCommand ?? (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const execFile = options.execFile ?? execFileSync;
  execFile(npmCommand, ['publish', tarball, '--access', 'public'], {
    cwd: resolvedPackageDir,
    env: publishEnv,
    stdio: 'inherit',
  });

  return tarball;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  if (process.argv.length !== 3) {
    throw new Error(`Usage: node ${basename(fileURLToPath(import.meta.url))} <package-directory>`);
  }
  await publishPackage(process.argv[2]);
}
