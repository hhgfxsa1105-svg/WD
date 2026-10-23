import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as base, expect } from '@playwright/test';

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

export interface GameServer {
  url: string;
  /** 把服务端时钟向前拨动（毫秒） */
  advance(ms: number): Promise<void>;
  /** 设定之后所有随机判定使用的值（0 ≤ v < 1；0 必成功，0.9999 必失败） */
  setRng(value: number): Promise<void>;
  /** 直接修改角色状态（用于构造「进度已满」等场景） */
  setPlayer(patch: Record<string, unknown>): Promise<void>;
  addItem(itemId: string, quantity: number): Promise<void>;
  /** 优雅关闭并用同一份存档重新启动（端口不变） */
  restart(): Promise<void>;
}

async function waitHealthy(url: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${url}/api/v1/health`)).ok) return;
    } catch {
      /* 尚未启动 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('测试用游戏服务启动超时');
}

/** 每个用例使用独立的临时存档与独立端口，互不影响 */
export const test = base.extend<{ server: GameServer }>({
  server: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), 'jhz-e2e-'));
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    let child: ChildProcess | undefined;

    const start = async () => {
      child = spawn('node_modules/.bin/tsx', ['e2e/test-server.ts'], {
        env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_PATH: join(dir, 'save.sqlite') },
        stdio: 'ignore',
      });
      await waitHealthy(url);
    };
    const stop = async () => {
      const c = child;
      if (!c || c.exitCode !== null) return;
      const exited = new Promise((r) => c.once('exit', r));
      c.kill('SIGTERM');
      await exited;
    };

    const post = async (path: string, body: unknown) => {
      const r = await fetch(`${url}/__test/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`测试接口 ${path} 失败：${r.status} ${await r.text()}`);
    };

    await start();
    await use({
      url,
      advance: (ms) => post('advance', { ms }),
      setRng: (value) => post('rng', { value }),
      setPlayer: (patch) => post('player', patch),
      addItem: (itemId, quantity) => post('item', { itemId, quantity }),
      restart: async () => {
        await stop();
        await start();
      },
    });
    await stop();
    rmSync(dir, { recursive: true, force: true });
  },
});

export { expect };
