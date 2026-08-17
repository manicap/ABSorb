# ABS Grok

Lokální nástroj pro rychlé porovnání složek s audioknihami / rozhlasovými hrami.

## Spuštění

### Linux / macOS
```bash
./start.sh
```

### Windows
```bat
start.bat
```

Pak otevři v prohlížeči: **http://127.0.0.1:8765**

## Co umí

- Dva panely (**Nové nahrávky** vs. **Audioknihovna**)
- Rychlé skenování pouze jedné úrovně složek (vhodné pro SMB)
- Barevné označení shody (zelená / žlutá / červená) + filtry
- Fuzzy matching s normalizací českých/slovenských názvů, hashů, roků, autora a velikosti
- Kešování výsledků skenu
- Virtualizované seznamy (rychlé i při desítkách tisíc položek)
- Řazení podle názvu / autora / titulu (vzestupně i sestupně)
- Vyhledávání s našeptávačem
- Detaily po kliknutí na položku
- Minipřehrávač (play / stop / seek / hlasitost)
- Náhled ID3 / JSON / cover
- Zrušitelné porovnání s průběhem
- Cesty se pamatují
- **Nikdy nic nemění** v prohledávaných složkách
- Běží pouze na localhostu

## Požadavky

- Python 3.10+
- Nic dalšího (venv a závislosti se vytvoří automaticky)
