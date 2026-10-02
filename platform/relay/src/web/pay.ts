import { Router } from 'express';
import { requirePageSession } from '../auth/sessions.js';
import { razorpayKeyId } from '../billing/razorpay.js';
import { mongoCollections } from '../mongoCollections.js';
import { page, renderTemplate } from './layout.js';

const router = Router();
export const payPageRouter = router;

/**
 * Razorpay's own hosted page takes no success/cancel URL, so paying there would leave the
 * customer stranded on Razorpay with no way back. This page stands in for it: it opens
 * Razorpay Checkout against the subscription we already created, then returns the customer
 * to /home (or /team) afterwards.
 *
 * It grants nothing. Entitlement still comes only from the subscription.activated webhook Ã¢â‚¬â€
 * this page just carries the browser back, and the destination page reads the real state.
 */
router.get('/pay/razorpay/:subscriptionId', requirePageSession, async (req, res) => {
  const subscriptionId = req.params.subscriptionId;
  // Razorpay subscription ids are sub_<alphanumeric>; reject anything else rather than
  // reflecting arbitrary input into the page.
  if (!/^sub_[A-Za-z0-9]+$/.test(subscriptionId)) {
    res.status(400).send('Invalid subscription reference');
    return;
  }

  // A subscription has no local license row until its activation webhook lands, so ownership
  // is checked against the buyer recorded at checkout (see db.ts's razorpay_checkouts).
  // Without this, any signed-in user who learned a subscription id could open a payment
  // modal prefilled with that customer's contact details.
  const checkout = await mongoCollections.razorpay_checkouts.findOne({ subscription_id: subscriptionId });
  if (checkout?.user_id !== req.user!.id) {
    res.status(404).send('Subscription not found');
    return;
  }

  const returnTo = req.query.returnTo === 'team' ? '/team' : '/home';

  res.type('html').send(
    page(
      'Complete your payment',
      renderTemplate('pay-razorpay', {
        RAZORPAY_KEY_ID: razorpayKeyId(),
        SUBSCRIPTION_ID: subscriptionId,
        RETURN_TO: returnTo,
      }),
      returnTo,
    ),
  );
});
