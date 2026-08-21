# Drittkomponenten

JobTracker liefert alle Fremdbestandteile mit (Verzeichnis `vendor/`), damit die App
ohne Anfragen an fremde Server läuft. Diese Übersicht listet, was mitgeliefert wird und
unter welcher Lizenz. Der jeweils vollständige Lizenztext liegt im Verzeichnis der
Komponente.

Alle eingesetzten Lizenzen sind permissiv und erlauben die kommerzielle Nutzung und
Weitergabe, auch als Teil eines proprietären Produkts. Keine davon verlangt, den
eigenen Quellcode offenzulegen.

| Komponente | Version | Lizenz | Lizenztext |
|---|---|---|---|
| Chart.js | 4.x | MIT | `vendor/chart.js/LICENSE.md` |
| idb-keyval | 6.3.0 | Apache-2.0 | `vendor/idb-keyval/LICENSE.txt` |
| Lucide Icons | – | ISC | `vendor/lucide/LICENSE.txt` |
| jsQR | – | Apache-2.0 | `vendor/qr/jsQR.LICENSE.txt` |
| qrcode-generator | – | MIT | `vendor/qr/qrcode-generator.LICENSE.txt` |
| SheetJS (xlsx) | Community Edition | Apache-2.0 | `vendor/xlsx/LICENSE.txt` |
| Outfit (Schrift) | – | SIL OFL 1.1 | `vendor/fonts/LICENSE-outfit.txt` |
| Roboto Mono (Schrift) | – | SIL OFL 1.1 | `vendor/fonts/LICENSE-roboto-mono.txt` |

## Auflagen im Einzelnen

**MIT und ISC** verlangen, dass Copyright-Vermerk und Lizenztext bei der Weitergabe
erhalten bleiben. Erfüllt durch die Dateien unter `vendor/`.

**Apache-2.0** verlangt zusätzlich (Abschnitt 4), dass eine Kopie der Lizenz beiliegt
und dass eine etwaige NOTICE-Datei des Projekts weitergereicht wird. Die Lizenzkopien
liegen bei; keines der drei hier verwendeten Projekte liefert eine NOTICE-Datei aus.
Beim Aktualisieren einer dieser Komponenten ist erneut zu prüfen, ob eine NOTICE
hinzugekommen ist.

**SIL OFL 1.1** erlaubt Einbetten und Weitergabe der Schriften, auch kommerziell. Die
Schriftdateien dürfen nicht für sich allein verkauft werden – als Teil einer Anwendung
weitergegeben werden dürfen sie. Weder Outfit noch Roboto Mono führen einen Reserved
Font Name; die Dateien werden unverändert ausgeliefert.

## Dienste, die zur Laufzeit angesprochen werden

Diese laufen nur, wenn eine Nutzerin sie aktiv auslöst – im Normalbetrieb stellt die
App keine Anfragen nach außen.

- **Google Identity Services und Google Drive API** – ausschließlich beim optionalen
  Drive-Sync, mit selbst hinterlegten Zugangsdaten. Die Skripte werden erst in diesem
  Moment nachgeladen.
- **Externe Jobportale und die Google-Suche** – die Seite „Job finden" öffnet
  Suchtreffer in einem neuen Tab. Bei kommerzieller Nutzung sind die
  Nutzungsbedingungen der jeweiligen Portale und der Google-Suche zu prüfen; die
  Portalnamen in der Oberfläche sind Marken der jeweiligen Anbieter und dienen der
  Beschreibung des Ziels.

## Inhalte der App

Logo, Symbolgrafiken im Markup und die Demo-Daten sind eigene Inhalte. Die
Firmennamen in den Demo-Daten sind frei erfunden.
