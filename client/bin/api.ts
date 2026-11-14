// Quote Feed API, run by the seller: tsx bin/api.ts [--port 8787]
import { createServer } from "node:http";
import { handleApiRequest } from "../src/api.ts";
import { arg, makeNear, networkFromEnv } from "../src/env.ts";
import { nearChainReader } from "../src/pass.ts";

const port = Number(arg("port", "8787"));
const chain = nearChainReader(await makeNear(networkFromEnv()));

createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  handleApiRequest({ method: req.method ?? "GET", path, authorization: req.headers.authorization }, chain, Date.now())
    .catch((e: unknown) => ({ status: 500, body: { error: e instanceof Error ? e.message : String(e) } }))
    .then(({ status, body }) => {
      console.log(`${req.method} ${path} -> ${status}${typeof body["error"] === "string" ? ` (${body["error"]})` : ""}`);
      res.writeHead(status, { "content-type": "application/json" }).end(`${JSON.stringify(body)}\n`);
    });
}).listen(port, "127.0.0.1", () => console.log(`Quote Feed API on http://127.0.0.1:${port}/v1/quotes (pass-gated; sample data)`));
