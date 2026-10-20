process.env.ENCRYPTION_KEY = 'f3183a33b18eba1cc2aec64d244bb24ff3149851254068695dbdbfefff297cde';

const { encrypt, decrypt } = require('../../src/utils/encryption');

describe('encrypt/decrypt', () => {
  test('round-trip : déchiffrer une valeur chiffrée renvoie le texte original', () => {
    const plaintext = 'whsec_abcdef0123456789';
    const encrypted = encrypt(plaintext);
    expect(decrypt(encrypted)).toBe(plaintext);
  });

  test('deux chiffrements du même texte produisent des résultats différents (IV aléatoire)', () => {
    const a = encrypt('même-secret');
    const b = encrypt('même-secret');
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe('même-secret');
    expect(decrypt(b)).toBe('même-secret');
  });

  test('le texte chiffré ne contient jamais le texte en clair', () => {
    const plaintext = 'whsec_ne-doit-jamais-apparaitre-en-clair';
    const encrypted = encrypt(plaintext);
    expect(encrypted).not.toContain(plaintext);
  });

  test('rejette une valeur altérée (authentification GCM) plutôt que de renvoyer n\'importe quoi', () => {
    const encrypted = encrypt('secret-original');
    const parts = encrypted.split(':');
    // On modifie un seul caractère du texte chiffré (dernier segment).
    const tampered = [parts[0], parts[1], parts[2].slice(0, -2) + (parts[2].slice(-2) === 'AA' ? 'BB' : 'AA')].join(':');
    expect(() => decrypt(tampered)).toThrow();
  });

  test('rejette une valeur malformée (pas le format iv:authTag:ciphertext)', () => {
    expect(() => decrypt('pas-du-tout-le-bon-format')).toThrow('malformée');
  });

  test('échoue clairement si ENCRYPTION_KEY est absent', () => {
    const saved = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    try {
      expect(() => encrypt('x')).toThrow('ENCRYPTION_KEY manquant');
    } finally {
      process.env.ENCRYPTION_KEY = saved;
    }
  });

  test('échoue clairement si ENCRYPTION_KEY n\'a pas la bonne longueur', () => {
    const saved = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = 'trop-court';
    try {
      expect(() => encrypt('x')).toThrow('32 octets');
    } finally {
      process.env.ENCRYPTION_KEY = saved;
    }
  });
});
