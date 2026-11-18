import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

// English first, Ukrainian second. Keys read like the English text they stand for.
const en = {
  "nav.inbox": "Inbox",
  "nav.content": "Content",
  "nav.agents": "Agents",
  "nav.activity": "Activity",
  "live.on": "Live",
  "live.off": "Reconnecting…",
  "signout": "Sign out",
  "theme.dark": "Dark theme",
  "theme.light": "Light theme",
  "lang": "Українська",

  "signin.title": "Sign in to Studio",
  "signin.body": "Studio opens with a one-time link from your terminal. In your project folder run:",
  "signin.hint": "aicms dev also prints a fresh link every time it starts.",

  "inbox.title": "Inbox",
  "inbox.lead": "Changes from agents wait here until a person decides.",
  "inbox.submitted": "Waiting",
  "inbox.open": "Drafting",
  "inbox.merged": "Published",
  "inbox.rejected": "Closed",
  "inbox.empty.submitted": "Nothing is waiting for you. When an agent submits changes, they appear here.",
  "inbox.empty": "Nothing here yet.",
  "inbox.pick": "Pick a changeset to see what changed.",
  "inbox.approve": "Approve and publish",
  "inbox.request": "Request changes",
  "inbox.send": "Send back",
  "inbox.closeInstead": "Close it instead of sending it back",
  "inbox.comment": "What should the agent change? It will read this.",
  "inbox.revert": "Undo these changes",
  "inbox.published": "Published · {n} entries",
  "inbox.sentBack": "Sent back to {actor}",
  "inbox.closed": "Changeset closed",
  "inbox.reverted": "Changes undone",
  "inbox.why": "Waiting because",
  "inbox.note": "Note",
  "inbox.comment.label": "Reviewer's comment",
  "inbox.issues": "Failed checks",
  "inbox.willDelete": "This entry will be deleted.",
  "inbox.items": "{n} changes",

  "op.create": "New",
  "op.update": "Edit",
  "op.delete": "Delete",

  "content.title": "Content",
  "content.new": "New entry",
  "content.search": "Search",
  "content.empty": "No entries yet.",
  "content.noMatch": "Nothing matches.",
  "content.more": "Show more",
  "content.total": "{n} entries",
  "content.untitled": "Untitled",

  "entry.publish": "Publish",
  "entry.publishing": "Publishing…",
  "entry.published": "Published",
  "entry.created": "Created and published",
  "entry.delete": "Delete",
  "entry.deleteAsk": "Delete this entry? You can bring it back from its history.",
  "entry.deleted": "Entry deleted",
  "entry.history": "History",
  "entry.version": "Version {n}",
  "entry.view": "View",
  "entry.restore": "Restore this version",
  "entry.restored": "Restored version {n}",
  "entry.current": "current",
  "entry.removed": "deleted",
  "entry.dirty": "Unsaved changes",
  "entry.back": "Back to {model}",
  "entry.missing": "This entry doesn't exist, or it was deleted.",
  "entry.details": "Details",
  "entry.locale": "Language",
  "entry.updated": "Updated",
  "entry.by": "by {who}",
  "entry.new": "New {model}",

  "field.required": "required",
  "field.auto": "Filled from {field} when empty",
  "field.write": "Write",
  "field.preview": "Preview",
  "field.add": "Add and press Enter",
  "field.none": "None",
  "field.url": "Image URL",
  "field.alt": "Alt text",
  "field.pick": "Choose…",
  "field.json": "Not valid JSON yet",

  "agents.title": "Agents",
  "agents.lead": "Who may connect and what they may do. Agents are defined in aicms.config.ts.",
  "agents.empty": "No agents yet. Add one to aicms.config.ts:",
  "agents.token": "New token",
  "agents.revoke": "Revoke access",
  "agents.revokeAsk": "Revoke every token of {name} and close the changes it hasn't published?",
  "agents.revoked": "Access revoked for {name}",
  "agents.tokenFor": "Token for {name}",
  "agents.once": "Copy it now. It is shown only once.",
  "agents.connect": "Connect an MCP client",
  "agents.human": "A person approves",
  "agents.auto": "Merges automatically",
  "agents.tokens": "Active tokens",
  "agents.seen": "Last action",
  "agents.hour": "Actions, last hour",
  "agents.waiting": "Waiting for review",
  "agents.drafting": "Changes in draft",
  "agents.never": "never",
  "agents.budget": "Budget",
  "agents.perHour": "{n} actions an hour",

  "activity.title": "Activity",
  "activity.lead": "Every action by people and agents, as it happens.",
  "activity.everyone": "Everyone",
  "activity.older": "Show older",
  "activity.empty": "Nothing has happened yet.",

  "copy": "Copy",
  "copied": "Copied",
  "cancel": "Cancel",
  "close": "Close",
  "retry": "Try again",
  "error": "Something went wrong",
  "now": "just now",
  "min": "{n} min ago",
  "hour": "{n} h ago",
  "day": "{n} d ago",
} as const;

export type Key = keyof typeof en;

const uk: Record<Key, string> = {
  "nav.inbox": "Вхідні",
  "nav.content": "Контент",
  "nav.agents": "Агенти",
  "nav.activity": "Журнал",
  "live.on": "Наживо",
  "live.off": "Перепідключення…",
  "signout": "Вийти",
  "theme.dark": "Темна тема",
  "theme.light": "Світла тема",
  "lang": "English",

  "signin.title": "Вхід у Studio",
  "signin.body": "Studio відкривається одноразовим посиланням із термінала. У папці проєкту виконай:",
  "signin.hint": "aicms dev теж показує нове посилання під час кожного запуску.",

  "inbox.title": "Вхідні",
  "inbox.lead": "Зміни від агентів чекають тут, доки людина не вирішить.",
  "inbox.submitted": "Чекають",
  "inbox.open": "Чернетки",
  "inbox.merged": "Опубліковані",
  "inbox.rejected": "Закриті",
  "inbox.empty.submitted": "Нічого не чекає на тебе. Коли агент надішле зміни, вони з'являться тут.",
  "inbox.empty": "Тут поки порожньо.",
  "inbox.pick": "Обери changeset, щоб побачити, що змінилося.",
  "inbox.approve": "Схвалити й опублікувати",
  "inbox.request": "Попросити правки",
  "inbox.send": "Повернути",
  "inbox.closeInstead": "Закрити замість повернення",
  "inbox.comment": "Що агентові змінити? Він прочитає цей коментар.",
  "inbox.revert": "Скасувати ці зміни",
  "inbox.published": "Опубліковано · записів: {n}",
  "inbox.sentBack": "Повернуто: {actor}",
  "inbox.closed": "Changeset закрито",
  "inbox.reverted": "Зміни скасовано",
  "inbox.why": "Чекає, бо",
  "inbox.note": "Нотатка",
  "inbox.comment.label": "Коментар рецензента",
  "inbox.issues": "Перевірки не пройдено",
  "inbox.willDelete": "Цей запис буде видалено.",
  "inbox.items": "змін: {n}",

  "op.create": "Нове",
  "op.update": "Правка",
  "op.delete": "Видалення",

  "content.title": "Контент",
  "content.new": "Новий запис",
  "content.search": "Пошук",
  "content.empty": "Записів ще немає.",
  "content.noMatch": "Нічого не знайдено.",
  "content.more": "Показати ще",
  "content.total": "записів: {n}",
  "content.untitled": "Без назви",

  "entry.publish": "Опублікувати",
  "entry.publishing": "Публікую…",
  "entry.published": "Опубліковано",
  "entry.created": "Створено й опубліковано",
  "entry.delete": "Видалити",
  "entry.deleteAsk": "Видалити запис? Його можна повернути з історії.",
  "entry.deleted": "Запис видалено",
  "entry.history": "Історія",
  "entry.version": "Версія {n}",
  "entry.view": "Переглянути",
  "entry.restore": "Відновити цю версію",
  "entry.restored": "Відновлено версію {n}",
  "entry.current": "поточна",
  "entry.removed": "видалено",
  "entry.dirty": "Є незбережені зміни",
  "entry.back": "До списку: {model}",
  "entry.missing": "Такого запису немає, або його видалили.",
  "entry.details": "Деталі",
  "entry.locale": "Мова",
  "entry.updated": "Оновлено",
  "entry.by": "автор: {who}",
  "entry.new": "Новий запис: {model}",

  "field.required": "обов'язкове",
  "field.auto": "Заповниться з поля {field}, якщо лишити порожнім",
  "field.write": "Текст",
  "field.preview": "Перегляд",
  "field.add": "Введи й натисни Enter",
  "field.none": "Немає",
  "field.url": "URL зображення",
  "field.alt": "Альтернативний текст",
  "field.pick": "Обрати…",
  "field.json": "Поки що це не валідний JSON",

  "agents.title": "Агенти",
  "agents.lead": "Хто може підключатися і що може робити. Агенти описуються в aicms.config.ts.",
  "agents.empty": "Агентів ще немає. Додай першого в aicms.config.ts:",
  "agents.token": "Новий токен",
  "agents.revoke": "Відкликати доступ",
  "agents.revokeAsk": "Відкликати всі токени агента {name} і закрити його неопубліковані зміни?",
  "agents.revoked": "Доступ відкликано: {name}",
  "agents.tokenFor": "Токен для {name}",
  "agents.once": "Скопіюй зараз. Його показують лише один раз.",
  "agents.connect": "Підключити MCP-клієнт",
  "agents.human": "Схвалює людина",
  "agents.auto": "Зливається автоматично",
  "agents.tokens": "Активні токени",
  "agents.seen": "Остання дія",
  "agents.hour": "Дій за годину",
  "agents.waiting": "Чекають рев'ю",
  "agents.drafting": "Змін у чернетці",
  "agents.never": "ще не було",
  "agents.budget": "Бюджет",
  "agents.perHour": "{n} дій на годину",

  "activity.title": "Журнал",
  "activity.lead": "Кожна дія людей і агентів у реальному часі.",
  "activity.everyone": "Усі",
  "activity.older": "Показати старіші",
  "activity.empty": "Ще нічого не відбувалося.",

  "copy": "Копіювати",
  "copied": "Скопійовано",
  "cancel": "Скасувати",
  "close": "Закрити",
  "retry": "Спробувати ще",
  "error": "Щось пішло не так",
  "now": "щойно",
  "min": "{n} хв тому",
  "hour": "{n} год тому",
  "day": "{n} дн тому",
};

export type Lang = "en" | "uk";
const dict: Record<Lang, Record<Key, string>> = { en, uk };

function initial(): Lang {
  try {
    const saved = localStorage.getItem("aicms.lang");
    if (saved === "en" || saved === "uk") return saved;
  } catch {
    /* storage may be blocked */
  }
  return navigator.language?.toLowerCase().startsWith("uk") ? "uk" : "en";
}

type T = (key: Key, vars?: Record<string, string | number>) => string;
const I18n = createContext<{ lang: Lang; t: T; toggle(): void }>({ lang: "en", t: (k) => en[k], toggle() {} });

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(initial);
  const t = useCallback<T>((key, vars) => {
    let s: string = dict[lang][key] ?? en[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
    return s;
  }, [lang]);
  const toggle = useCallback(() => {
    setLang((l) => {
      const next = l === "en" ? "uk" : "en";
      try {
        localStorage.setItem("aicms.lang", next);
      } catch {
        /* ignore */
      }
      document.documentElement.lang = next;
      return next;
    });
  }, []);
  const value = useMemo(() => ({ lang, t, toggle }), [lang, t, toggle]);
  return <I18n.Provider value={value}>{children}</I18n.Provider>;
}

export const useT = () => useContext(I18n);
