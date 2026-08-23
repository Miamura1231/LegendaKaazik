# Тестовый скрипт: создание/пополнение профиля игрока.
# Запуск из корня проекта:
#   powershell -ExecutionPolicy Bypass -File .\test-payment.ps1

$body = @{
    nickname   = "pes1398"
    amount     = 1000
    currency   = ""
    rawMessage = "1,000 has been received from DragonM0LL."
    eventId    = "test-1"
} | ConvertTo-Json

Invoke-RestMethod -Uri "http://localhost:3001/api/minecraft/payment" -Method POST -ContentType "application/json" -Body $body
