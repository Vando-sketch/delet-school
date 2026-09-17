import pino from 'pino';
import { createWebServer } from './server.js';
import { getBankingService } from '../banking/index.js';

const logger = pino({ name: 'web' });

const PORT = Number(process.env.WEB_PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

async function main() {
  const bankingService = getBankingService();
  await bankingService.init();

  const app = createWebServer();

  const server = app.listen(PORT, HOST, () => {
    logger.info({ host: HOST, port: PORT }, `Web dashboard listening on http://${HOST}:${PORT}`);
    if (process.env.TS_HOSTNAME) {
      logger.info(`Accessible over Tailnet at: http://${process.env.TS_HOSTNAME}:${PORT}`);
    }
  });

  const shutdown = () => {
    logger.info('Shutting down web dashboard...');
    bankingService.stop();
    server.close(() => {
      logger.info('Web dashboard closed');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start web server');
  process.exit(1);
});
