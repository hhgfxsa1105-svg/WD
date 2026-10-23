import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { REPO_ROOT } from '../db/connection.js';

const EnvSchema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DB_PATH: z.string().min(1).default('./data/jianghu.sqlite'),
});

export interface Env {
  HOST: string;
  PORT: number;
  /** 已解析为绝对路径（相对路径以仓库根目录为基准） */
  DB_PATH: string;
}

/** 读取仓库根目录的 .env（若存在）；已存在的环境变量优先 */
export function loadDotEnv(): void {
  const file = resolve(REPO_ROOT, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const e = EnvSchema.parse(source);
  return { ...e, DB_PATH: e.DB_PATH === ':memory:' ? e.DB_PATH : resolve(REPO_ROOT, e.DB_PATH) };
}
