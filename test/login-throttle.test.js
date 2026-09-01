const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLoginThrottle } = require('../lib/login-throttle');

// Horloge factice pour des tests déterministes (pas de vrai setTimeout/Date.now).
function fakeClock(start = 0) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

test('checkLockout renvoie 0 pour une IP jamais vue', () => {
  const throttle = createLoginThrottle();
  assert.equal(throttle.checkLockout('1.2.3.4'), 0);
});

test('checkLockout reste à 0 tant que le nombre d\'échecs n\'atteint pas maxAttempts', () => {
  const throttle = createLoginThrottle({ maxAttempts: 5 });
  for (let i = 0; i < 4; i++) throttle.registerFailure('1.2.3.4');
  assert.equal(throttle.checkLockout('1.2.3.4'), 0);
});

test('registerFailure bloque l\'IP après maxAttempts échecs consécutifs', () => {
  const now = fakeClock();
  const throttle = createLoginThrottle({ maxAttempts: 5, lockoutMs: 60000, now });
  for (let i = 0; i < 5; i++) throttle.registerFailure('1.2.3.4');
  assert.equal(throttle.checkLockout('1.2.3.4'), 60000);
});

test('le blocage expire après lockoutMs', () => {
  const now = fakeClock();
  const throttle = createLoginThrottle({ maxAttempts: 5, lockoutMs: 60000, now });
  for (let i = 0; i < 5; i++) throttle.registerFailure('1.2.3.4');
  now.advance(60001);
  assert.equal(throttle.checkLockout('1.2.3.4'), 0);
});

test('checkLockout renvoie le temps restant, pas juste un booléen', () => {
  const now = fakeClock();
  const throttle = createLoginThrottle({ maxAttempts: 5, lockoutMs: 60000, now });
  for (let i = 0; i < 5; i++) throttle.registerFailure('1.2.3.4');
  now.advance(20000);
  assert.equal(throttle.checkLockout('1.2.3.4'), 40000);
});

test('clearFailures réinitialise le compteur (ex. connexion réussie)', () => {
  const throttle = createLoginThrottle({ maxAttempts: 5 });
  for (let i = 0; i < 4; i++) throttle.registerFailure('1.2.3.4');
  throttle.clearFailures('1.2.3.4');
  // Un 5e échec après la remise à zéro ne doit pas suffire à bloquer.
  throttle.registerFailure('1.2.3.4');
  assert.equal(throttle.checkLockout('1.2.3.4'), 0);
});

test('les IP sont suivies indépendamment', () => {
  const throttle = createLoginThrottle({ maxAttempts: 3 });
  for (let i = 0; i < 3; i++) throttle.registerFailure('1.1.1.1');
  assert.ok(throttle.checkLockout('1.1.1.1') > 0);
  assert.equal(throttle.checkLockout('2.2.2.2'), 0);
});

test('après un blocage, le compteur d\'échecs repart de zéro (pas de blocage permanent immédiat)', () => {
  const now = fakeClock();
  const throttle = createLoginThrottle({ maxAttempts: 3, lockoutMs: 1000, now });
  for (let i = 0; i < 3; i++) throttle.registerFailure('1.2.3.4');
  now.advance(1001); // le blocage expire
  for (let i = 0; i < 2; i++) throttle.registerFailure('1.2.3.4');
  // Seulement 2 échecs depuis la remise à zéro : pas encore rebloqué.
  assert.equal(throttle.checkLockout('1.2.3.4'), 0);
  throttle.registerFailure('1.2.3.4'); // 3e échec de cette nouvelle série
  assert.ok(throttle.checkLockout('1.2.3.4') > 0);
});

test('prune retire les entrées inactives au-delà de maxAgeMs sans blocage actif', () => {
  const now = fakeClock();
  const throttle = createLoginThrottle({ maxAttempts: 5, now });
  throttle.registerFailure('1.2.3.4'); // 1 seul échec, jamais bloqué
  assert.equal(throttle.size(), 1);
  now.advance(2 * 60 * 60 * 1000);
  throttle.prune(60 * 60 * 1000);
  assert.equal(throttle.size(), 0);
});

test('prune conserve un blocage encore actif même si ancien', () => {
  const now = fakeClock();
  const throttle = createLoginThrottle({ maxAttempts: 1, lockoutMs: 3 * 60 * 60 * 1000, now });
  throttle.registerFailure('1.2.3.4'); // bloque immédiatement (maxAttempts=1)
  now.advance(2 * 60 * 60 * 1000); // toujours dans la fenêtre de blocage de 3h
  throttle.prune(60 * 60 * 1000);
  assert.equal(throttle.size(), 1);
  assert.ok(throttle.checkLockout('1.2.3.4') > 0);
});
