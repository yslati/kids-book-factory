// Shopify custom pixel for the #events channel and its daily summary.
//
// Install: Shopify admin → Settings → Customer events → Add custom pixel,
// name it "Discord events", paste this file, set Customer privacy →
// Permission to "Not required" (so every visitor is tracked), Save, Connect.
//
// Sends page, product and collection views, searches, cart views,
// add-to-carts, checkout starts and orders to the backend's /events
// (api/events.js). Only paths, campaign tags, titles, prices and quantities
// leave the pixel: never customer details, other query parameters or line
// item properties, which carry the child's name.

const ENDPOINT = 'https://kids-book-factory.vercel.app/events';

// Campaign tags and ad click ids; must match SOURCE_PARAMS in lib/traffic-source.js.
const SOURCE_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'gbraid', 'wbraid', 'fbclid', 'ttclid', 'msclkid', 'epik', 'sccid', 'twclid', 'li_fat_id'];

function money(value) {
  return value ? { amount: Number(value.amount), currency: value.currencyCode } : null;
}

function base(event) {
  const location = event.context.document.location;
  const query = new URLSearchParams(location.search);
  const params = {};
  for (const key of SOURCE_PARAMS) {
    const value = query.get(key);
    if (value) params[key] = value.slice(0, 100);
  }
  return { event: event.name, clientId: event.clientId, path: location.pathname, params, referrer: event.context.document.referrer };
}

// A string body goes as text/plain, so the request needs no CORS preflight.
function send(payload) {
  fetch(ENDPOINT, { method: 'POST', body: JSON.stringify(payload), keepalive: true, mode: 'no-cors' }).catch(() => {});
}

function withCheckout(event) {
  const checkout = event.data.checkout;
  return {
    ...base(event),
    checkout: {
      orderId: checkout.order ? checkout.order.id : null,
      firstOrder: checkout.order && checkout.order.customer ? checkout.order.customer.isFirstOrder : null,
      total: money(checkout.totalPrice),
      items: (checkout.lineItems || []).map((item) => ({
        title: item.title,
        variant: item.variant ? item.variant.title : null,
        quantity: item.quantity,
        price: item.variant ? money(item.variant.price) : null
      })),
      discounts: (checkout.discountApplications || []).filter((d) => d.type === 'DISCOUNT_CODE').map((d) => d.title)
    }
  };
}

analytics.subscribe('page_viewed', (event) => send(base(event)));
analytics.subscribe('collection_viewed', (event) => send(base(event)));
analytics.subscribe('search_submitted', (event) => send(base(event)));
analytics.subscribe('cart_viewed', (event) => send(base(event)));

analytics.subscribe('product_viewed', (event) => {
  const variant = event.data.productVariant;
  send({ ...base(event), product: { title: variant.product.title, variant: variant.title, price: money(variant.price) } });
});

analytics.subscribe('product_added_to_cart', (event) => {
  const line = event.data.cartLine;
  if (!line) return;
  send({
    ...base(event),
    product: {
      title: line.merchandise.product.title,
      variant: line.merchandise.title,
      price: money(line.merchandise.price),
      quantity: line.quantity,
      total: money(line.cost.totalAmount)
    }
  });
});

analytics.subscribe('checkout_started', (event) => send(withCheckout(event)));
analytics.subscribe('checkout_completed', (event) => send(withCheckout(event)));
