// Защита платёжного эндпоинта /api/minecraft/payment (этап 2).
//
// ТЕКУЩАЯ РЕАЛИЗАЦИЯ — ЗАГЛУШКА, как и было запланировано:
// Fabric-считыватель передаёт общий секретный ключ в заголовке
// x-payment-key, сервер сверяет его с ожидаемым значением.
//
// TODO (апгрейд до полноценной защиты, когда понадобится):
//   перейти на HMAC-подпись тела запроса:
//     * считыватель считает signature = HMAC-SHA256(secret, rawBody),
//       шлёт её в заголовке x-payment-signature вместе с timestamp;
//     * сервер пересчитывает подпись над ПОЛУЧЕННЫМ телом и сравнивает
//       (timing-safe), отклоняя запросы с timestamp старше ~5 минут;
//   это защитит от подделки тела запроса и от replay-атак, а секретный
//   ключ перестанет передаваться в каждом запросе открытым текстом.
//
// Ключ задаётся переменной окружения PAYMENT_SECRET. Значение по
// умолчанию годится ТОЛЬКО для локальной разработки — на VPS
// обязательно выставить свой длинный случайный ключ, например:
//   PAYMENT_SECRET=$(openssl rand -hex 32) node server.js

const crypto = require("crypto");

// Секретный ключ: переменная окружения или значение для разработки
const PAYMENT_SECRET =
  process.env.PAYMENT_SECRET || "dev-only-secret-change-on-vps";

// Имя заголовка, в котором считыватель передаёт ключ
const PAYMENT_KEY_HEADER = "x-payment-key";

// Проверить секретный ключ запроса.
//
// Сравнение через crypto.timingSafeEqual занимает одинаковое время
// независимо от того, сколько символов ключа совпало, — по задержкам
// ответа нельзя подобрать ключ посимвольно.
function verifyPaymentRequest(req) {
  const provided = req.headers[PAYMENT_KEY_HEADER];

  if (typeof provided !== "string" || provided === "") {
    return false;
  }

  const expected = Buffer.from(PAYMENT_SECRET, "utf8");
  const actual = Buffer.from(provided, "utf8");

  // Разная длина — точно не совпадают. Отдельная проверка нужна,
  // потому что timingSafeEqual требует буферы равной длины
  if (expected.length !== actual.length) {
    return false;
  }

  return crypto.timingSafeEqual(expected, actual);
}

module.exports = {
  PAYMENT_SECRET,
  PAYMENT_KEY_HEADER,
  verifyPaymentRequest,
};
