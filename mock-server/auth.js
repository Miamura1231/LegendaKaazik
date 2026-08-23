// Хеширование и проверка паролей (этап 1).
//
// Используется bcryptjs вместо нативного bcrypt: чистый JavaScript
// без компиляции — одинаково ставится на Windows-машину разработчика
// и на VPS, где может не оказаться сборочного тулчейна.
//
// Синхронные методы (hashSync/compareSync) выбраны сознательно:
// весь сервер построен на синхронном стиле ради better-sqlite3,
// а стоимость хеширования (~50–100 мс) приемлема для логина.

const bcrypt = require("bcryptjs");

// Стоимость хеширования. 10 — стандартный компромисс
// между стойкостью и задержкой ответа на логин
const BCRYPT_COST = 10;

// Создать bcrypt-хеш из открытого пароля
function hashPassword(plain) {
  return bcrypt.hashSync(plain, BCRYPT_COST);
}

// Похоже ли значение на bcrypt-хеш ($2a$/$2b$/$2y$ — префиксы алгоритма).
// Нужно для ленивой миграции: записи, созданные на этапе 0,
// хранили пароль открытым текстом в той же колонке password_hash
function isBcryptHash(value) {
  return typeof value === "string" && /^\$2[aby]\$/.test(value);
}

// Проверить пароль пользователя против того, что лежит в БД.
//
// Два режима:
//  * запись старая (открытый пароль) — прямое сравнение строк;
//  * запись новая (bcrypt-хеш) — штатная проверка bcrypt.
//
// После успешного входа со старой записью вызывающий код обязан
// перезаписать пароль хешем (см. /api/auth/login в server.js):
// так вся база мигрирует на хеши сама собой, без отдельного скрипта.
function verifyPassword(storedValue, plain) {
  if (!isBcryptHash(storedValue)) {
    return storedValue === plain;
  }

  try {
    return bcrypt.compareSync(plain, storedValue);
  } catch {
    // Повреждённый хеш трактуем как неверный пароль,
    // чтобы не ронять запрос исключением
    return false;
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  isBcryptHash,
};
