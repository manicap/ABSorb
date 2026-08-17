# Architektura ABSorb

## Současný stav (v2.0.2)

Monolitický lokální webový tool:

```
Prohlížeč  ←→  FastAPI (abs_grok.py)  ←→  filesystem / SMB
                    │
                    ├── sken složek (os.scandir)
                    ├── keš JSON na disk
                    ├── fuzzy match (rapidfuzz)
                    ├── SSE progress
                    └── stream audia (Range / 206)
```

Frontend: vanilla JS, virtuální seznamy, bez frameworku.

### Princip bezpečnosti
- **Read-only** vůči knihovnám a zdrojovým složkám
- Zápis jen do `config.json` a `cache/` v adresáři aplikace

### Multi-knihovny
Každá položka vpravo nese `library_id` / `library_name`.  
Porovnání běží jen proti **enabled** knihovnám; seznam filtruje totéž.

### Matching
Vrstvy: exact → normalizovaný název → prohozený autor/titul → token score.  
Výstupy: `found` / `uncertain` / `not_found`.

---

## Cílová suite

```
┌─────────────┬──────────────────────────────────────┐
│  Navigace   │  Horní pruh (jazyk, stav)             │
│  - Porovnání│                                      │
│  - Prohlížeč│         Aktivní modul                 │
│  - Soubory  │                                      │
│  - Nastavení│  (dva detaily + přehrávače u Compare)│
└─────────────┴──────────────────────────────────────┘
```

### Sdílené jádro (`core/`)
- konfigurace (knihovny, jazyk)
- sken + keš
- model položky (path, title, authors, …)
- čtení `metadata.json`

### Moduly (`modules/`)
| Modul | Odpovědnost |
|-------|-------------|
| `compare` | dnešní ABS Grok |
| `browser` | procházení / hledání / přehrávání |
| `files` | kopírování, mazání, žurnál, undo |
| `settings` | UI nastavení |

### i18n
Katalogy `cs` / `sk` / `en` / `de`, přepínač v shellu.

### Operace se soubory (budoucí)
- fronta s náhledem
- žurnál operací
- vlastní „koš“ aplikace (spolehlivější než SMB recycle)
- režimy: jen čtení / návrh / zápis
