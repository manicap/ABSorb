# Roadmap ABSorb

## Hotovo — v2.0.2 (baseline na `main`)
- [x] Porovnání Nové nahrávky × Audioknihovna
- [x] Multi-knihovny + přepínače
- [x] JSON metadata na pozadí
- [x] Dva minipřehrávače + detaily
- [x] Keš, SMB-friendly sken, filtry, hledání

## Další — větev `develop`

### Fáze A — Shell a nastavení
- [ ] Levá navigace (moduly)
- [ ] Sdílené nastavení (knihovny, jazyk)
- [ ] i18n: CS / SK / EN / DE
- [ ] Přejmenování UI na **ABSorb**

### Fáze B — Prohlížeč
- [ ] Modul prohlížeče knihovny (bez porovnání)
- [ ] Sdílený sken / keš s Porovnáním

### Fáze C — Soubory
- [ ] Kopírování / přesun s náhledem
- [ ] Mazání do aplikačního koše
- [ ] Žurnál + undo
- [ ] Režim „jen čtení" vs „zápis“

### Fáze D — Polish
- [ ] Export reportu porovnání (CSV/JSON)
- [ ] Profily (např. doma / NAS)
- [ ] Klávesové zkratky

## Neměnné principy
1. U **Porovnání** vždy dvě strany informací + dva přehrávače.
2. Bez zbytečné ztráty dat — destruktivní operace jen s undo.
3. `main` zůstává stabilní; experimenty na `develop` / `feature/*`.
