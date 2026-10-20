const express = require('express');
const request = require('supertest');
const rateLimit = require('express-rate-limit');

// Test isolé, volontairement indépendant du skip global "NODE_ENV===test"
// (voir rateLimiter.js) : on construit ici une mini-app avec le même
// comportement de limite, mais sans le skip, pour prouver que le
// mécanisme lui-même bloque bien après le seuil configuré.
function buildAppWithLimiter(max) {
  const app = express();
  const limiter = rateLimit({
    windowMs: 60_000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    // Pas de `skip` ici : on veut le comportement réel, sans contournement.
  });
  app.get('/limited', limiter, (req, res) => res.json({ ok: true }));
  return app;
}

describe('express-rate-limit (comportement réel, non testé via l\'app principale)', () => {
  test('autorise les requêtes sous le seuil, puis bloque au-delà', async () => {
    const app = buildAppWithLimiter(3);

    const first = await request(app).get('/limited');
    const second = await request(app).get('/limited');
    const third = await request(app).get('/limited');
    const fourth = await request(app).get('/limited');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);
    expect(fourth.status).toBe(429);
  });
});

// Même approche que ci-dessus : une vraie mini-app, sans le skip de test,
// pour prouver le comportement réel du limiteur partenaire - en
// particulier son point le plus important : la clé de comptage est la
// clé API elle-même, jamais l'adresse IP.
function buildApiPartnerLimiterApp(max) {
  const rateLimit = require('express-rate-limit');
  const app = express();

  // Simule ce que requireApiKey ferait normalement : renseigner
  // req.apiClient à partir d'un en-tête, avant que le limiteur ne tourne.
  app.use((req, res, next) => {
    req.apiClient = { id: req.headers['x-fake-client-id'], environment: req.headers['x-fake-env'] || 'LIVE' };
    next();
  });

  const limiter = rateLimit({
    windowMs: 60_000,
    max: max || ((req) => (req.apiClient?.environment === 'TEST' ? 5 : 2)),
    keyGenerator: (req) => req.apiClient?.id || req.ip,
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.get('/limited', limiter, (req, res) => res.json({ ok: true }));
  return app;
}

describe('apiPartnerLimiter - clé par partenaire, jamais par IP', () => {
  test('deux clients API différents ont chacun leur propre quota indépendant', async () => {
    const app = buildApiPartnerLimiterApp(2);

    // Client A épuise son quota (2 requêtes autorisées, la 3e bloquée)
    await request(app).get('/limited').set('x-fake-client-id', 'client-A');
    await request(app).get('/limited').set('x-fake-client-id', 'client-A');
    const clientABlocked = await request(app).get('/limited').set('x-fake-client-id', 'client-A');
    expect(clientABlocked.status).toBe(429);

    // Client B n'est jamais affecté par l'épuisement du quota de A,
    // même si les deux requêtes viennent de la même IP de test.
    const clientBFirst = await request(app).get('/limited').set('x-fake-client-id', 'client-B');
    expect(clientBFirst.status).toBe(200);
  });

  test('un client TEST a un plafond plus généreux qu\'un client LIVE', async () => {
    const app = buildApiPartnerLimiterApp();

    // Client LIVE : plafond de 2 dans ce test - la 3e requête est bloquée.
    await request(app).get('/limited').set('x-fake-client-id', 'live-client').set('x-fake-env', 'LIVE');
    await request(app).get('/limited').set('x-fake-client-id', 'live-client').set('x-fake-env', 'LIVE');
    const liveBlocked = await request(app).get('/limited').set('x-fake-client-id', 'live-client').set('x-fake-env', 'LIVE');
    expect(liveBlocked.status).toBe(429);

    // Client TEST : plafond de 5 - la 3e requête passe encore, contrairement à LIVE.
    await request(app).get('/limited').set('x-fake-client-id', 'test-client').set('x-fake-env', 'TEST');
    await request(app).get('/limited').set('x-fake-client-id', 'test-client').set('x-fake-env', 'TEST');
    const testStillOk = await request(app).get('/limited').set('x-fake-client-id', 'test-client').set('x-fake-env', 'TEST');
    expect(testStillOk.status).toBe(200);
  });
});
