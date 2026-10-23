import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';

const env = loadEnv();
const app = await buildApp();
await app.listen({ host: env.HOST, port: env.PORT });
console.log(`江湖志已启动：http://${env.HOST}:${env.PORT}`);
