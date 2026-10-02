import type { SimulatedCheckoutSession } from '../billing/stripe-sim.js';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]!);
}

export function renderDemoCheckoutPage(session: SimulatedCheckoutSession, nonce: string): string {
  const safeSessionId = escapeHtml(session.id);
  const safeSuccessUrl = escapeHtml(session.success_url);
  const total = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: session.currency.toUpperCase(),
  }).format((session.unit_amount * session.quantity) / 100);
  const isTeamPurchase = session.metadata?.fk_purchase === 'org';
  const productName = isTeamPurchase ? 'FocusKube Team' : session.product_name;

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Demo Checkout - FocusKube</title>
      <style nonce="${nonce}">
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 40px; max-width: 500px; }
        .card { border: 1px solid #ddd; border-radius: 8px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        .price { font-size: 32px; font-weight: bold; margin: 16px 0; }
        .details { color: #666; margin: 16px 0; }
        button { background: #007AFF; color: white; border: none; padding: 12px 24px; border-radius: 6px; font-size: 16px; cursor: pointer; width: 100%; }
        button:hover { background: #0051D5; }
        button:disabled { opacity: 0.65; cursor: wait; }
        .footer { text-align: center; color: #999; font-size: 12px; margin-top: 16px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>Confirm Purchase</h1>
        <p class="details"><strong>Email:</strong> ${escapeHtml(session.customer_email)}</p>
        <p class="details"><strong>Plan:</strong> ${escapeHtml(productName)}</p>
        ${isTeamPurchase ? `<p class="details"><strong>Seats:</strong> ${session.quantity}</p>` : ''}
        <p class="details"><strong>Billing:</strong> ${session.billing_interval === 'year' ? 'Annually' : 'Monthly'}</p>
        <div class="price">${total}/${session.billing_interval === 'year' ? 'year' : 'month'}</div>
        <button id="complete-purchase" type="button" data-session-id="${safeSessionId}" data-success-url="${safeSuccessUrl}">Complete Purchase</button>
        <div class="footer">This is a demo checkout; no real charge will be made.</div>
      </div>
      <script nonce="${nonce}">
        const button = document.getElementById('complete-purchase');
        button.addEventListener('click', async () => {
          button.disabled = true;
          button.textContent = 'Processing...';
          try {
            const response = await fetch('/v1/dev/stripe/webhook/checkout-completed', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionId: button.dataset.sessionId })
            });
            if (!response.ok) throw new Error('Error completing purchase');
            window.location.href = button.dataset.successUrl;
          } catch (error) {
            alert(error.message);
            button.disabled = false;
            button.textContent = 'Complete Purchase';
          }
        });
      </script>
    </body>
    </html>
  `;
}