const WORKER_BASE = 'https://restless-credit-a6e1.wangderingfiction.workers.dev';

export async function onRequest(context) {
  const request = context.request;
  const params = context.params || {};
  const pathParam = params.path;
  const path = Array.isArray(pathParam) ? pathParam.join('/') : String(pathParam || '');

  const reqUrl = new URL(request.url);
  const target = new URL('/wf/api/' + path, WORKER_BASE);
  target.search = reqUrl.search;

  const headers = new Headers(request.headers);
  headers.set('x-forwarded-host', reqUrl.host);

  const upstream = await fetch(target.toString(), {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
  });

  const respHeaders = new Headers(upstream.headers);
  respHeaders.set('Cache-Control', 'no-store');
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
}
