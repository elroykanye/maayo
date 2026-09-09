import { execFileSync } from 'node:child_process';
import { extname } from 'node:path';

export function resolvePnpmInvocation(pnpmCli, args, platform = process.platform) {
  pnpmCli ??= platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const extension = extname(pnpmCli).toLowerCase();
  if (!['.js', '.cjs', '.mjs'].includes(extension)) {
    return { command: pnpmCli, args };
  }

  return {
    command: process.execPath,
    args: [pnpmCli, ...args],
  };
}

export function runPnpm(args, cwd) {
  const pnpmCli = process.env.npm_execpath;
  const invocation = resolvePnpmInvocation(pnpmCli, args);
  execFileSync(invocation.command, invocation.args, {
    cwd,
    stdio: 'inherit',
  });
}
