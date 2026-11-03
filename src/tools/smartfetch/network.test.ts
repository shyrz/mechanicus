import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
  buildAllowedOrigins,
  buildConditionalHeaders,
  decodeBody,
  fetchWithRedirects,
  fetchWithUpgradeFallback,
  normalizeUrl,
} from './network';

describe('smartfetch/network', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  test('sniffs charset only within the first 2048 HTML bytes', () => {
    const bytes = Buffer.from(
      `${' '.repeat(2048)}<meta charset="windows-1252">é`,
      'utf8',
    );
    const result = decodeBody(bytes, undefined, 'text/html');
    expect(result.decodedCharset).toBe('utf-8');
    expect(result.text).toEndWith('é');
  });

  test('discards malformed redirect responses before throwing', async () => {
    const response = new Response('redirect body', {
      status: 302,
      headers: { location: 'http://[invalid' },
    });
    globalThis.fetch = mock(async () => response) as unknown as typeof fetch;
    await expect(
      fetchWithRedirects(
        'https://example.com/start',
        1000,
        'text',
        new AbortController().signal,
      ),
    ).rejects.toThrow('Invalid redirect location');
    expect(response.body?.locked).toBe(false);
    expect(response.bodyUsed).toBe(true);
  });

  test('returns 304 as a conditional response instead of treating it as a redirect', async () => {
    globalThis.fetch = mock(
      async () => new Response(null, { status: 304 }),
    ) as unknown as typeof fetch;
    const result = await fetchWithRedirects(
      'https://example.com/cache',
      1000,
      'text',
      new AbortController().signal,
    );
    expect('response' in result && result.response.status).toBe(304);
  });

  test('does not start an HTTP fallback after cancellation', async () => {
    const controller = new AbortController();
    const fetchMock = mock(async () => {
      controller.abort(new Error('cancelled primary fetch'));
      throw controller.signal.reason;
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      fetchWithUpgradeFallback(
        normalizeUrl('http://example.com/'),
        1000,
        'text',
        controller.signal,
      ),
    ).rejects.toThrow('cancelled primary fetch');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('discards a failed HTTPS response and attempts HTTP fallback only once', async () => {
    const response = new Response('failed secure response', { status: 500 });
    const fetchMock = mock(async (input: string | URL | Request) => {
      if (String(input).startsWith('https:')) return response;
      throw new Error('HTTP fallback failed');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      fetchWithUpgradeFallback(
        normalizeUrl('http://example.com/'),
        1000,
        'text',
        new AbortController().signal,
      ),
    ).rejects.toThrow('HTTP fallback failed');
    expect(response.bodyUsed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('sniffs repeated incomplete meta tags without unbounded backtracking', () => {
    const bytes = Buffer.from('<meta '.repeat(200_000));
    const started = performance.now();
    const result = decodeBody(bytes, undefined, 'text/html');
    expect(result.text).toBe(bytes.toString());
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test('normalizeUrl strips the fragment from fetch URLs only', () => {
    const normalized = normalizeUrl('https://example.com/docs#sec1');

    expect(normalized.url).toBe('https://example.com/docs');
    expect(normalized.originalUrl).toBe('https://example.com/docs#sec1');
    expect(normalized.fallbackUrl).toBeUndefined();
    expect(normalized.upgradedToHttps).toBe(false);
  });

  test('normalizeUrl strips fragments from the http fallback URL too', () => {
    const normalized = normalizeUrl('http://example.com/docs#sec1');

    expect(normalized.url).toBe('https://example.com/docs');
    expect(normalized.originalUrl).toBe('http://example.com/docs#sec1');
    expect(normalized.fallbackUrl).toBe('http://example.com/docs');
    expect(normalized.upgradedToHttps).toBe(true);
  });

  test('normalizeUrl keeps origin and query string while dropping the fragment', () => {
    const normalized = normalizeUrl('https://example.com/docs?page=2#anchor');

    expect(normalized.url).toBe('https://example.com/docs?page=2');
    expect(new URL(normalized.url).origin).toBe('https://example.com');
  });

  test('collects unique allowed origins from permission patterns', () => {
    const origins = [
      ...buildAllowedOrigins([
        'https://docs.example.com/page',
        'https://docs.example.com/llms.txt',
        'https://cdn.example.com/asset',
        'not-a-url',
      ]),
    ].sort();

    expect(origins).toEqual([
      'https://cdn.example.com',
      'https://docs.example.com',
    ]);
  });

  test('follows permitted same-origin redirects', async () => {
    const fetchMock = mock(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === 'https://docs.example.com/start') {
        return new Response('', {
          status: 302,
          headers: { location: '/next' },
        });
      }

      if (url === 'https://docs.example.com/next') {
        return new Response('ok', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchWithRedirects(
      'https://docs.example.com/start',
      1_000,
      'markdown',
      new AbortController().signal,
    );

    expect('blockedRedirect' in result).toBe(false);
    if ('blockedRedirect' in result) {
      throw new Error('Expected redirect to be followed');
    }

    expect(result.finalUrl).toBe('https://docs.example.com/next');
    expect(result.redirectChain).toEqual([
      {
        from: 'https://docs.example.com/start',
        to: 'https://docs.example.com/next',
        status: 302,
      },
    ]);
  });

  test('blocks cross-origin redirects when the origin is not allowed', async () => {
    const fetchMock = mock(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === 'https://docs.example.com/start') {
        return new Response('', {
          status: 302,
          headers: { location: 'https://other.example.com/landing' },
        });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchWithRedirects(
      'https://docs.example.com/start',
      1_000,
      'markdown',
      new AbortController().signal,
    );

    expect(result).toEqual({
      blockedRedirect: true,
      redirectUrl: 'https://other.example.com/landing',
      statusCode: 302,
      redirectChain: [
        {
          from: 'https://docs.example.com/start',
          to: 'https://other.example.com/landing',
          status: 302,
        },
      ],
    });
  });

  test('allows redirects to explicitly allowed origins', async () => {
    const fetchMock = mock(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === 'https://docs.example.com/start') {
        return new Response('', {
          status: 302,
          headers: { location: 'https://cdn.example.com/asset' },
        });
      }

      if (url === 'https://cdn.example.com/asset') {
        return new Response('ok', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchWithRedirects(
      'https://docs.example.com/start',
      1_000,
      'markdown',
      new AbortController().signal,
      undefined,
      'GET',
      new Set(['https://docs.example.com', 'https://cdn.example.com']),
    );

    expect('blockedRedirect' in result).toBe(false);
    if ('blockedRedirect' in result) {
      throw new Error('Expected redirect to be allowed');
    }

    expect(result.finalUrl).toBe('https://cdn.example.com/asset');
  });

  test('builds conditional headers from etag and last-modified without binary branching', () => {
    expect(buildConditionalHeaders(undefined)).toBeUndefined();

    expect(
      buildConditionalHeaders({
        requestedUrl: 'https://example.com/file',
        finalUrl: 'https://example.com/file',
        statusCode: 200,
        contentType: 'application/pdf',
        charset: undefined,
        etag: '"abc"',
        lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT',
        contentLength: 42,
        filename: 'file.pdf',
        canonicalUrl: 'https://example.com/file',
        redirectChain: [],
        upgradedToHttps: false,
        truncated: false,
        binary: true,
        binaryKind: 'pdf',
      }),
    ).toEqual({
      'If-None-Match': '"abc"',
      'If-Modified-Since': 'Wed, 01 Jan 2025 00:00:00 GMT',
    });
  });
});
