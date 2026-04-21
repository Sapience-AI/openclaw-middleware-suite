import { spawnSync as nodeSpawn } from 'node:child_process';

export function runCli(cliPath, repoRoot, args, env) {
  return nodeSpawn(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}
