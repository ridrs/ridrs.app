// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from 'node:child_process';

export interface ProcessResult {
  readonly stdout: Buffer;
  readonly stderr: string;
}

/** Runs an external tool to completion; rejects with its stderr on a non-zero exit. */
export function runProcess(command: string, args: readonly string[]): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) =>
      reject(new Error(`Cannot start "${command}": ${error.message}`, { cause: error })),
    );
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout: Buffer.concat(chunks), stderr });
      else reject(new Error(`"${command}" exited with code ${code}: ${stderr.trim().slice(-500)}`));
    });
  });
}

const versionCache = new Map<string, Promise<string>>();

/** First line of `<tool> -version`, e.g. `8.1.1` for ffmpeg; cached per tool. */
export function toolVersion(command: string): Promise<string> {
  let version = versionCache.get(command);
  if (!version) {
    version = runProcess(command, ['-version']).then(({ stdout }) => {
      const firstLine = stdout.toString('utf8').split('\n')[0] ?? '';
      return /version\s+(\S+)/.exec(firstLine)?.[1] ?? 'unknown';
    });
    versionCache.set(command, version);
  }
  return version;
}
