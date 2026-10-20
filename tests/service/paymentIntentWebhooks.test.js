const mockPrisma = {
  paymentIntent: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), findMany: jest.fn() },
  user: { findUnique: jest.fn() },
  apiClient: { findUnique: jest.fn() },
};
jest.mock('../../src/config/db', () => mockPrisma);

jest.mock('../../src/modules/wallet/limits.guard', () => ({ assertWithinLimits: jest.fn() }));
jest.mock('../../src/utils/otp', () => ({ sendOtpBySms: jest.fn() }));

const mockPayBusiness = jest.fn();
jest.mock('../../src/modules/payments/payments.service', () => ({
  payBusiness: (...args) => mockPayBusiness(...args),
  PaymentError: class PaymentError extends Error {
    constructor(message, statusCode = 400) {
      super(message);
      this.statusCode = statusCode;
    }
  },
}));

const mockDeliverWebhook = jest.fn();
jest.mock('../../src/modules/payments/webhook.service', () => ({
  deliverWebhook: (...args) => mockDeliverWebhook(...args),
}));

const intentService = require('../../src/modules/payments/paymentIntent.service');

function makeApiClient(overrides = {}) {
  return { id: 'client-1', name: 'MarketConnect', businessUserId: 'biz-1', environment: 'LIVE', webhookUrl: 'https://partner.example.com/hook', webhookSecret: 's3cr3t', ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('approveIntent - déclenche un webhook payment_intent.approved', () => {
  test('appelle deliverWebhook avec les bonnes données après approbation', async () => {
    mockPrisma.paymentIntent.findUnique.mockResolvedValue({
      id: 'i1', payerUserId: 'user-1', apiClientId: 'client-1', amount: 50000, reference: 'ref-1',
      status: 'PENDING_APPROVAL', expiresAt: new Date(Date.now() + 60000),
    });
    mockPrisma.apiClient.findUnique.mockResolvedValue(makeApiClient());
    mockPayBusiness.mockResolvedValue({ payment: { id: 'tx-1' }, feeAmount: 500 });
    mockPrisma.paymentIntent.update.mockResolvedValue({});

    await intentService.approveIntent('user-1', 'i1');

    expect(mockDeliverWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'client-1' }),
      'payment_intent.approved',
      expect.objectContaining({ intentId: 'i1', transactionId: 'tx-1' })
    );
  });
});

describe('rejectIntent - déclenche un webhook payment_intent.rejected', () => {
  test('appelle deliverWebhook après un rejet', async () => {
    mockPrisma.paymentIntent.findUnique.mockResolvedValue({
      id: 'i2', payerUserId: 'user-1', apiClientId: 'client-1', reference: 'ref-2', status: 'PENDING_APPROVAL',
    });
    mockPrisma.apiClient.findUnique.mockResolvedValue(makeApiClient());
    mockPrisma.paymentIntent.update.mockResolvedValue({});

    await intentService.rejectIntent('user-1', 'i2');

    expect(mockDeliverWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'client-1' }),
      'payment_intent.rejected',
      expect.objectContaining({ intentId: 'i2' })
    );
  });
});

describe('testResolveIntent - déclenche aussi un webhook, marqué test:true', () => {
  test('APPROVED déclenche payment_intent.approved avec test:true', async () => {
    const apiClient = makeApiClient({ environment: 'TEST' });
    mockPrisma.paymentIntent.findUnique.mockResolvedValue({
      id: 'i3', apiClientId: 'client-1', environment: 'TEST', status: 'PENDING_APPROVAL', amount: 1000, reference: null,
    });
    mockPrisma.paymentIntent.update.mockResolvedValue({});

    await intentService.testResolveIntent(apiClient, 'i3', 'APPROVED');

    expect(mockDeliverWebhook).toHaveBeenCalledWith(
      apiClient,
      'payment_intent.approved',
      expect.objectContaining({ intentId: 'i3', test: true })
    );
  });

  test('REJECTED déclenche payment_intent.rejected avec test:true', async () => {
    const apiClient = makeApiClient({ environment: 'TEST' });
    mockPrisma.paymentIntent.findUnique.mockResolvedValue({
      id: 'i4', apiClientId: 'client-1', environment: 'TEST', status: 'PENDING_APPROVAL', amount: 1000, reference: null,
    });
    mockPrisma.paymentIntent.update.mockResolvedValue({});

    await intentService.testResolveIntent(apiClient, 'i4', 'REJECTED');

    expect(mockDeliverWebhook).toHaveBeenCalledWith(
      apiClient,
      'payment_intent.rejected',
      expect.objectContaining({ intentId: 'i4', test: true })
    );
  });
});
