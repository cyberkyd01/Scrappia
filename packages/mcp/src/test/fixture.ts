/** Minimal 2-page product listing served from memory (copied from core's fixture site, trimmed). */
import { createServer, type Server } from 'node:http';

export const FIXTURE_PRODUCTS = [
  { id: 1, name: 'Product 1', price: '$10.00' },
  { id: 2, name: 'Product 2', price: '$11.50' },
  { id: 3, name: 'Product 3', price: '$13.00' },
  { id: 4, name: 'Product 4', price: '$14.50' },
];
const PER_PAGE = 2;

function listing(page: number): string {
  const pages = Math.ceil(FIXTURE_PRODUCTS.length / PER_PAGE);
  const slice = FIXTURE_PRODUCTS.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const cards = slice.map((p) => `<article class="product" data-id="${p.id}"><h3><a href="/product/${p.id}" title="${p.name}">${p.name}</a></h3><span class="price">${p.price}</span></article>`).join('');
  const next = page < pages ? `<li class="next"><a href="/products?page=${page + 1}">next</a></li>` : '';
  return `<!doctype html><html><head><title>Products ${page}</title></head><body><h1 id="title">Products</h1><div class="list">${cards}</div><ul class="pager">${next}</ul></body></html>`;
}

export function startFixture(): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (html: string, status = 200) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); };
    if (url.pathname === '/' || url.pathname === '/products') return send(listing(Number(url.searchParams.get('page') ?? 1)));
    const m = /^\/product\/(\d+)$/.exec(url.pathname);
    if (m) { const p = FIXTURE_PRODUCTS.find((x) => x.id === Number(m[1])); return p ? send(`<html><body><h1 class="name">${p.name}</h1><p class="desc">About ${p.name}</p></body></html>`) : send('<h1>404</h1>', 404); }
    send('<h1>404</h1>', 404);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as { port: number };
    resolve({ server, url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
  }));
}
