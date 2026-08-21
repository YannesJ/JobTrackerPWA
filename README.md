# JobTracker

**Bewerbungen im Blick behalten, statt sie in E-Mails und Tabellen zu verlieren.**

JobTracker ist ein kostenloser Bewerbungstracker für den Browser. Firma, Position, Status, Gehalt, Termine und Notizen an einem Ort - als übersichtliche Liste oder als Kanban-Board.

Kein Konto. Keine Cloud. Kein Tracking. Alles läuft direkt in deinem Browser, auf deinem Gerät.

## Warum JobTracker

**Deine Daten bleiben deine Daten.** Bewerbungen sind heikel: Gehaltsvorstellungen, Absagen, Namen von Ansprechpartnern. Nichts davon verlässt dein Gerät - es gibt keinen Server, an den es gehen könnte.

**Du siehst, wo du stehst.** Ein Dashboard mit Erfolgsquote, Gehaltsüberblick und Wochenziel. Dazu ein Verlaufsdiagramm, das zeigt, welchen Weg deine Bewerbungen genommen haben - wie viele im Gespräch landeten, wo es endete, und wie viele noch offen sind.

**Nichts geht unter.** Kalender für Vorstellungsgespräche und Fristen, Erinnerungen zum Nachfassen und ein Hinweis, wenn eine Bewerbung zu lange still ist.

**Ein Suchfeld, viele Portale.** LinkedIn, Indeed, StepStone, Bundesagentur, XING und weitere - gleichzeitig durchsuchen, statt sich durch jedes einzeln zu klicken.

**Mehrere Geräte, ohne Umweg.** Handy und Laptop gleichst du per QR-Code direkt miteinander ab. Kein Server, kein Konto, niemand dazwischen. Alternativ per Backup-Datei oder über deinen eigenen Google-Drive-Zugang.

**Gehalt verbergen.** Ein Klick blendet alle Gehaltsangaben aus, bevor du jemandem deine Liste zeigst.

**Läuft überall.** Als App installierbar, auf dem Handy wie am Rechner, und auch ohne Internetverbindung.

## Loslegen

Seite öffnen, fertig. Keine Installation, kein Account. Wer mag, installiert sie zusätzlich als App.

## Technisch

Statische Seite ohne Build-Schritt: HTML, CSS und Vanilla JavaScript, ausgeliefert über GitHub Pages. Daten liegen in IndexedDB, Einstellungen in `localStorage`. Alle Fremdbibliotheken und Schriften sind unter `vendor/` mitgeliefert, damit im Normalbetrieb keine Anfrage nach außen geht.

```
node tests/run.js     # Testsuite, ohne npm install
```

Mitgelieferte Fremdkomponenten und ihre Lizenzen: [THIRD-PARTY.md](THIRD-PARTY.md)
