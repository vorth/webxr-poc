#!/usr/bin/env node
// Minimal zero-dependency HTTPS static file server for local WebXR testing.
// Usage: node server.js [port]  (default port: 8443)

import https from "https";
import fs from "fs";
import path from "path";
import { networkInterfaces } from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.argv[2] ?? "8553", 10);

const MIME = {
  ".html": "text/html",
  ".js":   "application/javascript",
  ".mjs":  "application/javascript",
  ".css":  "text/css",
  ".json": "application/json",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".wasm": "application/wasm",
};

const options = {
  key:  fs.readFileSync(path.join(__dirname, "cert.key")),
  cert: fs.readFileSync(path.join(__dirname, "cert.pem")),
};

const server = https.createServer(options, (req, res) => {
  // Sanitise path to prevent directory traversal
  const safePath = path.normalize(req.url.split("?")[0]).replace(/^(\.\.[/\\])+/, "");
  let filePath = path.join(__dirname, safePath === "/" ? "index.html" : safePath);

  // If the path is a directory, serve its index.html
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, "index.html");
  }

  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] ?? "application/octet-stream";

  res.writeHead(200, {
    "Content-Type": contentType,
    // Required for SharedArrayBuffer / cross-origin isolation (nice to have for WebGPU)
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
  });

  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\nHTTPS server running on port ${PORT}\n`);

  // Print all LAN addresses
  const nets = networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const addr of iface) {
      if (addr.family === "IPv4" && !addr.internal) {
        console.log(`  https://${addr.address}:${PORT}`);
      }
    }
  }
  console.log(`  https://localhost:${PORT}`);
  console.log(`\nOn first visit, accept the self-signed certificate warning.\n`);
});
