import os

FILES = [
    # Корневые конфиги фронтенда
    "frontend/package.json",
    "frontend/vite.config.ts",
    "frontend/tsconfig.json",
    "frontend/index.html",
    "frontend/src/main.tsx",
    "frontend/src/index.css",

    # Инфраструктура клиента
    "frontend/src/App.tsx",
    "frontend/src/api/types.ts",
    "frontend/src/api/client.ts",
    "frontend/src/store/authStore.ts",
    "frontend/src/network/types.ts",
    "frontend/src/network/socket.ts",

    # Общие компоненты
    "frontend/src/components/Navbar.tsx",
    "frontend/src/components/Toast.tsx",
    "frontend/src/components/ConfirmModal.tsx",
    "frontend/src/games/uno/CardComponent.tsx",

    # Страницы
    "frontend/src/pages/Login.tsx",
    "frontend/src/pages/Lobby.tsx",
    "frontend/src/pages/Profile.tsx",
    "frontend/src/pages/GameTable.tsx",
    "frontend/src/pages/History.tsx",
    "frontend/src/pages/Slots.tsx",

    # Игровая логика УНО (клиент)
    "frontend/src/games/uno/types.ts",
    "frontend/src/games/uno/engine.ts",
    "frontend/src/games/uno/bots.ts",

    # Типы и логика Дурака (клиент)
    "frontend/src/games/durak/types.ts",
    "frontend/src/games/durak/engine.ts",
    "frontend/src/games/durak/bots.ts",
    "frontend/src/games/durak/DurakGame.tsx",

    # Сервер (mock-server)
    "mock-server/package.json",
    "mock-server/server.js",
    "mock-server/gameEngine.js",
    "mock-server/durakEngine.js",
]

output = []
for filepath in FILES:
    full_path = os.path.join(os.path.dirname(__file__), filepath)
    output.append(f"\n{'='*60}")
    output.append(f"FILE: {filepath}")
    output.append(f"{'='*60}\n")
    
    if os.path.exists(full_path):
        with open(full_path, "r", encoding="utf-8") as f:
            output.append(f.read())
    else:
        output.append(f"[ФАЙЛ НЕ НАЙДЕН: {filepath}]")

result = "\n".join(output)

with open("project_dump.txt", "w", encoding="utf-8") as f:
    f.write(result)

print(f"Готово! Файл project_dump.txt создан ({len(result)} символов)")