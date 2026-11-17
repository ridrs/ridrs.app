// German texts for what the pipeline reports in English: status signals, verdicts and verdict reasons.
import type { StatusInfo } from "../state";
import type { Level, Verdict } from "../types";
import type { Tone } from "../ui/components";

export const LEVEL_DE: Record<Level, string> = { good: "gut", difficult: "schwierig", problem: "Problem" };
export const LEVEL_TONE: Record<Level, Tone> = { good: "ok", difficult: "warn", problem: "bad" };
export const VERDICT: Record<Verdict, { title: string; short: string; tone: Tone }> = {
  confident: { title: "Route gefunden (sicher)", short: "Route gefunden", tone: "ok" },
  uncertain: { title: "Route gefunden (unsicher)", short: "Route unsicher", tone: "warn" },
  no_route: { title: "Keine verlässliche Route", short: "Keine verlässliche Route", tone: "bad" },
};
export const VEHICLE_DE: Record<string, string> = { auto: "automatisch", bike: "Fahrrad", motorcycle: "Motorrad", car: "Auto" };

const mmss = (t: number) => `${Math.floor(Math.round(t) / 60)}:${String(Math.round(t) % 60).padStart(2, "0")}`;
const de = (x: string | number | undefined, digits = 1) => (x === undefined ? "?" : Number(x).toFixed(digits).replace(".", ","));

export function gloss(s: StatusInfo): { label: string; text: string } {
  const v = s.value;
  const pct = v !== undefined ? Math.round(v * 100) : 0;
  switch (s.signal) {
    case "motion_coverage":
      return { label: "Bildbewegung", text: s.level === "good" ? `Bewegung im Video gut erkennbar (${pct} % der Zeit nutzbar)` : s.level === "difficult" ? `Viel unbrauchbare Bewegung (nur ${pct} % nutzbar: Schnitte, Dunkelheit, Wackeln)` : `Zu wenig nutzbare Bewegung (${pct} %)` };
    case "rotation_quality":
      return { label: "Drehrate", text: s.level === "good" ? `Drehrate sauber (Rauschen ${de(v)}× Fahrrad-Niveau)` : `Drehrate verrauscht (${de(v)}× Fahrrad-Niveau, z. B. Motorrad oder Wackeln)` };
    case "calibration_peak":
      return { label: "Kalibrierung", text: s.level === "good" ? `Klares Maximum im Suchraum (${de(v)} nats/km über dem Median)` : s.level === "difficult" ? "Maximum flach oder am Rand des Suchraums" : "Kein klares Maximum: Route unsicher" };
    case "decoy_margin":
      return { label: "Vergleichsstrecken", text: s.level === "good" ? `Echte Route schlägt alle Vergleichsstrecken (Abstand ${de(v)} nats/km)` : "Eine Vergleichsstrecke ist so gut wie die echte oder besser" };
    case "area_size":
      if (s.key.endsWith("_route")) return { label: "Rand", text: s.level === "good" ? "Route bleibt im Ausschnitt" : `Route liegt zeitweise am Rand des Ausschnitts (${s.message.match(/for (\d+) %/)?.[1] ?? "?"} % der Zeit)` };
      return { label: "Ausschnitt", text: s.level === "good" ? "Ausschnitt groß genug für die Streckenlänge" : s.level === "difficult" ? "Ausschnitt knapp für die Streckenlänge" : "Ausschnitt wahrscheinlich zu klein für die Streckenlänge" };
    case "start_frame":
      return { label: "Startrahmen", text: s.level === "good" ? "Der Start der Route liegt im Startrahmen" : s.level === "difficult" ? `Start liegt am Rand des Startrahmens (${Math.round(v ?? 0)} m außerhalb, innerhalb der Toleranz)` : "Der Startrahmen passt zu keiner Route dieses Videos und wurde ignoriert" };
    case "end_frame":
      return { label: "Endrahmen", text: s.level === "good" ? "Das Ende der Route liegt im Endrahmen" : s.level === "difficult" ? `Ende liegt am Rand des Endrahmens (${Math.round(v ?? 0)} m außerhalb, innerhalb der Toleranz)` : "Der Endrahmen passt zu keiner Route dieses Videos und wurde ignoriert" };
    case "hint_corridor":
      return { label: "Routenhinweis", text: s.level === "good" ? "Route im Korridor um den Hinweis gefunden" : s.level === "difficult" ? hintCorridorText(s) : "Keine Straße im Korridor um den Hinweis: Hinweis ignoriert, ganzer Suchrahmen verwendet" };
    case "hint_agreement":
      return { label: "Übereinstimmung mit Hinweis", text: `${pct} % der berechneten Route liegen im Korridor des Hinweises (nur zur Information)` };
    case "local_pass":
      return { label: "Feinabgleich", text: s.level === "good" ? (pct >= 1 ? `Route mit allen Straßen nachgeprüft: ${pct} % der Strecke korrigiert` : "Route mit allen Straßen nachgeprüft: keine Änderung nötig") : "Nachprüfung mit allen Straßen nicht möglich; Ergebnis der Routensuche verwendet" };
    case "calibration_choice":
      return { label: "Kalibrierungswahl", text: (/physically implausible/.test(s.message) ? "Der höchste Punkt der Kalibrierung ist physikalisch unmöglich und wurde verworfen. " : "") + (s.level === "good" ? `${Math.round(v ?? 0)} Kalibrierungen geprüft; die plausibelste ergibt eine sichere Route` : `${Math.round(v ?? 0)} Kalibrierungen geprüft; keine ist eindeutig besser: Route unsicher`) };
    case "scene_cuts": {
      const ins = s.message.match(/; (\d+) inserted shots/)?.[1];
      return { label: "Schnitte", text: `Das Video ist geschnitten: ${Math.round(v ?? 0)} Schnitte; die Route springt dort, statt durchzufahren` + (ins ? `; ${ins} eingefügte Szenen (Titel, Nahaufnahmen) nicht verwendet` : "") };
    }
    case "intro_skipped":
      return { label: "Intro", text: `Intro bis ${mmss(v ?? 0)} übersprungen` + (/set by hand/.test(s.message ?? "") ? " (von Hand gesetzt)" : "") };
    case "parallel_street":
      return { label: "Parallele Straßen", text: `Das Video kann zwei parallele Straßen nicht unterscheiden; für ${pct} % der Strecke wurde die Hauptstraße angenommen` };
    case "route_disputed": {
      const spans = [...s.message.matchAll(/(\d+:\d\d)-(\d+:\d\d)/g)].map((m) => `${m[1]}–${m[2]}`).join(", ");
      return { label: "Strittiger Abschnitt", text: `Zwei Straßen passen hier zum Video${spans ? ` (${spans})` : ""}; die Route der Suche wurde beibehalten, weil die andere starke Kurven nicht erklärt oder nicht klar besser ist` };
    }
    case "video_truncated": {
      const m = s.message.match(/only (\d+:\d\d) of (\d+:\d\d)/);
      return { label: "Video beschädigt", text: `Die Videodatei ist beschädigt oder unvollständig: nur ${m ? `${m[1]} von ${m[2]}` : "ein Teil"} ließ sich lesen; die Route endet dort` };
    }
    case "odometry_gaps": {
      const spans = [...s.message.matchAll(/(\d+:\d\d)-(\d+:\d\d)/g)].map((m) => `${m[1]}–${m[2]}`).join(", ");
      return { label: "Wegmessung ausgefallen", text: `Die Wegmessung aus dem Bild ist hier ausgefallen${spans ? ` (${spans})` : ""}; die Strecke wurde aus dem Tempo davor und danach geschätzt` };
    }
    case "standstill": {
      const spans = [...s.message.matchAll(/(\d+:\d\d)-(\d+:\d\d)/g)].map((m) => `${m[1]}–${m[2]}`).join(", ");
      return { label: "Stillstand", text: `Die Kamera steht, obwohl sich im Bild etwas bewegt (vorbeifahrender Verkehr)${spans ? ` (${spans})` : ""}; die Position bleibt dort fest` };
    }
    case "bike_paths":
      if (/only roads are searched/.test(s.message)) return { label: "Radwege", text: "Suchgebiet zu groß für Radwege: nur Straßen werden durchsucht; ein kleineres Gebiet oder ein Streckenhinweis behält die Wege" };
      if (/memory limit/.test(s.message)) return { label: "Radwege", text: "Suchgebiet zu groß für alle Radwege: nur ein Teil der Wege wird durchsucht; ein kleineres Gebiet oder ein Streckenhinweis behält alle" };
      return { label: "Radwege", text: /bike-path result is used/.test(s.message) ? (s.level === "good" ? "Mit Radwegen, Wegen und Feldwegen gesucht: dieses Ergebnis ist besser und wird verwendet" : "Mit Radwegen gesucht: Ergebnis besser, aber nicht sicher; es wird verwendet") : "Auch mit Radwegen gesucht: kein besseres Ergebnis, die Straßenroute wird verwendet" };
    default:
      return { label: s.signal, text: s.message };
  }
}

function hintCorridorText(s: StatusInfo): string {
  if (/rerunning|full search frame gave/.test(s.message)) return /the full-frame result is used/.test(s.message) ? "Der Hinweis hat nicht gepasst: Ergebnis aus dem ganzen Suchrahmen (Ersatzlauf)" : "Hinweis-Korridor war schwach; der Ersatzlauf im ganzen Suchrahmen war nicht besser, Korridor-Ergebnis verwendet";
  return "Korridor um den Hinweis ist dünn: der Hinweis ist vielleicht zu schmal oder falsch";
}

// the verdict reasons of rsm/pipeline/verdict.py
const REASONS: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^calibration peak at the edge of the scan and flat$/, () => "Das Maximum der Kalibrierung liegt am Rand des Suchraums und ist flach"],
  [/^calibration peak at the edge of the scan$/, () => "Das Maximum der Kalibrierung liegt am Rand des Suchraums"],
  [/^calibration peak only ([\d.]+) nats\/km above the surface median$/, (m) => `Das Maximum der Kalibrierung liegt nur ${de(m[1])} nats/km über dem Median`],
  [/^mean posterior ([\d.]+) < ([\d.]+)$/, (m) => `Mittlere Sicherheit ${de(m[1], 2)} (unter ${de(m[2], 2).replace(/0$/, "")})`],
  [/^(\d+) % of the time with posterior < 0\.5$/, (m) => `${m[1]} % der Zeit mit geringer Sicherheit`],
  [/^usable motion (\d+) % < (\d+) %$/, (m) => `Nur ${m[1]} % des Videos mit nutzbarer Bewegung (unter ${m[2]} %)`],
  [/^heading noise ([\d.]+)x the bike level$/, (m) => `Drehrate verrauscht (${de(m[1])}× Fahrrad-Niveau)`],
  [/^two calibration candidates of similar quality give different routes$/, () => "Zwei ähnlich gute Kalibrierungen ergeben verschiedene Routen"],
  [/^the calibration needs more speed or lateral acceleration than a road vehicle has$/, () => "Die Kalibrierung verlangt mehr Tempo oder Querbeschleunigung, als ein Straßenfahrzeug hat"],
];
/** a known reason in German; an unknown one unchanged, to be marked lang="en" */
export function reasonDe(r: string): { text: string; known: boolean } {
  for (const [re, f] of REASONS) { const m = r.match(re); if (m) return { text: f(m), known: true }; }
  return { text: r, known: false };
}
