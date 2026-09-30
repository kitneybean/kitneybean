# Как это устроено

```
scripts/generate-sniper.mjs   берёт граф вкладов через GitHub GraphQL и рисует анимированный SVG
site/index.html               интерактивное стрельбище (прицел за мышкой), публикуется на GitHub Pages
assets/header.svg             анимированная шапка профиля
.github/workflows/sniper.yml  каждые 6 часов: SVG → ветка output, стрельбище → GitHub Pages
```

README на GitHub не может выполнять JavaScript и не получает события мыши, поэтому в самом
профиле снайпер стреляет на автопилоте (SVG-анимация по реальному графу), а клик по полю
открывает полноценную версию, где целишься мышкой сам.

## Запуск (один раз)

1. **Ветка по умолчанию.** Профильный README берётся из ветки по умолчанию. Если ею стала
   ветка с этими файлами — переименуй её в `main`
   (Settings → General → Default branch → переименовать), либо смёрджи её в `main`.
2. **GitHub Pages.** Settings → Pages → Build and deployment → Source: **GitHub Actions**.
   Без этого SVG в профиле всё равно работает, но ссылка на стрельбище будет 404.
3. **Первый прогон.** Actions → «activity range» → Run workflow. После него появится ветка
   `output` с `sniper-dark.svg` / `sniper-light.svg`, а игра — на
   https://kitneybean.github.io/kitneybean/
4. **Больше мишеней.** Большая часть репозиториев приватные — включи
   Settings (профиля) → Public profile → **Include private contributions on my profile**,
   тогда вклады в них тоже станут клетками на графе (без названий репозиториев).

## Настройка

- Текст шапки — прямо в `assets/header.svg` (имя и стек).
- Количество целей и темп стрельбы — константы `MAX_TARGETS`, `AIM`, `SETTLE` в начале
  `scripts/generate-sniper.mjs`.
- Если GitHub отключил расписание после 60 дней без активности — Actions → workflow → Enable.

## Локально

```sh
node scripts/generate-sniper.mjs kitneybean dist        # без токена — публичное API или демо-данные
GITHUB_TOKEN=ghp_... node scripts/generate-sniper.mjs   # с токеном — реальные данные через GraphQL
cp site/index.html dist/ && npx serve dist              # открыть стрельбище
```
