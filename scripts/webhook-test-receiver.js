// Petit serveur local pour TESTER la réception de webhooks FlexPay, sans
// rien exposer publiquement : FlexPay (sur la même machine) appelle
// directement http://localhost:<port>, aucun tunnel nécessaire.
//
// Usage : node scripts/webhook-test-receiver.js [port]
// Puis configure cette URL comme webhookUrl de ta clé API de test.
const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.argv[2] || 4100);

// Collé depuis la réponse de self-service-test-key / download-link - sert
// uniquement à vérifier que la signature reçue est authentique, comme le
// ferait le vrai serveur du partenaire.
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

function verifySignature(rawBody, signatureHeader) {
  if (!WEBHOOK_SECRET || !signatureHeader) return null;
  const expected = `sha256=${crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex')}`;
  return signatureHeader === expected;
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const event = req.headers['x-flexpay-event'];
    const signature = req.headers['x-flexpay-signature'];
    const valid = verifySignature(body, signature);

    console.log('\n=== Webhook reçu ===');
    console.log('Événement :', event);
    console.log('Signature valide :', valid === null ? 'non vérifiée (WEBHOOK_SECRET non fourni)' : valid);
    console.log('Payload :', JSON.stringify(JSON.parse(body || '{}'), null, 2));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ received: true }));
  });
});

server.listen(PORT, () => {
  console.log(`Récepteur de webhook de test à l'écoute sur http://localhost:${PORT}`);
  console.log('Configure cette URL comme webhookUrl de ta clé API, puis déclenche un événement (ex: test-resolve un intent).');
});
