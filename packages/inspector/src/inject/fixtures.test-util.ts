/** Shared synthetic pages for the inspector tests (jsdom, no layout). */

export function productGrid(opts: { count?: number; adAt?: number; generated?: boolean } = {}): string {
  const count = opts.count ?? 8;
  const cards: string[] = [];
  for (let i = 1; i <= count; i++) {
    if (opts.adAt === i) {
      cards.push(`<li class="col-md-3 ad-slot"><div class="ad-banner"><a href="https://ads.example/x"><img src="/ads/banner.png" alt="Ad"></a><span class="sponsored">Sponsored</span></div></li>`);
    }
    const gen = opts.generated ? ` css-1x2y3z sc-bdVaJa _3kXq9` : '';
    cards.push(`<li class="col-md-3">
      <article class="product_pod${gen}" data-sku="SKU-${i}">
        <div class="image_container"><a href="/catalogue/book-${i}"><img class="thumbnail" src="/media/book-${i}.jpg" alt="Book ${i}"></a></div>
        <p class="star-rating Three"><i class="icon-star"></i><i class="icon-star"></i><i class="icon-star"></i><i class="icon-star"></i><i class="icon-star"></i></p>
        <h3><a href="/catalogue/book-${i}" title="Book title ${i}">Book title ${i}</a></h3>
        <div class="product_price">
          <p class="price_color">£${(10 + i * 3.5).toFixed(2)}</p>
          <p class="instock availability"><i class="icon-ok"></i> In stock</p>
          <form><button type="submit" class="btn btn-primary">Add to basket</button></form>
        </div>
        <p class="author">Author ${i % 3 === 0 ? 'Smith' : 'Doe ' + i}</p>
        <time datetime="2024-0${(i % 9) + 1}-15">Jan ${i}, 2024</time>
      </article>
    </li>`);
  }
  return `<!doctype html><html><head><title>Grid</title></head><body>
  <header id="site-header"><nav><ul class="menu"><li><a href="/">Home</a></li><li><a href="/about">About</a></li><li><a href="/contact">Contact</a></li></ul></nav></header>
  <main>
    <section class="catalogue">
      <h1 class="page-title">Books</h1>
      <ol class="row" id="product-list">${cards.join('\n')}</ol>
      <ul class="pager"><li class="next"><a href="page-2.html">next</a></li></ul>
    </section>
    <aside id="sidebar"><div class="promo">Promo text</div></aside>
  </main>
  <footer><p>Copyright</p></footer>
</body></html>`;
}

export function loadHtml(html: string, url = 'https://site.test/catalogue/page-1.html'): Document {
  document.open();
  document.write(html);
  document.close();
  try {
    // jsdom: baseURI follows <base>; provide one so relative hrefs resolve
    const base = document.createElement('base');
    base.href = url;
    document.head.appendChild(base);
  } catch {
    /* ignore */
  }
  return document;
}
