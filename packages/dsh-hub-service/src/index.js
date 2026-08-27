import { parseConfig, HELP } from './config.js';
import { HubServer } from './server.js';

export { HubServer } from './server.js';

export function start(argv = process.argv.slice(2)) {
  const config = parseConfig(argv);
  if (config.help) {
    console.log(HELP);
    return null;
  }
  const server = new HubServer(config);
  server.listen();

  const shutdown = () => {
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}
