/**
 * The Vulnerabilities tab shipping 2.76MB of JSON, uncompressed, every open.
 *
 * 7,047 alerts plus a marker for every repository serialise to 2.76MB. Gzipped
 * that is 64KB, a 43x reduction, and nothing in this backend was compressing
 * anything: no response, on any route, ever. Over a local socket that is
 * survivable; against a deployed backend it is the load time.
 *
 * Written rather than installed. `compression` is the obvious package and this
 * is twenty lines, and the packaging note in repro-backenddeps is the reason
 * to prefer the twenty lines: every runtime dependency has to be declared and
 * bundled or the desktop build breaks in a way development never shows. An app
 * whose subject is dependency risk should be slow to add dependencies.
 *
 * The care is in what must NOT be compressed, because getting that wrong
 * breaks routes rather than slowing them:
 *
 *   - a client that did not offer gzip
 *   - a body small enough that the header costs more than the saving
 *   - anything already encoded, so a second pass cannot double-wrap it
 */
import { gunzipSync } from "node:zlib";
import { compressJson } from "./src/middleware/compressJson";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

/** Just enough of express's response for the middleware to act on. */
function fakeRes() {
  const headers: Record<string, string> = {};
  const res: any = {
    headers,
    ended: null as Buffer | null,
    jsonCalled: null as unknown,
    setHeader: (k: string, v: string) => { headers[k.toLowerCase()] = v; },
    getHeader: (k: string) => headers[k.toLowerCase()],
    removeHeader: (k: string) => { delete headers[k.toLowerCase()]; },
    end: (buf: Buffer) => { res.ended = buf; return res; },
  };
  res.json = (body: unknown) => { res.jsonCalled = body; return res; };
  return res;
}

const big = Array.from({ length: 400 }, (_, i) => ({ repo: `service-${i}`, dependency: "jackson-databind" }));

console.log("a large body to a client that accepts gzip is compressed");
{
  const res = fakeRes();
  compressJson({ headers: { "accept-encoding": "gzip, deflate, br" } } as any, res, () => {});
  res.json(big);

  check("it is sent as bytes, not through res.json", res.ended !== null && res.jsonCalled === null);
  check("  labelled as gzip", res.getHeader("Content-Encoding") === "gzip");
  check("  and varying on the request header, so a cache cannot serve it to a client that cannot read it",
    /accept-encoding/i.test(String(res.getHeader("Vary"))));
  check("  still declared as JSON", /application\/json/.test(String(res.getHeader("Content-Type"))));

  // The point of the exercise.
  const original = Buffer.byteLength(JSON.stringify(big));
  check(`  and much smaller (${original} -> ${res.ended!.length} bytes)`,
    res.ended!.length < original / 4, { original, packed: res.ended!.length });

  // Compressed to something that unpacks to exactly what was asked for. A
  // response that is smaller and wrong is worse than a large one.
  check("  unpacking gives back the same JSON",
    JSON.stringify(JSON.parse(gunzipSync(res.ended!).toString("utf8"))) === JSON.stringify(big));

  // Wrong length is a truncated or hanging response, and the packed length is
  // not the length express already worked out for the plain body.
  check("  and no stale Content-Length is left behind", res.getHeader("Content-Length") === undefined);
}

console.log("\nand left alone in every case where compressing it would be wrong");
{
  const plain = fakeRes();
  compressJson({ headers: {} } as any, plain, () => {});
  plain.json(big);
  check("a client that did not offer gzip gets ordinary JSON",
    plain.jsonCalled !== null && plain.ended === null);

  const small = fakeRes();
  compressJson({ headers: { "accept-encoding": "gzip" } } as any, small, () => {});
  small.json({ ok: true });
  check("  a small body is not worth the header",
    small.jsonCalled !== null && small.ended === null);

  // Double-encoding produces a body no client can read, and the failure looks
  // like corruption rather than like this middleware.
  const already = fakeRes();
  already.setHeader("Content-Encoding", "gzip");
  compressJson({ headers: { "accept-encoding": "gzip" } } as any, already, () => {});
  already.json(big);
  check("  and a body already encoded is not encoded twice",
    already.jsonCalled !== null && already.ended === null);
}

console.log("\nit is actually installed, in front of the routes");
{
  const fs = require("node:fs") as typeof import("node:fs");
  const server = fs.readFileSync(require("node:path").join(__dirname, "src/server.ts"), "utf8");
  check("the server uses it", /compressJson/.test(server));

  // After the body parser and before the routes: a middleware registered
  // after a route never runs for it, which is a silent no-op rather than an
  // error, and would leave this whole file passing while nothing was
  // compressed.
  const at = server.indexOf("compressJson)");
  const firstRoute = server.indexOf('app.use("/api/repos"');
  check("  before the routes it is meant to compress", at > 0 && at < firstRoute, { at, firstRoute });
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
