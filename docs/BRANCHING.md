# Git větve

## Model
- **main** — produkční baseline, vždy spustitelná
- **develop** — integrace suite, výchozí větev pro práci
- **feature/název** — jedna funkce nebo verze, merge zpět do `develop`

## Příklady
```
feature/shell-nav
feature/i18n-cs-sk-en-de
feature/file-ops-undo
```

## Workflow
1. `git checkout develop && git pull`
2. `git checkout -b feature/…`
3. Commity, push, (volitelně PR do develop)
4. Po stabilizaci suite: develop → main (tag verze)

## Tagování
```
v2.0.2   # baseline compare tool
v2.1.0   # shell + settings
…
```
