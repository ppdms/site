import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker/index";

const PDF_KEY = "CV_Basil_Papadimas.pdf";
const PDF_BYTES = new TextEncoder().encode(
  "deterministic cv fixture\n0123456789abcdefghijklmnopqrstuvwxyz"
);

async function seedPdf(bytes: Uint8Array = PDF_BYTES): Promise<void> {
  await env.DATA.delete(PDF_KEY);
  await env.DATA.put(PDF_KEY, bytes, {
    httpMetadata: { contentType: "application/pdf" },
  });
}

async function requestAt(
  host: string,
  path: string,
  init?: RequestInit
): Promise<Response> {
  return worker.fetch(new Request(`https://${host}${path}`, init), env);
}

async function request(
  path: string,
  init?: RequestInit
): Promise<Response> {
  return requestAt("site.test", path, init);
}

async function responseBytes(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer());
}

describe("Canonical host redirects", () => {
  it("redirects legacy domains while preserving paths and queries", async () => {
    const rootDomain = await requestAt(
      "ppdms.gr",
      "/posts/example?ref=legacy"
    );
    expect(rootDomain.status).toBe(308);
    expect(rootDomain.headers.get("location")).toBe(
      "https://papadim.as/posts/example?ref=legacy"
    );
    expect(rootDomain.headers.get("cache-control")).toBe(
      "public, max-age=86400"
    );

    const wwwDomain = await requestAt("www.ppdms.gr", "/gallery/");
    expect(wwwDomain.status).toBe(308);
    expect(wwwDomain.headers.get("location")).toBe(
      "https://papadim.as/gallery/"
    );
  });
});

describe("CV Worker", () => {
  beforeEach(async () => {
    await seedPdf();
  });

  it("redirects GET and HEAD /cv to the same-origin PDF", async () => {
    const getResponse = await request("/cv?from=home");
    expect(getResponse.status).toBe(302);
    expect(getResponse.headers.get("location")).toBe(
      "https://site.test/CV_Basil_Papadimas.pdf"
    );
    expect(getResponse.headers.get("cache-control")).toBe("no-store");

    const headResponse = await request("/cv", { method: "HEAD" });
    expect(headResponse.status).toBe(302);
    expect(await responseBytes(headResponse)).toHaveLength(0);
  });

  it("serves PDF metadata and streams bytes for GET and HEAD", async () => {
    const getResponse = await request(`/${PDF_KEY}`);
    expect(getResponse.status).toBe(200);
    expect(getResponse.headers.get("content-type")).toBe("application/pdf");
    expect(getResponse.headers.get("content-disposition")).toBe(
      'inline; filename="CV_Basil_Papadimas.pdf"'
    );
    expect(getResponse.headers.get("content-length")).toBe(
      String(PDF_BYTES.byteLength)
    );
    expect(await responseBytes(getResponse)).toEqual(PDF_BYTES);

    const headResponse = await request(`/${PDF_KEY}`, { method: "HEAD" });
    expect(headResponse.status).toBe(200);
    expect(headResponse.headers.get("etag")).toBeTruthy();
    expect(headResponse.headers.get("last-modified")).toBeTruthy();
    expect(headResponse.headers.get("content-length")).toBe(
      String(PDF_BYTES.byteLength)
    );
    expect(await responseBytes(headResponse)).toHaveLength(0);
  });

  it("honors ETag and date preconditions in standard precedence", async () => {
    const initial = await request(`/${PDF_KEY}`, { method: "HEAD" });
    const etag = initial.headers.get("etag");
    const lastModified = initial.headers.get("last-modified");
    expect(etag).toBeTruthy();
    expect(lastModified).toBeTruthy();

    const matching = await request(`/${PDF_KEY}`, {
      headers: { "If-None-Match": etag || "" },
    });
    expect(matching.status).toBe(304);
    expect(await responseBytes(matching)).toHaveLength(0);

    const nonmatchingFutureDate = await request(`/${PDF_KEY}`, {
      headers: {
        "If-None-Match": '"not-the-current-etag"',
        "If-Modified-Since": new Date(Date.now() + 86_400_000).toUTCString(),
      },
    });
    expect(nonmatchingFutureDate.status).toBe(200);
    expect(await responseBytes(nonmatchingFutureDate)).toEqual(PDF_BYTES);

    const failedMatch = await request(`/${PDF_KEY}`, {
      headers: { "If-Match": '"not-the-current-etag"' },
    });
    expect(failedMatch.status).toBe(412);
    expect(await responseBytes(failedMatch)).toHaveLength(0);

    const precedence = await request(`/${PDF_KEY}`, {
      headers: {
        "If-Match": '"not-the-current-etag"',
        "If-Unmodified-Since": new Date(Date.now() + 86_400_000).toUTCString(),
      },
    });
    expect(precedence.status).toBe(412);
  });

  it("handles byte ranges, suffixes, malformed ranges, and If-Range", async () => {
    const ranged = await request(`/${PDF_KEY}`, {
      headers: { Range: "bytes=0-9" },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe(
      `bytes 0-9/${PDF_BYTES.byteLength}`
    );
    expect(await responseBytes(ranged)).toEqual(PDF_BYTES.slice(0, 10));

    const suffix = await request(`/${PDF_KEY}`, {
      headers: { Range: "bytes=-5" },
    });
    expect(suffix.status).toBe(206);
    expect(await responseBytes(suffix)).toEqual(PDF_BYTES.slice(-5));

    const unsatisfiable = await request(`/${PDF_KEY}`, {
      headers: { Range: `bytes=${PDF_BYTES.byteLength}-` },
    });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get("content-range")).toBe(
      `bytes */${PDF_BYTES.byteLength}`
    );

    const malformed = await request(`/${PDF_KEY}`, {
      headers: { Range: "items=0-9" },
    });
    expect(malformed.status).toBe(200);
    expect(await responseBytes(malformed)).toEqual(PDF_BYTES);

    const ifRangeMismatch = await request(`/${PDF_KEY}`, {
      headers: {
        Range: "bytes=0-9",
        "If-Range": '"not-the-current-etag"',
      },
    });
    expect(ifRangeMismatch.status).toBe(200);
    expect(await responseBytes(ifRangeMismatch)).toEqual(PDF_BYTES);
  });

  it("ignores Range for HEAD and rejects unsupported methods", async () => {
    const headResponse = await request(`/${PDF_KEY}`, {
      method: "HEAD",
      headers: { Range: "bytes=0-9" },
    });
    expect(headResponse.status).toBe(200);
    expect(headResponse.headers.get("content-length")).toBe(
      String(PDF_BYTES.byteLength)
    );
    expect(await responseBytes(headResponse)).toHaveLength(0);

    const postResponse = await request(`/${PDF_KEY}`, { method: "POST" });
    expect(postResponse.status).toBe(405);
    expect(postResponse.headers.get("allow")).toBe("GET, HEAD");
  });

  it("does not serve stale bytes after an overwrite", async () => {
    const initial = await request(`/${PDF_KEY}`, { method: "HEAD" });
    const oldEtag = initial.headers.get("etag");
    const replacement = new TextEncoder().encode("replacement pdf bytes");
    await env.DATA.put(PDF_KEY, replacement, {
      httpMetadata: { contentType: "application/pdf" },
    });

    const response = await request(`/${PDF_KEY}`, {
      headers: { "If-None-Match": oldEtag || "" },
    });
    expect(response.status).toBe(200);
    expect(await responseBytes(response)).toEqual(replacement);
  });

  it("returns 404 before creation and serves a subsequently created key", async () => {
    await env.DATA.delete(PDF_KEY);
    const missing = await request(`/${PDF_KEY}`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");

    await seedPdf();
    const created = await request(`/${PDF_KEY}`);
    expect(created.status).toBe(200);
    expect(await responseBytes(created)).toEqual(PDF_BYTES);
  });

  it("re-reads once when the object changes between head and get", async () => {
    const originalHead = env.DATA.head.bind(env.DATA);
    let firstHead = true;
    const headSpy = vi.spyOn(env.DATA, "head").mockImplementation(async (key) => {
      const metadata = await originalHead(key);
      if (firstHead && metadata) {
        firstHead = false;
        const replacement = new TextEncoder().encode("raced replacement");
        await env.DATA.put(key, replacement, {
          httpMetadata: { contentType: "application/pdf" },
        });
      }
      return metadata;
    });

    try {
      const response = await request(`/${PDF_KEY}`);
      expect(response.status).toBe(200);
      expect(await responseBytes(response)).toEqual(
        new TextEncoder().encode("raced replacement")
      );
    } finally {
      headSpy.mockRestore();
    }
  });

  it("returns a non-cacheable 503 for binding failures", async () => {
    const headSpy = vi
      .spyOn(env.DATA, "head")
      .mockRejectedValue(new Error("fixture binding unavailable"));
    try {
      const response = await request(`/${PDF_KEY}`);
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await responseBytes(response)).toEqual(
        new TextEncoder().encode("CV temporarily unavailable")
      );
    } finally {
      headSpy.mockRestore();
    }
  });
});
