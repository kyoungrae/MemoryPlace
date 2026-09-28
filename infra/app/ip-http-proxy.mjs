import http from 'node:http';

const expectedHost = process.env.EXPECTED_HOST;
if (!expectedHost) throw new Error('EXPECTED_HOST is required');

const upstreamHost = process.env.UPSTREAM_HOST || 'memoryplace-app';
const upstreamPort = Number(process.env.UPSTREAM_PORT || 3001);
const port = Number(process.env.PORT || 3000);

http.createServer((request, response) => {
  if (request.headers.host !== expectedHost) {
    response.writeHead(421).end();
    return;
  }

  const upstream = http.request({
    hostname: upstreamHost,
    port: upstreamPort,
    method: request.method,
    path: request.url,
    headers: { ...request.headers, 'x-forwarded-proto': 'http' },
    agent: false,
  }, upstreamResponse => {
    const headers = { ...upstreamResponse.headers };
    if (headers['set-cookie']) {
      headers['set-cookie'] = headers['set-cookie'].map(cookie =>
        cookie.startsWith('mp_session=') ? cookie.replace(/;\s*Secure(?=;|$)/gi, '') : cookie,
      );
    }
    response.writeHead(upstreamResponse.statusCode || 502, headers);
    upstreamResponse.pipe(response);
  });

  upstream.on('error', () => {
    if (!response.headersSent) response.writeHead(502);
    response.end();
  });
  request.on('aborted', () => upstream.destroy());
  request.pipe(upstream);
}).listen(port, '0.0.0.0');
