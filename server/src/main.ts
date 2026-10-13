import { loadConfig, ConfigError } from './config';
import { buildApp } from './app';
import { fileURLToPath } from 'node:url';
try {
    const config = loadConfig();
    const app = buildApp(config, { logger: true, dataDir: process.env.SERVER_DATA_DIR ?? fileURLToPath(new URL('../data', import.meta.url)) });
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
        process.once(signal, () => { void app.close(); });
    await app.listen({ host: config.host, port: config.port });
}
catch (e) {
    if (e instanceof ConfigError) {
        console.error(`启动失败：${e.message}`);
        process.exit(1);
    }
    throw e;
}
