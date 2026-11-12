// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  DataDrop,
  DroppedFile,
  DroppedFileVerdict,
  FileDrop,
  RouteImportPreview,
  Workout,
} from '@ridrs/contracts';
import {
  analyseWorkoutEntry,
  analyseWorkoutFile,
  chooseWorkoutId,
  type WorkoutAnalysis,
} from '@ridrs/workout';

/** A workout of the ridrs library as far as recognising duplicates needs it. */
export interface KnownWorkout {
  readonly id: string;
  readonly name: string;
  readonly originalHash?: string;
}

/** What the drops need from the rest of the app; the plugin's context in the app. */
export interface DropServices {
  readonly drop?: DataDrop;
  /** The providers of `route.import` that can import now. */
  routeProviders(): readonly string[];
  /** The workouts of the ridrs library. */
  knownWorkouts(): readonly KnownWorkout[];
  preview(provider: string, file: string): Promise<RouteImportPreview>;
  importRoute(provider: string, file: string): Promise<void>;
  /** Saves a workout with its original; `false` when the library refused it. */
  saveWorkout(workout: Workout, original: { readonly fileName: string; readonly data: string }): Promise<boolean>;
  /** When the file is read, as an ISO time: the workouts' `importedAt`. */
  now(): string;
  /** Why an import of a dragged file failed. */
  warn?(message: string): void;
}

/** A workout found in a file, with what saving it needs. */
type Found = Extract<WorkoutAnalysis, { kind: 'workout' }>;

/** Entries of a ZIP that may be workouts. */
const WORKOUT_ENTRY = /\.(zwo|fit|erg|mrc|tcx|txt|md)$/i;

const extensionOf = (name: string) => name.slice(name.lastIndexOf('.') + 1).toLowerCase();

const toBase64 = (bytes: Uint8Array) => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const refused = (reason: string): DroppedFileVerdict['verdict'] => ({ kind: 'refused', reason });

/** One file of the drag: its verdict, and its workouts' bytes for saving them. */
interface Entry {
  readonly file: DroppedFile;
  verdict: DroppedFileVerdict['verdict'];
  found: Found[];
  readonly read: Promise<void>;
}

/**
 * The files dragged onto the window (ADR 0093): what each is, as the app state `file.drop` shows
 * it while they hover, and adding them to the library once they are let go over the layer that
 * shows them. A file is a video route when a provider of `route.import` previews it, else the
 * workouts it holds, else nothing ridrs can import.
 */
export class FileDrops {
  private files: Entry[] | undefined;
  private drag = 0;
  private outcome: Extract<FileDrop, { phase: 'done' }> | undefined;
  private importing = false;

  constructor(
    private readonly services: DropServices,
    private readonly publish: (state: FileDrop | undefined) => void,
  ) {}

  /** Listens to `data.drop`; returns the end of it. */
  connect(): () => void {
    return (
      this.services.drop?.subscribe((event) => {
        if (event.kind === 'enter') this.enter(event.files);
        else if (event.kind === 'leave') this.leave();
      }) ?? (() => {})
    );
  }

  /** Resolves once every file of the drag is read. */
  async read(): Promise<void> {
    await Promise.all((this.files ?? []).map((entry) => entry.read));
  }

  enter(files: readonly DroppedFile[]): void {
    this.drag += 1;
    const drag = this.drag;
    this.outcome = undefined;
    this.importing = false;
    this.files = files.map((file) => {
      const entry: Entry = {
        file,
        verdict: { kind: 'reading' },
        found: [],
        read: this.recognise(file).then(
          ({ verdict, found }) => {
            if (drag !== this.drag) return;
            entry.verdict = verdict;
            entry.found = found;
            this.show();
          },
          (error: unknown) => {
            if (drag !== this.drag) return;
            entry.verdict = refused(error instanceof Error ? error.message : String(error));
            this.show();
          },
        ),
      };
      return entry;
    });
    this.show();
  }

  leave(): void {
    this.drag += 1;
    this.files = undefined;
    this.outcome = undefined;
    this.importing = false;
    this.publish(undefined);
  }

  /**
   * Adds the files of the drag: the workouts the library has not got to the ridrs library, the
   * video routes through their provider. Once is enough: the same drag is not added twice.
   */
  async import(): Promise<void> {
    const drag = this.drag;
    if (!this.files || this.importing || this.outcome) return;
    this.importing = true;
    this.show();
    await this.read();
    if (drag !== this.drag || !this.files) return;
    const known = this.services.knownWorkouts();
    const taken = new Set(known.map((workout) => workout.id));
    const seen = new Set(known.flatMap((workout) => (workout.originalHash ? [`${workout.originalHash}|${workout.name}`] : [])));
    let saved = 0;
    let skipped = 0;
    let routes = 0;
    let failed = 0;
    for (const entry of this.files) {
      const { verdict } = entry;
      if (verdict.kind === 'route') {
        try {
          await this.services.importRoute(verdict.provider, entry.file.id);
          routes += 1;
        } catch (error) {
          this.services.warn?.(`${entry.file.name}: ${String(error)}`);
          failed += 1;
        }
      } else if (verdict.kind === 'workouts') {
        for (const found of entry.found) {
          const signature = `${found.hash}|${found.workout.name}`;
          if (seen.has(signature)) {
            skipped += 1;
            continue;
          }
          seen.add(signature);
          const id = chooseWorkoutId(found.workout.id, found.hash, taken, false);
          taken.add(id);
          const workout = { ...found.workout, id, source: { ...found.workout.source, originalHash: found.hash } };
          const ok = await this.services
            .saveWorkout(workout, { fileName: found.fileName, data: toBase64(found.bytes) })
            .catch((error: unknown) => {
              this.services.warn?.(`${found.fileName}: ${String(error)}`);
              return false;
            });
          if (ok) saved += 1;
          else failed += 1;
        }
      }
    }
    if (drag !== this.drag) return;
    this.importing = false;
    this.outcome = { phase: 'done', files: this.snapshot(), saved, skipped, routes, failed };
    this.show();
  }

  /** The files as the state shows them; a workout dragged twice at once is added once. */
  private snapshot(): FileDrop['files'] {
    const seen = new Set<string>();
    return (this.files ?? []).map(({ file, verdict, found }) => {
      if (verdict.kind !== 'workouts') return { id: file.id, name: file.name, size: file.size, verdict };
      const workouts = verdict.workouts.map((shown, index) => {
        const analysis = found[index];
        const signature = analysis ? `${analysis.hash}|${analysis.workout.name}` : undefined;
        const twice = signature !== undefined && seen.has(signature);
        if (signature) seen.add(signature);
        return twice ? { ...shown, state: 'duplicate' as const } : shown;
      });
      return { id: file.id, name: file.name, size: file.size, verdict: { ...verdict, workouts } };
    });
  }

  private show(): void {
    if (!this.files) return;
    if (this.outcome) this.publish({ ...this.outcome, files: this.snapshot() });
    else this.publish({ phase: this.importing ? 'importing' : 'over', files: this.snapshot() });
  }

  /** What a file is: a video route, workouts, or nothing ridrs can import. */
  private async recognise(file: DroppedFile): Promise<{ verdict: DroppedFileVerdict['verdict']; found: Found[] }> {
    const peek = await file.peek();
    const cannot = `ridrs cannot import ${file.name}`;
    if (peek.entries) {
      let reason: string | undefined;
      for (const provider of this.services.routeProviders()) {
        const answer = await this.services.preview(provider, file.id);
        if (answer.ok) return { verdict: { kind: 'route', provider, preview: answer.preview }, found: [] };
        reason ??= answer.reason;
      }
      if (extensionOf(file.name) === 'ride') return { verdict: refused(reason ?? cannot), found: [] };
      const analyses: WorkoutAnalysis[] = [];
      for (const entry of peek.entries) {
        if (!entry.bytes || !WORKOUT_ENTRY.test(entry.name)) continue;
        analyses.push(...(await analyseWorkoutEntry({ fileName: entry.name, bytes: entry.bytes }, this.services.now())));
      }
      return this.workoutsOf(analyses, reason ?? cannot);
    }
    if (!peek.bytes) return { verdict: refused(cannot), found: [] };
    return this.workoutsOf(await analyseWorkoutFile({ fileName: file.name, bytes: peek.bytes }, this.services.now()), cannot);
  }

  private workoutsOf(
    analyses: readonly WorkoutAnalysis[],
    reason: string,
  ): { verdict: DroppedFileVerdict['verdict']; found: Found[] } {
    const found = analyses.filter((analysis): analysis is Found => analysis.kind === 'workout');
    if (found.length === 0) return { verdict: refused(reason), found };
    const known = new Set(
      this.services.knownWorkouts().flatMap((workout) => (workout.originalHash ? [`${workout.originalHash}|${workout.name}`] : [])),
    );
    return {
      verdict: {
        kind: 'workouts',
        workouts: found.map((analysis) => ({
          workout: analysis.workout,
          state: known.has(`${analysis.hash}|${analysis.workout.name}`) ? 'duplicate' : analysis.state,
        })),
      },
      found,
    };
  }
}
