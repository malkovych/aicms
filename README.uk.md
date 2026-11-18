# AICMS

**CMS для AI-агентів.** Опиши модель один раз і отримаєш REST, MCP-інструменти, адмінку й типи. Агенти пропонують, люди вирішують.

[Сайт](https://malkovych.github.io/aicms/uk/) · [Архітектура](ARCHITECTURE.uk.md) · [English](README.md)

> Статус: фаза 1 працює. Поверх ядра (схеми, Action Bus, changesets, SQLite, REST, MCP, CLI) тепер є Studio з «Вхідними» для рев'ю змін від агентів, відкат, події наживо, SDK для TypeScript і Python та адаптери для Next.js і Astro. Далі модулі й екосистема.

## Навіщо

WordPress створювали для людей, які клацають адмінку. Агентам потрібні явні схеми, типізовані інструменти, межі прав і безпечний спосіб пропонувати зміни. AICMS побудована навколо цього:

- **Одна схема, усі інтерфейси.** Модель у `models/post.ts` стає REST-ендпоінтами, MCP-інструментами, валідацією, OpenAPI, `llms.txt`, формами в Studio і типами TypeScript.
- **Агент не пише в прод напряму.** Його зміни йдуть у changeset, проходять перевірки й чекають рев'ю. Кожна дія потрапляє в журнал, будь-яку зміну можна відкотити.
- **Права до поля.** Агент зі scope `post:update.seo` бачить у схемі інструмента лише поле `seo`.
- **Markdown на вході, блоки в базі.** Агент пише Markdown, AICMS зберігає структуровані блоки.
- **Модулі як Lego.** Модуль — одна папка з одним маніфестом, який каже, що модуль дає і що йому потрібно.

## Швидкий старт

Потрібен Node.js 22.13 або новіший (AICMS використовує вбудований `node:sqlite`).

```bash
git clone https://github.com/malkovych/aicms && cd aicms
npm install && npm run build
cd examples/blog
node ../../dist/cli.js agent create writer   # покаже токен один раз
node ../../dist/cli.js dev                   # Studio, REST, MCP і події на :4321
```

`dev` показує одноразове посилання для входу в Studio. Відкрий його, і Studio триматиме вхід 30 днів. `aicms login` дає нове посилання будь-коли.

Підключи MCP-клієнт (наприклад, Claude Code) з цим токеном:

```bash
claude mcp add --transport http aicms http://localhost:4321/mcp --header "Authorization: Bearer <token>"
```

Усе, що агент надішле, з'явиться у «Вхідних» Studio з diff «було / стало». Рев'ю можна робити й у терміналі:

```bash
node ../../dist/cli.js changes
node ../../dist/cli.js merge <changeset-id>
node ../../dist/cli.js reject <changeset-id> --comment "Коротший заголовок, будь ласка"
node ../../dist/cli.js revert <changeset-id>        # скасувати вже опубліковане
```

## Studio

Studio — адмінка для людей за адресою `/studio/`:

- **Вхідні:** changesets від агентів із diff до слова. Схвалити, попросити правки (коментар іде агенту) або закрити. Опублікований changeset скасовується одним кліком.
- **Контент:** форми, згенеровані з моделей, Markdown-редактор із переглядом, історія кожного запису й відновлення версії одним кліком.
- **Агенти:** scopes, режим рев'ю, використання бюджету, незавершена робота; видача й відкликання токенів.
- **Журнал:** кожна дія людей і агентів наживо.

Англійська й українська, світла й темна теми, працює на телефоні.

## Клієнти й фреймворки

```ts
// будь-який JavaScript-рантайм
import { createClient } from "@aicms/client"
import type { Schema } from "./aicms-types"            // npx aicms types --out aicms-types.ts

const cms = createClient<Schema>({ url: "http://localhost:4321", token })
const post = await cms.post.get({ slug: "welcome-to-aicms" })   // з типами
for await (const e of cms.events()) console.log(e.event)       // наживо
```

```python
# Python, лише стандартна бібліотека
from aicms import Client
cms = Client("http://localhost:4321", token="aicms_...")
cms.post.draft(title="Привіт із Python", body="Markdown **працює**")
cms.submit(note="Перший пост")
```

| Пакет | Що це |
|---|---|
| [`@aicms/client`](packages/client) | Типізований клієнт, події наживо й безпечний `blocksToHtml`, без залежностей |
| [`@aicms/next`](packages/next) | Читання з кешем і тегами на модель, ревалідація з вебхуків, `<Blocks />` |
| [`@aicms/astro`](packages/astro) | Content Layer loader з готовим HTML блоків |
| [`aicms` (Python)](sdk/python) | Клієнт для Python лише на стандартній бібліотеці |

## Що в репозиторії

| Частина | Де |
|---|---|
| Поля, моделі, Markdown ↔ блоки, slugs | `src/schema/` |
| Action Bus, політики, changesets, відкат, модулі, стрічка подій | `src/kernel/` |
| Сховище SQLite: entries, versions, changesets, events, media, tokens | `src/store/` |
| REST, OpenAPI, discovery, MCP, SSE, роздача Studio | `src/gates/` |
| CLI і `aicms types` | `src/cli.ts`, `src/typegen.ts` |
| Studio (React + Framer Motion, готова збірка лежить у `dist/studio`) | `studio/` |
| TypeScript-клієнт і адаптери фреймворків | `packages/` |
| Клієнт для Python | `sdk/python/` |

## Розробка

```bash
npm test             # ядро, входи, SDK і адаптери (node:test, без збірки)
npm run test:python  # клієнт для Python
npm run typecheck
npm run build        # dist/ для CLI, пакетів і Studio
npm run studio       # dev-сервер Studio на :5173, проксі до запущеного `aicms dev`
```

## Ліцензія

[MIT](LICENSE). AICMS безкоштовна для будь-якого використання, зокрема комерційного: будуй на ній сайти, продукти й сервіси без дозволів і оплати. Якщо проєкту колись знадобиться фінансування, воно буде через донати, а не через платну версію.
