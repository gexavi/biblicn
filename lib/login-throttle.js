// Anti-bruteforce sur /api/login (voir server.js) : compteur d'échecs par IP
// en mémoire, avec blocage temporaire après trop de tentatives. Extrait dans
// son propre module pour pouvoir être testé sans horloge réelle (voir
// test/login-throttle.test.js) : l'horloge est injectable via `now`.
function createLoginThrottle({ maxAttempts = 5, lockoutMs = 5 * 60 * 1000, now = Date.now } = {}) {
  const attempts = new Map(); // ip -> { count, lockedUntil, lastAttempt }

  function checkLockout(ip) {
    const attempt = attempts.get(ip);
    if (!attempt || attempt.lockedUntil <= now()) return 0;
    return attempt.lockedUntil - now();
  }

  function registerFailure(ip) {
    const attempt = attempts.get(ip) || { count: 0, lockedUntil: 0, lastAttempt: 0 };
    attempt.count++;
    attempt.lastAttempt = now();
    if (attempt.count >= maxAttempts) {
      attempt.lockedUntil = now() + lockoutMs;
      attempt.count = 0;
    }
    attempts.set(ip, attempt);
  }

  function clearFailures(ip) {
    attempts.delete(ip);
  }

  // Purge les entrées inactives depuis plus de `maxAgeMs`, pour éviter une
  // croissance illimitée de la map si des IP variées tentent de se connecter.
  function prune(maxAgeMs) {
    const t = now();
    for (const [ip, attempt] of attempts) {
      if (attempt.lockedUntil < t && t - attempt.lastAttempt > maxAgeMs) {
        attempts.delete(ip);
      }
    }
  }

  function size() {
    return attempts.size;
  }

  return { checkLockout, registerFailure, clearFailures, prune, size };
}

module.exports = { createLoginThrottle };
