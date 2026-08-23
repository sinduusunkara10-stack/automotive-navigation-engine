import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
};

export interface LocalStaticServer {
  server: Server;
  baseUrl: string;
  close: () => Promise<void>;
}

/**
 * Minimal fixture server for the deterministic local proof of concept. Binds to
 * 127.0.0.1 on an ephemeral port so the test never depends on network access or a
 * fixed port, and so the engine's allowed-domain check has a concrete local origin
 * to validate against.
 */
export async function startStaticServer(rootDir: string): Promise<LocalStaticServer> {
  const normalizedRoot = normalize(rootDir);

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const requestPath = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
        const safePath = requestPath === "/" ? "/start.html" : requestPath;
        const filePath = normalize(join(normalizedRoot, safePath));
        if (!filePath.startsWith(normalizedRoot)) {
          res.writeHead(403).end("Forbidden");
          return;
        }
        const body = await readFile(filePath);
        const contentType = CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream";
        res.writeHead(200, { "Content-Type": contentType }).end(body);
      } catch {
        res.writeHead(404).end("Not found");
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Failed to determine static server address");
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
