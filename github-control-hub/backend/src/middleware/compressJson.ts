import { Request, Response, NextFunction } from "express";
import { gzipSync } from "node:zlib";

/**
 * Gzips large JSON responses.
 *
 * The Vulnerabilities tab on a large organization serialises to 2.76MB, and
 * nothing here was compressing anything, on any route. Gzipped that body is
 * 64KB. Over a local socket the difference is survivable; against a deployed
 * backend it is the load time.
 *
 * Written rather than installed, at twenty lines, because every runtime
 * dependency has to be declared and bundled or the packaged desktop build
 * breaks in a way `npm run dev` never shows. `repro-backenddeps` exists
 * because that has happened three times.
 */

/**
 * Below this, the encoding headers cost more than the compression saves, and
 * gzip's own framing can make a very small body larger than it started.
 */
const MIN_BYTES = 4096;

export function compressJson(req: Request, res: Response, next: NextFunction): void {
  const accepts = String(req.headers["accept-encoding"] ?? "").includes("gzip");
  if (!accepts) return next();

  const sendPlain = res.json.bind(res);

  res.json = (body: any) => {
    // Something upstream already encoded this. Encoding it again produces a
    // body no client can read, and the failure reads as corruption rather
    // than as this middleware.
    if (res.getHeader("Content-Encoding")) return sendPlain(body);

    const text = JSON.stringify(body);
    if (Buffer.byteLength(text) < MIN_BYTES) return sendPlain(body);

    const packed = gzipSync(text);

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Encoding", "gzip");
    // Without this a shared cache can hand the compressed body to a client
    // that never asked for it and cannot read it.
    res.setHeader("Vary", "Accept-Encoding");
    // Whatever length was computed for the plain body is now wrong, and a
    // wrong Content-Length is a truncated or hanging response.
    res.removeHeader("Content-Length");

    res.end(packed);
    return res;
  };

  next();
}
