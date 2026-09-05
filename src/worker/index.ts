const PDF_KEY = "CV_Basil_Papadimas.pdf";
const PDF_PATH = `/${PDF_KEY}`;
const CANONICAL_HOST = "papadim.as";
const LEGACY_HOSTS = new Set(["ppdms.gr", "www.ppdms.gr"]);
const COMMON_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

interface ByteRange {
  start: number;
  end: number;
  length: number;
}

type RangeParseResult =
  | { kind: "none" }
  | { kind: "unsatisfiable" }
  | { kind: "range"; value: ByteRange };

function withCommonHeaders(
  headers?: HeadersInit,
  additional?: Record<string, string>
): Headers {
  const result = new Headers(headers);
  for (const [name, value] of Object.entries(COMMON_HEADERS)) {
    result.set(name, value);
  }
  if (additional) {
    for (const [name, value] of Object.entries(additional)) {
      result.set(name, value);
    }
  }
  return result;
}

function cvResponse(
  body: BodyInit | null,
  status: number,
  headers?: HeadersInit,
  additional?: Record<string, string>
): Response {
  return new Response(body, {
    status,
    headers: withCommonHeaders(headers, additional),
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logBindingError(path: string, method: string, error: unknown): void {
  console.error(
    JSON.stringify({
      event: "cv_binding_error",
      path,
      method,
      error: errorMessage(error),
    })
  );
}

function parseEtags(value: string): string[] {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

function stripWeakPrefix(tag: string): string {
  return tag.startsWith("W/") ? tag.slice(2) : tag;
}

function strongEtagMatch(value: string, actual: string): boolean {
  const candidate = value.trim();
  return (
    candidate !== "*" &&
    !candidate.startsWith("W/") &&
    !actual.startsWith("W/") &&
    candidate === actual
  );
}

function weakEtagMatch(value: string, actual: string): boolean {
  const candidate = value.trim();
  return candidate !== "*" && stripWeakPrefix(candidate) === stripWeakPrefix(actual);
}

function etagListMatches(
  header: string,
  actual: string,
  strong: boolean
): boolean {
  return parseEtags(header).some((tag) => {
    if (tag === "*") return true;
    return strong ? strongEtagMatch(tag, actual) : weakEtagMatch(tag, actual);
  });
}

function parseHttpDate(value: string | null): Date | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return new Date(timestamp);
}

function unixSeconds(value: Date): number {
  return Math.floor(value.getTime() / 1000);
}

function evaluatePreconditions(
  request: Request,
  metadata: R2Object
): 200 | 304 | 412 | undefined {
  const ifMatch = request.headers.get("If-Match");
  if (ifMatch !== null && !etagListMatches(ifMatch, metadata.httpEtag, true)) {
    return 412;
  }

  if (ifMatch === null) {
    const ifUnmodifiedSince = parseHttpDate(
      request.headers.get("If-Unmodified-Since")
    );
    if (
      ifUnmodifiedSince &&
      unixSeconds(metadata.uploaded) > unixSeconds(ifUnmodifiedSince)
    ) {
      return 412;
    }
  }

  const ifNoneMatch = request.headers.get("If-None-Match");
  if (ifNoneMatch !== null) {
    if (etagListMatches(ifNoneMatch, metadata.httpEtag, false)) {
      return 304;
    }
    return undefined;
  }

  const ifModifiedSince = parseHttpDate(
    request.headers.get("If-Modified-Since")
  );
  if (
    ifModifiedSince &&
    unixSeconds(metadata.uploaded) <= unixSeconds(ifModifiedSince)
  ) {
    return 304;
  }

  return 200;
}

function parseUnsignedInteger(value: string): bigint | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}

function parseByteRange(value: string | null, size: number): RangeParseResult {
  if (!value) return { kind: "none" };

  const trimmed = value.trim();
  if (!trimmed.startsWith("bytes=")) return { kind: "none" };

  const rangeValue = trimmed.slice("bytes=".length).trim();
  if (!rangeValue || rangeValue.includes(",")) return { kind: "none" };

  const match = /^(\d*)-(\d*)$/.exec(rangeValue);
  if (!match || (match[1] === "" && match[2] === "")) {
    return { kind: "none" };
  }

  const sizeBigInt = BigInt(size);
  if (match[1] === "") {
    const suffix = parseUnsignedInteger(match[2]);
    if (suffix === undefined || suffix <= 0n || sizeBigInt === 0n) {
      return { kind: "unsatisfiable" };
    }
    const startBigInt = suffix >= sizeBigInt ? 0n : sizeBigInt - suffix;
    const end = size - 1;
    const start = Number(startBigInt);
    return { kind: "range", value: { start, end, length: end - start + 1 } };
  }

  const startBigInt = parseUnsignedInteger(match[1]);
  if (startBigInt === undefined || startBigInt >= sizeBigInt) {
    return { kind: "unsatisfiable" };
  }

  const requestedEnd =
    match[2] === "" ? sizeBigInt - 1n : parseUnsignedInteger(match[2]);
  if (requestedEnd === undefined || requestedEnd < startBigInt) {
    return { kind: "unsatisfiable" };
  }

  const endBigInt =
    requestedEnd >= sizeBigInt ? sizeBigInt - 1n : requestedEnd;
  const start = Number(startBigInt);
  const end = Number(endBigInt);
  return { kind: "range", value: { start, end, length: end - start + 1 } };
}

function ifRangeAllowsRange(request: Request, metadata: R2Object): boolean {
  const ifRange = request.headers.get("If-Range");
  if (!ifRange) return true;

  const value = ifRange.trim();
  if (value.startsWith('"') || value.startsWith("W/")) {
    return strongEtagMatch(value, metadata.httpEtag);
  }

  const date = parseHttpDate(value);
  return Boolean(
    date && unixSeconds(metadata.uploaded) <= unixSeconds(date)
  );
}

function pdfHeaders(
  object: R2Object,
  contentLength: number,
  contentRange?: string
): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", "application/pdf");
  headers.set(
    "Content-Disposition",
    'inline; filename="CV_Basil_Papadimas.pdf"'
  );
  headers.set("Content-Length", String(contentLength));
  headers.set("ETag", object.httpEtag);
  headers.set("Last-Modified", object.uploaded.toUTCString());
  headers.set("Accept-Ranges", "bytes");
  if (contentRange) {
    headers.set("Content-Range", contentRange);
  }
  return headers;
}

function methodNotAllowed(): Response {
  return cvResponse(null, 405, undefined, { Allow: "GET, HEAD" });
}

function redirectToPdf(request: Request): Response {
  const location = new URL(PDF_PATH, request.url).toString();
  return cvResponse(null, 302, undefined, { Location: location });
}

function redirectLegacyHost(request: Request): Response | undefined {
  const url = new URL(request.url);
  if (!LEGACY_HOSTS.has(url.hostname)) return undefined;

  url.protocol = "https:";
  url.hostname = CANONICAL_HOST;
  return cvResponse(null, 308, undefined, {
    Location: url.toString(),
    "Cache-Control": "public, max-age=86400",
  });
}

function missingPdf(head = false): Response {
  return cvResponse(head ? null : "CV not found", 404, {
    "Content-Type": "text/plain; charset=utf-8",
  });
}

function bindingFailure(head = false): Response {
  return cvResponse(head ? null : "CV temporarily unavailable", 503, {
    "Content-Type": "text/plain; charset=utf-8",
  });
}

async function headPdf(request: Request, env: Env): Promise<Response> {
  let metadata: R2Object | null;
  try {
    metadata = await env.DATA.head(PDF_KEY);
  } catch (error) {
    logBindingError(new URL(request.url).pathname, request.method, error);
    return bindingFailure(true);
  }

  if (!metadata) return missingPdf(true);

  const precondition = evaluatePreconditions(request, metadata);
  if (precondition === 304) {
    return cvResponse(null, 304, pdfHeaders(metadata, metadata.size));
  }
  if (precondition === 412) {
    return cvResponse(null, 412, pdfHeaders(metadata, metadata.size));
  }

  return cvResponse(null, 200, pdfHeaders(metadata, metadata.size));
}

async function getPdf(request: Request, env: Env): Promise<Response> {
  let metadata: R2Object | null;
  try {
    metadata = await env.DATA.head(PDF_KEY);
  } catch (error) {
    logBindingError(new URL(request.url).pathname, request.method, error);
    return bindingFailure();
  }

  if (!metadata) return missingPdf();

  for (let attempt = 0; attempt < 2; attempt++) {
    const precondition = evaluatePreconditions(request, metadata);
    if (precondition === 304) {
      return cvResponse(null, 304, pdfHeaders(metadata, metadata.size));
    }
    if (precondition === 412) {
      return cvResponse(null, 412, pdfHeaders(metadata, metadata.size));
    }

    const parsedRange = parseByteRange(
      request.headers.get("Range"),
      metadata.size
    );
    if (parsedRange.kind === "unsatisfiable") {
      return cvResponse(null, 416, pdfHeaders(metadata, 0, `bytes */${metadata.size}`));
    }

    const requestedRange =
      parsedRange.kind === "range" &&
      ifRangeAllowsRange(request, metadata)
        ? parsedRange.value
        : undefined;

    const options: R2GetOptions & {
      onlyIf: R2Conditional;
    } = {
      onlyIf: { etagMatches: metadata.etag },
    };
    if (requestedRange) {
      options.range = {
        offset: requestedRange.start,
        length: requestedRange.length,
      };
    }

    let object: R2ObjectBody | R2Object | null;
    try {
      object = await env.DATA.get(PDF_KEY, options);
    } catch (error) {
      logBindingError(new URL(request.url).pathname, request.method, error);
      return bindingFailure();
    }

    if (object && "body" in object) {
      const contentLength = requestedRange?.length ?? metadata.size;
      const contentRange = requestedRange
        ? `bytes ${requestedRange.start}-${requestedRange.end}/${metadata.size}`
        : undefined;
      const headers = pdfHeaders(object, contentLength, contentRange);
      return new Response(object.body, {
        status: requestedRange ? 206 : 200,
        headers: withCommonHeaders(headers),
      });
    }

    if (attempt === 0) {
      try {
        metadata = await env.DATA.head(PDF_KEY);
      } catch (error) {
        logBindingError(new URL(request.url).pathname, request.method, error);
        return bindingFailure();
      }
      if (!metadata) return missingPdf();
      continue;
    }

    console.error(
      JSON.stringify({
        event: "cv_object_changed_during_read",
        path: new URL(request.url).pathname,
        method: request.method,
      })
    );
    return bindingFailure();
  }

  return bindingFailure();
}

async function handlePdf(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed();
  }
  if (request.method === "HEAD") {
    return headPdf(request, env);
  }
  return getPdf(request, env);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const hostRedirect = redirectLegacyHost(request);
    if (hostRedirect) return hostRedirect;

    const pathname = new URL(request.url).pathname;
    if (pathname === "/cv") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return methodNotAllowed();
      }
      return redirectToPdf(request);
    }
    if (pathname === PDF_PATH) {
      return handlePdf(request, env);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
