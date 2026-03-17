const WORKER_BASE = 'https://restless-credit-a6e1.wangderingfiction.workers.dev';

export async function onRequest(context) {
  const request = context.request;
  const params = context.params || {};
  const pathParam = params.path;
  const path = Array.isArray(pathParam) ? pathParam.join('/') : String(pathParam || '');
  const url = new URL(request.url);
  const target = new URL('/wf/api/' + path, WORKER_BASE);
  target.search = url.search;

  const headers = new Headers(request.headers);
  headers.set('x-forwarded-host', url.host);

  const init = {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
  };

  const upstream = await fetch(target.toString(), init);
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}
