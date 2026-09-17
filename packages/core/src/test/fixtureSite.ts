/**
 * A tiny local web site used by the test-suite: product listing with next-link pagination,
 * detail pages, a category page, a JS-rendered page, a load-more page and a login form.
 */
import { createServer, type Server } from 'node:http';

const PRODUCTS = Array.from({ length: 25 }, (_, i) => ({
  id: i + 1,
  name: `Product ${i + 1}`,
  price: `$${(10 + i * 1.5).toFixed(2)}`,
  rating: (i % 5) + 1,
  category: i % 2 ? 'Gadgets' : 'Widgets',
  description: `Description of product ${i + 1}. Lorem ipsum.`,
  sku: `SKU-${1000 + i}`,
  email: i % 3 === 0 ? `seller${i}@example.com` : '',
}));
const PER_PAGE = 10;

function layout(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>
<nav><a href="/">Home</a> <a href="/category/widgets">Widgets</a> <a href="/category/gadgets">Gadgets</a></nav>
<main>${body}</main><footer>Fixture site</footer></body></html>`;
}

function listing(page: number, filter?: (p: (typeof PRODUCTS)[number]) => boolean, base = '/products'): string {
  const items = PRODUCTS.filter(filter ?? (() => true));
  const pages = Math.ceil(items.length / PER_PAGE);
  const slice = items.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const cards = slice.map((p) => `<article class="product" data-id="${p.id}">
  <h3><a href="/product/${p.id}" title="${p.name}">${p.name}</a></h3>
  <span class="price">${p.price}</span>
  <p class="rating star-${p.rating}">Rating: ${p.rating}</p>
  <img src="/img/${p.id}.jpg" alt="${p.name}">
  ${p.email ? `<a href="mailto:${p.email}">Contact</a>` : ''}
</article>`).join('\n');
  const next = page < pages ? `<li class="next"><a href="${base}?page=${page + 1}">next</a></li>` : '';
  const numbered = Array.from({ length: pages }, (_, i) => `<li><a class="page-link" href="${base}?page=${i + 1}">${i + 1}</a></li>`).join('');
  return layout(`Products page ${page}`, `<h1>Products</h1><div class="list">${cards}</div><ul class="pager">${numbered}${next}</ul>`);
}

export function startFixtureSite(port = 0): Promise<{ server: Server; url: string; close: () => Promise<void>; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    hits.push(url.pathname + url.search);
    const send = (html: string, status = 200, headers: Record<string, string> = {}) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers }); res.end(html); };
    const path = url.pathname;
    if (path === '/' || path === '/products') return send(listing(Number(url.searchParams.get('page') ?? 1)));
    if (path.startsWith('/category/')) { const cat = path.split('/')[2]; return send(listing(Number(url.searchParams.get('page') ?? 1), (p) => p.category.toLowerCase() === cat, path)); }
    if (path === '/categories') return send(layout('Categories', `<ul class="cats"><li><a href="/category/widgets">Widgets</a></li><li><a href="/category/gadgets">Gadgets</a></li></ul>`));
    const m = /^\/product\/(\d+)$/.exec(path);
    if (m) {
      const p = PRODUCTS.find((x) => x.id === Number(m[1]));
      if (!p) return send(layout('404', '<h1>Not found</h1>'), 404);
      return send(layout(p.name, `<div class="detail" itemscope><h1 itemprop="name">${p.name}</h1><div class="desc"><p>${p.description}</p></div>
<table class="specs"><tr><th>SKU</th><td>${p.sku}</td></tr><tr><th>Category</th><td>${p.category}</td></tr><tr><th>Rating</th><td>${p.rating}</td></tr></table>
<dl><dt>Price</dt><dd>${p.price}</dd></dl><script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: p.name, sku: p.sku, offers: { price: p.price.slice(1) } })}</script></div>`));
    }
    if (path === '/js') return send(layout('JS page', `<div id="root"></div><script>
      const items = ${JSON.stringify(PRODUCTS.slice(0, 5))};
      setTimeout(() => { document.getElementById('root').innerHTML = items.map(p => '<div class="item"><span class="n">' + p.name + '</span><span class="p">' + p.price + '</span></div>').join(''); }, 150);
    </script>`));
    if (path === '/loadmore') return send(layout('Load more', `<div id="list"><div class="row">Row 1</div><div class="row">Row 2</div></div><button id="more">Load more</button><script>
      let n = 2; document.getElementById('more').addEventListener('click', () => { for (let i = 0; i < 2; i++) { n++; const d = document.createElement('div'); d.className = 'row'; d.textContent = 'Row ' + n; document.getElementById('list').appendChild(d); } if (n >= 8) document.getElementById('more').remove(); });
    </script>`));
    if (path === '/jsnext') return send(layout('JS next', `<div id="list"></div><button id="next">Next</button><script>
      const pages = [['A1','A2'],['B1','B2'],['C1','C2']]; let i = 0;
      const render = () => { document.getElementById('list').innerHTML = pages[i].map(t => '<div class="row">' + t + '</div>').join(''); document.getElementById('next').disabled = i >= pages.length - 1; };
      document.getElementById('next').addEventListener('click', () => { if (i < pages.length - 1) { i++; setTimeout(render, 100); } });
      render();
    </script>`));
    if (path === '/scroll') return send(layout('Scroll', `<div id="list">${Array.from({ length: 10 }, (_, i) => `<div class="row" style="height:300px">Row ${i + 1}</div>`).join('')}</div><script>
      let n = 10; window.addEventListener('scroll', () => { if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 50 && n < 30) { for (let i = 0; i < 10; i++) { n++; const d = document.createElement('div'); d.className = 'row'; d.style.height = '300px'; d.textContent = 'Row ' + n; document.getElementById('list').appendChild(d); } } });
    </script>`));
    if (path === '/search') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      return send(listing(Number(url.searchParams.get('page') ?? 1), (p) => p.name.toLowerCase().includes(q), `/search?q=${encodeURIComponent(q)}&`).replace('?page=', 'page='));
    }
    if (path === '/login') {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => { const params = new URLSearchParams(body); if (params.get('user') === 'admin' && params.get('pass') === 'secret') { res.writeHead(302, { location: '/secret', 'set-cookie': 'session=ok; Path=/' }); res.end(); } else send(layout('Login failed', '<p class="error">Bad credentials</p>'), 401); });
        return;
      }
      return send(layout('Login', `<form method="post" action="/login"><input name="user" id="user"><input name="pass" id="pass" type="password"><button type="submit" id="go">Sign in</button></form>`));
    }
    if (path === '/secret') {
      const ok = /session=ok/.test(req.headers.cookie ?? '');
      return ok ? send(layout('Secret', '<h1 class="secret">Welcome admin</h1>')) : send(layout('Denied', '<h1>Denied</h1>'), 403);
    }
    if (path === '/blocked') return send('<html><head><title>Just a moment...</title></head><body><div id="cf-browser-verification">Checking your browser</div></body></html>', 503);
    if (path === '/flaky') { const n = hits.filter((h) => h === '/flaky').length; return n < 3 ? send('boom', 500) : send(layout('OK', '<p class="ok">finally</p>')); }
    // "bot wall": the first hit of each botwall URL is rejected with 503 (like Amazon throttling plain HTTP clients)
    if (path.startsWith('/botwall')) { const n = hits.filter((h) => h === path).length; return n < 2 ? send('<html><title>Sorry! Something went wrong!</title><body>Enter the characters you see below</body></html>', 503) : send(layout('Wall', `<div class="item">passed ${path}</div>`)); }
    if (path === '/redirect') { res.writeHead(302, { location: '/products?page=2' }); return res.end(); }
    if (path === '/cookies') return send(layout('Cookies', `<pre id="c">${(req.headers.cookie ?? '').replace(/</g, '&lt;')}</pre>`));
    if (path === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('User-agent: *\nDisallow: /secret\n'); }
    if (path.startsWith('/img/')) { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9])); }
    if (path === '/post') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { const params = new URLSearchParams(body); send(layout('POST', `<div class="echo">${params.get('term') ?? ''}</div>`)); });
      return;
    }
    send(layout('404', '<h1>Not found</h1>'), 404);
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}`, hits, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

export const FIXTURE_PRODUCT_COUNT = PRODUCTS.length;
