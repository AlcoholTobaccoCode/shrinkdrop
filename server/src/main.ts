import { loadConfig, ConfigError } from './config';
import { buildApp } from './app';

try {
  const config = loadConfig();
  const app = buildApp(config, { logger: true });
  await app.listen({ host: config.host, port: config.port });
} catch (e) {
  if (e instanceof ConfigError) { console.error(`启动失败：${e.message}`); process.exit(1); }
  throw e;
}
