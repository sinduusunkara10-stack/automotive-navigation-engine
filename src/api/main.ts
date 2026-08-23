import { createApiServer } from "./server.js";

const port = Number(process.env.PORT ?? 3000);
const server = createApiServer();

server.listen(port, () => {
  console.log(`navigation-engine API listening on port ${port} (local proof of concept, not authenticated)`);
});

function shutdown(signal: string): void {
  console.log(`Received ${signal}, shutting down gracefully...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
