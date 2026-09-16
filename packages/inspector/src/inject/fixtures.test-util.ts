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

/**
 * Amazon-like search results: 12 cards with `h2[aria-label] > a > span` titles, a hidden
 * `.a-offscreen` price next to split whole/decimal/fraction spans, a strike-through list price on
 * some cards, 2 sponsored cards with an extra badge block, varying grid utility classes, and a
 * pagination strip whose "next" link carries a digit-bearing aria-label.
 */
export function amazonResults(opts: { count?: number; sponsoredAt?: number[]; deep?: boolean; linkWrapsHeading?: boolean } = {}): string {
  const count = opts.count ?? 12;
  const sponsored = new Set(opts.sponsoredAt ?? [3, 8]);
  // `deep`: 8 extra anonymous wrappers around the card body (real cards nest the price ~18 levels deep);
  // `linkWrapsHeading`: current markup `a > h2 > span` and a `celwidget` div whose single span wraps blocks
  const deepOpen = opts.deep ? '<div class="a-section"><div><div class="puis-card-border"><div><div class="a-section"><div><div class="s-card-dropdown-container"><div>' : '';
  const deepClose = opts.deep ? '</div></div></div></div></div></div></div></div>' : '';
  const cards: string[] = [];
  for (let i = 1; i <= count; i++) {
    const whole = 19 + i * 5;
    const price = `$${whole}.99`;
    const list = i % 3 === 0 ? `<span class="a-size-base a-color-secondary">List: <span class="a-price a-text-price" data-a-strike="true"><span class="a-offscreen">$${whole + 20}.99</span><span aria-hidden="true">$${whole + 20}.99</span></span></span>` : '';
    const grid = i % 2 ? 'sg-col-4-of-24 sg-col-4-of-12 s-result-item s-asin sg-col-4-of-16 sg-col sg-col-4-of-20' : 'sg-col-4-of-24 sg-col-4-of-12 s-result-item s-asin sg-col sg-col-4-of-20 sg-col-4-of-32';
    const badge = sponsored.has(i) ? `<div class="a-row a-spacing-micro"><div class="a-section a-spacing-none puis-label-popover"><span class="puis-label-popover-default"><span class="a-color-secondary">Sponsored</span></span><span class="aok-inline-block puis-sponsored-label-info-icon"></span></div></div>` : '';
    cards.push(`<div class="${grid}" data-component-type="s-search-result" data-asin="B0${String(i).padStart(3, '0')}XYZ" data-index="${i - 1}">
      <div class="sg-col-inner"><div class="s-widget-container s-spacing-small s-widget-container-height-small"><div class="puis-card-container s-card-container s-overflow-hidden">
        <div class="a-section a-spacing-base">
          <div class="s-product-image-container aok-relative"><span data-component-type="s-product-image"><a class="a-link-normal s-no-outline" href="/dp/B0${i}"><div class="a-section aok-relative s-image-square-aspect"><img class="s-image" src="https://m.media-amazon.com/images/I/img${i}.jpg" alt="Wireless Headphones ${i}"></div></a></span></div>
          ${opts.linkWrapsHeading ? '<div class="a-section celwidget" data-csa-c-type="item"><span data-component-type="s-product-body">' : ''}${deepOpen}<div class="a-section a-spacing-small puis-padding-left-small puis-padding-right-small">
            ${badge}
            <div class="a-section a-spacing-none a-spacing-top-small s-title-instructions-style">
              ${opts.linkWrapsHeading
                ? `<a class="a-link-normal s-line-clamp-2 s-link-style a-text-normal" href="/dp/B0${i}"><h2 class="a-size-base-plus a-spacing-none a-color-base a-text-normal"><span>Wireless Headphones ${i} Bluetooth Over Ear</span></h2></a>`
                : `<h2 class="a-size-mini a-spacing-none a-color-base s-line-clamp-2" aria-label="Wireless Headphones ${i} Bluetooth Over Ear"><a class="a-link-normal s-underline-text s-underline-link-text s-link-style a-text-normal" href="/dp/B0${i}"><span class="a-size-base-plus a-color-base a-text-normal">Wireless Headphones ${i} Bluetooth Over Ear</span></a></h2>`}
            </div>
            <div class="a-section a-spacing-none a-spacing-top-micro"><div class="a-row a-size-small"><span aria-label="4.${i % 5} out of 5 stars"><span class="a-icon-alt">4.${i % 5} out of 5 stars</span></span><span aria-label="${i * 137} ratings"><a class="a-link-normal s-underline-text" href="/dp/B0${i}#customerReviews"><span class="a-size-base s-underline-text">${i * 137}</span></a></span></div></div>
            <div class="a-section a-spacing-none a-spacing-top-small s-price-instructions-style">
              <div class="a-row a-size-base a-color-base"><div class="a-row"><a class="a-size-base a-link-normal s-no-hover s-underline-text s-underline-link-text s-link-style a-text-normal" href="/dp/B0${i}#price"><span class="a-price" data-a-size="xl" data-a-color="base"><span class="a-offscreen">${price}</span><span aria-hidden="true"><span class="a-price-symbol">$</span><span class="a-price-whole">${whole}<span class="a-price-decimal">.</span></span><span class="a-price-fraction">99</span></span></span>${list}</a></div></div>
              <div class="a-row a-size-base a-color-secondary"><span class="a-color-base">FREE delivery <span class="a-text-bold">Tue, Sep 22</span></span></div>
            </div>
          </div>${deepClose}${opts.linkWrapsHeading ? '</span></div>' : ''}
        </div>
      </div></div></div>
    </div>`);
  }
  const pages = [2, 3, 4].map((p) => `<a class="s-pagination-item s-pagination-button" href="/s?k=wireless+headphones&page=${p}" aria-label="Go to page ${p}">${p}</a>`).join('');
  return `<!doctype html><html><head><title>Amazon.com : wireless headphones</title></head><body>
  <header id="nav-belt"><a id="nav-logo" href="/">Amazon</a><form><input id="twotabsearchtextbox" name="field-keywords" value="wireless headphones"></form></header>
  <div class="s-desktop-width-max s-desktop-content">
    <div class="s-main-slot s-result-list s-search-results sg-row">
      <div class="s-result-item s-widget s-widget-spacing-small" data-component-type="s-searchgrid-carousel"><div class="a-section"><h2 class="a-size-base">Results</h2><span class="a-color-secondary">Check each product page for other buying options.</span></div></div>
      ${cards.join('\n')}
      <div class="s-result-item s-flex-full-width s-widget-spacing-small" data-component-type="s-pagination"><div class="s-pagination-container"><span class="s-pagination-strip">
        <span class="s-pagination-item s-pagination-previous s-pagination-disabled" aria-disabled="true">Previous</span>
        <span class="s-pagination-item s-pagination-selected" aria-label="Current page, page 1">1</span>
        ${pages}
        <a class="s-pagination-item s-pagination-next s-pagination-button s-pagination-button-accessibility s-pagination-separator" href="/s?k=wireless+headphones&page=2" aria-label="Go to next page, page 2">Next</a>
      </span></div></div>
    </div>
  </div>
  <footer id="navFooter"><a href="/help">Help</a></footer>
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
