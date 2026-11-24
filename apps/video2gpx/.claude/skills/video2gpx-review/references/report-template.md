# Report template (review/REPORT.md)

Write the report in German, as the user writes. Code identifiers, config names and cause ids stay as they are. Use relative links
to the files in `review/` and in `../_testsuite/`, so the folder can be opened anywhere. Embed images with `![](evidence/S03/frames.jpg)`.
Every claim needs a measured value or a frame as evidence. Write "nicht geprüft" where you did not check.

```markdown
# video2gpx-Review: <Titel des Videos> (<youtube-id>)

Datum, Pipeline-Hash, ridrs_app-Commit des Runner-Worktrees, Video (Auflösung, fps, Dauer), Lauf-Parameter (bbox-Quelle, Hinweis, Fahrzeug).

## Ergebnis in Kürze
- Urteil der Pipeline und Urteil nach Prüfung (z. B. "uncertain → Route stimmt auf 31 von 33 km").
- Anzahl Prüfstellen: falsch / richtig aber unsicher / unklar; Kontrollstellen: x von y richtig.
- Die 1–3 wichtigsten Empfehlungen in je einem Satz, mit dem zugehörigen Schnelltest.

## Plausibilität gegen OpenStreetMap
Tabelle der Prüfungen (Geschwindigkeit, Beschleunigung, Straßenklasse, Einbahnstraßen, Wenden, Kurven Video gegen Karte, Abstand
zur Vorlage) mit Treffern und dem, was sich davon bei der Videoprüfung als echt herausstellte (false-positive-Quote je Prüfung).

## Befunde
### S03 9:37–10:34 Promenade des Anglais: <falsch | richtig, aber unsicher | unklar>
- **Was das Video zeigt:** konkrete Beobachtungen mit Zeit (Schilder, Kreuzungen, Abbiegen, Tunnel, Meer links/rechts).
- **Was die Pipeline ergab:** Straße, Sicherheit, Abweichung (m, s) zur geprüften Position.
- **Ursache:** `<cause id>`, mit Messwerten und Grenzwerten; der erste falsche Schritt; das Gegenbeispiel aus dem Video.
- **Belege:** ![](evidence/S03/frames.jpg) ![](evidence/S03/map.png) ![](evidence/S03/series.png) (Overlay, falls genutzt)
- **Schnelltest:** [`<case-name>`](../../_testsuite/<case-name>/case.json), Clip `<dauer> s`, <n> Checkpoints, Laufzeit
  heute <x> s, Ergebnis heute FAIL/PASS (reproduziert: ja/nein).

(Gleichartige Stellen mit derselben Ursache zusammenfassen: eine Überschrift, alle Zeiten auflisten, ein Test.)

## Ursachen im Überblick
Tabelle: cause id | Stellen | Dauer gesamt | Wirkung (falsch / nur unsicher) | Schritt.

## Empfehlungen für die Pipeline
Nach Wirkung ordnen (Fehler vor Unsicherheit, häufige Ursache vor seltener). Für jede Empfehlung:
1. **Änderung:** Modul/Funktion/Konfigurationswert (z. B. `steps_a.rotation`, `C.FAR`), was genau anders werden soll, und warum das die
   gemessene Ursache trifft.
2. **Erwartete Wirkung:** welche Befunde sich ändern sollten (mit Test-Namen) und woran man es misst.
3. **Risiko:** welche bekannten Fälle es verschlechtern könnte (aus den config-Kommentaren, FINDINGS, DECISIONS), und welche Bench-Stufe
   das prüft (T0 pytest, T1 Probe, T2 regress mit Step-Cache, Clip-Bench; siehe docs/CONCEPT_fast_testing.md).
4. **Validierung in überschaubarer Zeit:** die genauen Befehle, z. B.
   `run_tests.py --rsm <fix-worktree> --only <tests> --seed <baseline-tag> --from-step refine` (Minuten), danach die ganze Suite.

## Neue Schnelltests
Tabelle: Test | Art (error / uncertain_correct) | Ursache | Clip-Dauer | Laufzeit | Ergebnis heute | Erwartung nach Fix.
Gesamtlaufzeit der neuen Tests. Hinweis, wie ein Test in die Repo-Bench übernommen wird (bench.json → regress_cases.json und
regress_landmarks.json).

## Offene Punkte
Was nicht geprüft wurde und warum (z. B. nicht geprüfte Stellen aus analysis.json, unklare Stellen, Tests, die nicht reproduzieren).
```
