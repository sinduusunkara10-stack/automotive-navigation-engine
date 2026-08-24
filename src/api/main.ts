import type { Server } from "node:http";
import { createApiServer } from "./server.js";
import { MissingApiTokenError } from "./auth.js";

const port = Number(process.env.PORT ?? 3000);

let server: Server;
try {
  server = createApiServer();
} catch (err) {
  if (err instanceof MissingApiTokenError) {
    console.error(`Failed to start navigation-engine API: ${err.message}`);
  } else {
    console.error("Failed to start navigation-engine API:", err instanceof Error ? err.message : err);
  }
  process.exit(1);
}

server.listen(port, () => {
  console.log(
    `navigation-engine API listening on port ${port} (NODE_ENV=${process.env.NODE_ENV ?? "development"}, ` +
      "POST /v1/tasks and GET /v1/tasks/:runId require Authorization: Bearer <token>)",
  );
});

function shutdown(signal: string): void {
  console.log(`Received ${signal}, shutting down gracefully...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
