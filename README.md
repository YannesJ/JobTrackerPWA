# JobTracker

Bewerbungen im Blick behalten, statt sie in E-Mails und Tabellen zu verlieren.

JobTracker ist ein kostenloser Bewerbungstracker für den Browser: Firma, Position, Status, Gehalt, Termine und Notizen an einem Ort - als übersichtliche Liste oder als Kanban-Board. Dazu ein Dashboard mit Erfolgsquote und Gehaltsüberblick, ein Kalender für Vorstellungsgespräche und Fristen, und eine Suche, die den Job gleichzeitig auf den größten deutschen Jobportalen sucht.

**Deine Daten bleiben deine Daten.** Kein Konto, keine Cloud, kein Tracking - alles läuft direkt in deinem Browser auf deinem Gerät. Wer mehrere Geräte nutzt, gleicht sie per QR-Code direkt zwischen den Geräten ab, über Export/Import, oder optional über den eigenen Google-Drive-Sync.

## Funktionen

### Erfassen und ordnen
- Bewerbungen mit Status, Gehalt, Terminen, Ansprechpartner und Notizen
- Tabelle oder Kanban-Board, Spalten und Karteninhalte frei ein- und ausblendbar
- Eigene Status-Kategorien mit Farben und frei wählbarer Reihenfolge
- Eigene Kartenreihenfolge per Drag & Drop, je Statusspalte
- Prioritäts-Sterne: wie sehr willst du den Job?
- Volltextsuche und Filter nach Status und Quelle

### Auswerten
- Dashboard mit Erfolgsquote, Gehaltsstatistik, Absagegründen und Wochenziel
- Verlaufsdiagramm (Sankey): zeigt, welchen Weg deine Bewerbungen durch die Status genommen haben - zum Kopieren, Teilen und Speichern
- Kalender mit Erinnerungen und Nachfass-Hinweisen
- Optionale Benachrichtigungen bei Statuswechseln und längerer Funkstille

### Finden
- Jobsuche über mehrere Portale gleichzeitig (LinkedIn, Indeed, StepStone, Bundesagentur, XING u.a.)
- Direktlinks zur Arbeitgeber- und Gehaltsrecherche aus jeder Bewerbung heraus

### Daten behalten
- Backup als JSON - enthält Bewerbungen, Status-Kategorien, Kanban-Reihenfolge, Kalendertermine und Erinnerungen
- Export und Import als CSV/Excel
- Geräteabgleich per animiertem QR-Code: kein Server, kein Konto, niemand dazwischen. Vor dem Übernehmen zeigt eine Vorschau genau, was sich ändert
- Optionaler Google-Drive-Sync mit deinen eigenen Zugangsdaten
- Gehaltsangaben auf Knopfdruck ausblenden, bevor du die Liste jemandem zeigst
- Als App installierbar, funktioniert offline

## Loslegen

Einfach die Seite öffnen - keine Installation, kein Account nötig. Wer mag, installiert sie zusätzlich als App fürs Handy oder den Desktop.

## Technisch

Statische Seite ohne Build-Schritt: HTML, CSS und Vanilla JavaScript, ausgeliefert über GitHub Pages. Die Daten liegen in IndexedDB, Einstellungen in `localStorage`. Alle Fremdbibliotheken und Schriften sind unter `vendor/` mitgeliefert, damit im Normalbetrieb keine einzige Anfrage nach außen geht.

```
node tests/run.js     # Testsuite, ohne npm install
```

Eine Übersicht der mitgelieferten Fremdkomponenten und ihrer Lizenzen steht in [THIRD-PARTY.md](THIRD-PARTY.md).
