process.env.JWT_ACCESS_SECRET = 'test_secret_receipt_token';
process.env.JWT_ACCESS_EXPIRES_IN = '15m';

const { signReceiptDownloadToken, verifyReceiptDownloadToken } = require('../../src/modules/payments/receiptToken.util');
const { signAccessToken, verifyAccessToken } = require('../../src/utils/jwt');

describe('signReceiptDownloadToken / verifyReceiptDownloadToken', () => {
  test('un token signé se vérifie et contient bien le transactionId', () => {
    const token = signReceiptDownloadToken('user-1', 'tx-42');
    const payload = verifyReceiptDownloadToken(token);
    expect(payload.sub).toBe('user-1');
    expect(payload.transactionId).toBe('tx-42');
  });

  test('un token de téléchargement de reçu ne peut JAMAIS être accepté comme token de session normal', () => {
    const receiptToken = signReceiptDownloadToken('user-1', 'tx-42');
    // verifyAccessToken (utilisé par requireAuth pour TOUTES les routes
    // protégées de l'app) doit rejeter ce token à cause de l'audience
    // différente - même signé avec le même secret.
    expect(() => verifyAccessToken(receiptToken)).toThrow();
  });

  test('un token de session normal ne peut pas être réutilisé comme lien de téléchargement de reçu', () => {
    const sessionToken = signAccessToken({ id: 'user-1', phone: '+224620000000' });
    expect(() => verifyReceiptDownloadToken(sessionToken)).toThrow();
  });
});
