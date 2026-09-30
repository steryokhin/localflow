# Local Flow

Локальное зеркало Jira-тикетов плюс твои заметки рядом с тикетом.
Синк только в одну сторону: **Jira → локальные файлы**. Ничего не уходит с машины.

- Ноль зависимостей: TypeScript без сборки, запускается Node ≥ 22.18 или Bun.
- Сеть — только `src/jira/client.ts`: одни GET-запросы и только на хост из конфига.
- Хранилище — обычная папка с локальным git без remote. Git даёт diff и историю версий.

## Установка

```bash
git clone <repo> ~/work/localflow
ln -s ~/work/localflow/bin/lf /usr/local/bin/lf    # или алиас в zshrc
```

## Первый запуск

```bash
lf init ~/LocalFlow --jira-url https://jira.example.com --project PROJ --local-prefix WORK
# read-only Personal Access Token из Jira:
mkdir -p ~/.config/localflow
printf '%s' 'TOKEN' > ~/.config/localflow/jira-token && chmod 600 ~/.config/localflow/jira-token
lf doctor
lf sync --dry-run
lf sync
lf seen --all        # первый синк помечает всё как новое
```

## Хранилище

```
~/LocalFlow/
  localflow.json              конфиг
  INBOX.md                    генерируется: что нового + доска (вне git)
  .localflow/                 служебное состояние (вне git)
  projects/
    PROJ/PROJ-123-slug/
      ticket.md               генерируется из Jira — руками не править
      attachments/            вложения из Jira
      raw/issue.json          сырой ответ Jira, оригинал один в один
      notes.md                твоё: статус и основная заметка
      *.md, что угодно        твоё: синк никогда не трогает
    WORK/WORK-001-slug/       свой локальный тикет (ticket.md редактируется)
```

Синк владеет только `ticket.md`, `attachments/`, `raw/`. Твой статус (`inbox`, `inprogress`,
`inreview`, `done`, `archived`) живёт в `notes.md` и синком не меняется; если Jira ушла
дальше твоего статуса, `lf ls` это подсветит.

## Команды

| Команда | Что делает |
|---|---|
| `lf sync [--project P] [--preset N] [--jql "…"] [--key K1,K2] [--dry-run] [--force]` | подтянуть изменения из Jira, один коммит на синк |
| `lf inbox` | тикеты, изменившиеся с прошлого просмотра, со сводкой |
| `lf diff KEY [опции git diff]` | что именно изменилось в тикете |
| `lf seen KEY… \| --all` | отметить прочитанным |
| `lf ls [--status S] [--mine] [--project P] [--unread] [--all]` | доска в терминале |
| `lf start KEY` / `lf status KEY <status>` | твой статус |
| `lf note KEY NAME` | новый файл-заметка в папке тикета |
| `lf create PREFIX "title"` | свой локальный тикет |
| `lf open [KEY]` / `lf path KEY` | открыть в редакторе / напечатать путь |
| `lf commit [-m MSG]` | закоммитить свои заметки в локальный git хранилища |
| `lf doctor [--offline]` | проверка окружения, токена и доступа к Jira |

Хранилище ищется так: `--vault PATH`, затем `LOCALFLOW_VAULT`, затем ближайший родитель с
`localflow.json`, затем `~/LocalFlow`.

## Конфиг

```json
{
  "version": 1,
  "jira": {
    "baseUrl": "https://jira.example.com",
    "tokenFile": "~/.config/localflow/jira-token",
    "userAgent": "localflow/0.1",
    "maxAttachmentMb": 25,
    "ignoreFields": ["Rank", "Development", "Last Viewed"]
  },
  "projects": {
    "PROJ": {
      "source": "jira",
      "defaultPreset": "mine",
      "presets": {
        "mine": "project = PROJ AND resolution = Unresolved AND assignee = currentUser() ORDER BY updated DESC"
      },
      "fields": {
        "acceptanceCriteria": "customfield_10001",
        "stepsToReproduce": "customfield_10002",
        "storyPoints": "customfield_10003",
        "sprint": "customfield_10004",
        "epicLink": "customfield_10005"
      },
      "statusOverrides": { "ready for dev": "inbox" }
    },
    "WORK": { "source": "local" }
  }
}
```

- `fields` — id кастомных полей проекта; у них отдельные секции в `ticket.md`. Все остальные
  непустые поля попадают в секцию «Other fields» под человеческими именами.
- `ignoreFields` — имена или id полей, которые шумят в diff и не нужны в `ticket.md`.
- `statusOverrides` — имя Jira-статуса → локальный статус для новых тикетов.

## Тесты

```bash
node --test test/*.test.ts     # или: bun test
```

E2E-тест поднимает фейковый Jira на 127.0.0.1 и гоняет синк на временном хранилище.
`test/network-guard.test.ts` следит, чтобы сеть использовалась только в клиенте Jira.
