# ABSorb

**ABS** + **orb** → *absorb* — lokální nástroje pro organizaci a porovnání knihoven [Audiobookshelf](https://www.audiobookshelf.org/).

Cíl: pohltit chaos ve frontě nahrávek, sjednotit metadata a bezpečně pracovat s více knihovnami ABS.

---

## Rychlý start

### Požadavky
- Python 3.10+ (v PATH)
- Windows / Linux / macOS
- Prohlížeč

### Spuštění

**Windows**
```bat
start.bat
```

**Linux / macOS**
```bash
chmod +x start.sh
./start.sh
```

Otevři: **http://127.0.0.1:8765**

Skript vytvoří `venv`, doinstaluje závislosti z `requirements.txt` a spustí server.

Ukončení: `Ctrl+C` (počkej 1–2 s).

---

## Co umí dnes (modul Porovnání · v2.0.2)

| Funkce | Popis |
|--------|--------|
| Dva panely | **Nové nahrávky** × **Audioknihovna** |
| Multi-knihovny | Více kořenů ABS, přepínače Vše / Nic / jednotlivé |
| Porovnání | Fuzzy matching názvů (autor, titul, hashe, roky, prohozené pořadí) |
| Metadata JSON | Doplnění z `metadata.json` (Audiobookshelf) na pozadí |
| Filtry | Nalezeno / Nejisté / Nenalezeno |
| Přehrávače | Samostatný minipřehrávač u **obou** panelů (A/B poslech) |
| Keš | Sken bez databáze, read-only vůči knihovně |
| SMB | Optimalizace pro síťové sdílení |

**Aplikace nemění soubory v prohledávaných složkách** (pouze čte).

---

## Větve (Git)

| Větev | Účel |
|-------|------|
| `main` | Stabilní baseline — aktuální funkční porovnávací tool |
| `develop` | **Aktivní vývoj** — suite (shell, jazyky, nastavení, další moduly) |
| `feature/*` | Krátkodobé odbočky z `develop` podle úkolu / verze |

```
main
 └── develop          ← zde pokračujeme
      ├── feature/…
      └── feature/…
```

Po dokončení feature větve: merge → `develop` → po stabilizaci → `main`.

---

## Struktura projektu

```
ABSorb/
├── abs_grok.py          # FastAPI backend (sken, match, API, audio)
├── requirements.txt
├── start.bat / start.sh
├── config.json          # lokální (v .gitignore) — cesty, knihovny
├── cache/               # keš skenů (v .gitignore)
├── static/
│   ├── index.html
│   ├── app.js
│   └── style.css
└── docs/                # dokumentace
```

---

## Konfigurace

Ukládá se do `config.json` vedle aplikace (nevkládej do gitu):

- cesta k **Novým nahrávkám**
- seznam **knihoven** (`id`, `name`, `path`, `enabled`)
- nedávné cesty

---

## Plán suite (ABSorb)

Dnešní tool se stane modulem **Porovnání** uvnitř větší aplikace:

1. **Shell** — levá navigace mezi moduly  
2. **Sdílené nastavení** — knihovny, jazyk (CS / SK / EN / DE)  
3. **Prohlížeč knihovny**  
4. **Operace se soubory** — kopírování / mazání s žurnálem a undo  

Detail: [docs/ROADMAP.md](docs/ROADMAP.md), architektura: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Vývoj

```bash
git clone https://github.com/manicap/ABSorb.git
cd ABSorb
git checkout develop
./start.sh   # nebo start.bat
```

Závislosti: viz `requirements.txt`  
(FastAPI, Uvicorn, RapidFuzz, …).

---

## Licence

Soukromý projekt autora. Úpravy dle dohody.
