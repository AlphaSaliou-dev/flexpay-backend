const paymentLinksService = require('./paymentLinks.service');
const { logError } = require('../../utils/logger');

function handle(serviceFn) {
  return async (req, res) => {
    try {
      const result = await serviceFn(req);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof paymentLinksService.PaymentLinkError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      // payBusiness (réutilisé par payViaLink) lève un PaymentError distinct.
      if (err.statusCode && err.message) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      logError('paymentLinks', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  };
}

const create = handle((req) => paymentLinksService.createPaymentLink(req.user.id, req.body));
const list = handle((req) => paymentLinksService.listPaymentLinksForBusiness(req.user.id));
const toggle = handle((req) => paymentLinksService.toggleActive(req.user.id, req.params.id, req.body.active));
const reactivate = handle((req) => paymentLinksService.reactivate(req.user.id, req.params.id));
const getPublic = handle((req) => paymentLinksService.getPublicLinkInfo(req.params.code));

const pay = handle(async (req) => {
  const { idempotencyKey, customFields } = req.body;
  const result = await paymentLinksService.payViaLink(req.user.id, req.params.code, {
    idempotencyKey,
    customFields,
  });
  return {
    status: 'COMPLETED',
    amountPaid: result.amountPaid,
    feeCharged: result.feeAmount,
    transactionId: result.payment.id,
  };
});

const payMobileMoney = handle(async (req) => {
  const { phone, provider, idempotencyKey, customFields } = req.body;
  const result = await paymentLinksService.payViaLinkMobileMoney(req.params.code, {
    phone,
    provider,
    idempotencyKey,
    customFields,
  });
  return {
    status: 'COMPLETED',
    amountPaid: result.amountPaid,
    feeCharged: result.feeAmount,
    transactionId: result.payment.id,
  };
});

module.exports = { create, list, toggle, reactivate, getPublic, pay, payMobileMoney };
