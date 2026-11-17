# AICMS

**CMS для AI-агентів.** Опиши модель один раз і отримаєш REST, MCP-інструменти, адмінку й типи. Агенти пропонують, люди вирішують.

[Сайт](https://malkovych.github.io/aicms/uk/) · [Архітектура](ARCHITECTURE.uk.md) · [English](README.md)

> Статус: фаза 0 працює. Ядро (схеми, Action Bus, changesets, SQLite, REST, MCP, CLI) лежить у цьому репозиторії й покрите тестами. Далі Studio, SDK і адаптери фреймворків.

## Навіщо

WordPress створювали для людей, які клацають адмінку. Агентам потрібні явні схеми, типізовані інструменти, межі прав і безпечний спосіб пропонувати зміни. AICMS побудована навколо цього:

- **Одна схема, усі інтерфейси.** Модель у `models/post.ts` стає REST-ендпоінтами, MCP-інструментами, валідацією, OpenAPI і `llms.txt`.
- **Агент не пише в прод напряму.** Його зміни йдуть у changeset, проходять перевірки й чекають рев'ю. Кожна дія потрапляє в журнал.
- **Права до поля.** Агент зі scope `post:update.seo` бачить у схемі інструмента лише поле `seo`.
- **Markdown на вході, блоки в базі.** Агент пише Markdown, AICMS зберігає структуровані блоки.
- **Модулі як Lego.** Модуль — одна папка з одним маніфестом, який каже, що модуль дає і що йому потрібно.

## Швидкий старт (фаза 0)

Потрібен Node.js 22.13 або новіший (AICMS використовує вбудований `node:sqlite`).

```bash
git clone https://github.com/malkovych/aicms && cd aicms
npm install && npm run build
cd examples/blog
node ../../dist/cli.js agent create writer   # покаже токен один раз
node ../../dist/cli.js dev                   # API на :4321/api/v1, MCP на :4321/mcp
```

Підключи MCP-клієнт (наприклад, Claude Code) з цим токеном:

```bash
claude mcp add --transport http aicms http://localhost:4321/mcp --header "Authorization: Bearer <token>"
```

Рев'ю того, що запропонував агент:

```bash
node ../../dist/cli.js changes
node ../../dist/cli.js merge <changeset-id>
node ../../dist/cli.js reject <changeset-id> --comment "Коротший заголовок, будь ласка"
```

## Ліцензія

Ще не обрана (MIT чи AGPL з комерційною хмарою). Поки файлу ліцензії немає, усі права захищені.
