// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Correction, IntervalType, WorkoutStructure } from '@tabata-sync/contracts';
import {
  type DraftBoundary,
  draftOf,
  finalizeDraft,
  gridDraft,
  markChange,
  moveBoundary,
  placeMark,
  removeBoundary,
  retypeBoundary,
  structureOf,
} from './draft.ts';
import { t } from './i18n/index.ts';
import { positionAt } from './timeline.ts';

interface TrackSummary {
  readonly variantId: string;
  readonly title: string | null;
  readonly artist: string | null;
  readonly durationSec: number;
  readonly bpm: number | null;
  readonly pattern?: WorkoutStructure['pattern'];
  readonly corrected?: boolean;
}

interface Comparison {
  readonly matched: Array<{ errorMs: number }>;
  readonly missedByAutomatic: number[];
}

interface WorkoutResponse {
  readonly structure: WorkoutStructure;
  readonly durationSec: number;
  readonly comparison?: Comparison;
  readonly error?: string;
}

const TYPES: readonly IntervalType[] = ['warmup', 'work', 'recovery', 'cooldown', 'other'];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const audio = $<HTMLAudioElement>('audio');
const playButton = $<HTMLButtonElement>('play');
const editButton = $<HTMLButtonElement>('edit');
const timeline = $<HTMLDivElement>('timeline');
const blocks = $<HTMLDivElement>('blocks');
const playhead = $<HTMLDivElement>('playhead');
const editor = $<HTMLElement>('editor');
const boundaryList = $<HTMLOListElement>('boundaries');

let track: TrackSummary | null = null;
let workout: WorkoutResponse | null = null;
let durationSec = 0;
let blockElements: HTMLDivElement[] = [];
/** The labeling being edited; null while just playing. */
let draft: DraftBoundary[] | null = null;
let dirty = false;

function clock(sec: number, tenths = false): string {
  if (tenths) {
    const d = Math.floor(Math.max(0, sec) * 10);
    return `${Math.floor(d / 600)}:${((d % 600) / 10).toFixed(1).padStart(4, '0')}`;
  }
  const s = Math.max(0, sec);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function typeLabel(type: IntervalType): string {
  return t(`type.${type}`);
}

function patternLabel(pattern: WorkoutStructure['pattern'] | undefined): string {
  if (!pattern || pattern.rounds === 0) return t('noWorkout');
  if (pattern.regular && pattern.workSec && pattern.recoverySec) {
    return t('patternRegular', { rounds: pattern.rounds, work: Math.round(pattern.workSec), recovery: Math.round(pattern.recoverySec) });
  }
  return t('patternIrregular', { rounds: pattern.rounds });
}

/** What the timeline shows: the draft while editing, otherwise the stored workout. */
function shown(): WorkoutStructure | null {
  if (draft) return structureOf(draft, durationSec);
  return workout?.structure ?? null;
}

async function loadLibrary(): Promise<void> {
  const tracks = (await (await fetch('/api/tracks')).json()) as TrackSummary[];
  const list = $<HTMLUListElement>('tracks');
  list.replaceChildren();
  if (tracks.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = t('noTracks');
    list.append(empty);
    return;
  }
  for (const entry of tracks) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.variant = entry.variantId;
    button.setAttribute('aria-current', String(entry.variantId === track?.variantId));
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = entry.title ?? entry.variantId;
    const info = document.createElement('span');
    info.className = 'info';
    info.textContent = [
      clock(entry.durationSec),
      entry.bpm ? t('bpm', { bpm: Math.round(entry.bpm) }) : '',
      patternLabel(entry.pattern),
      entry.corrected ? t('corrected') : '',
    ]
      .filter(Boolean)
      .join(' · ');
    button.append(name, info);
    button.addEventListener('click', () => void selectTrack(entry));
    item.append(button);
    list.append(item);
  }
}

async function selectTrack(next: TrackSummary): Promise<void> {
  if (dirty && !confirm(t('confirmDiscard'))) return;
  closeEditor();
  track = next;
  for (const b of document.querySelectorAll<HTMLButtonElement>('.tracks button')) {
    b.setAttribute('aria-current', String(b.dataset.variant === next.variantId));
  }
  $('track-title').textContent = next.title ?? '';
  $('track-meta').textContent = t('loading');
  playButton.disabled = true;
  editButton.disabled = true;
  workout = null;
  try {
    const response = await fetch(`/api/tracks/${encodeURIComponent(next.variantId)}/workout`);
    const body = (await response.json()) as WorkoutResponse;
    if (!response.ok) throw new Error(body.error ?? response.statusText);
    showWorkout(body);
  } catch (error) {
    $('track-meta').textContent = t('loadFailed', { error: (error as Error).message });
    return;
  }
  audio.src = `/media/${encodeURIComponent(next.variantId)}`;
  audio.playbackRate = Number($<HTMLSelectElement>('speed').value);
  playButton.disabled = false;
  editButton.disabled = false;
  render();
}

function showWorkout(body: WorkoutResponse): void {
  workout = body;
  durationSec = body.durationSec;
  const parts = [track?.bpm ? t('bpm', { bpm: Math.round(track.bpm) }) : '', patternLabel(body.structure.pattern)];
  if (body.comparison) {
    const { matched, missedByAutomatic } = body.comparison;
    const error = matched.length ? matched.reduce((s, m) => s + Math.abs(m.errorMs), 0) / matched.length / 1000 : 0;
    parts.push(t('correctedComparison', { matched: matched.length, total: matched.length + missedByAutomatic.length, error: error.toFixed(2) }));
  }
  $('track-meta').textContent = parts.filter(Boolean).join(' · ');
  renderBlocks();
}

function renderBlocks(): void {
  blocks.replaceChildren();
  blockElements = (shown()?.intervals ?? []).map((interval) => {
    const block = document.createElement('div');
    block.className = 'block';
    block.dataset.type = interval.type;
    if (interval.deviation) block.dataset.deviation = 'true';
    block.style.left = `${(interval.startSec / durationSec) * 100}%`;
    block.style.width = `${((interval.endSec - interval.startSec) / durationSec) * 100}%`;
    block.title = `${typeLabel(interval.type)}${interval.round ? ` ${interval.round}` : ''}: ${clock(interval.startSec, true)}–${clock(interval.endSec, true)}`;
    if (interval.type === 'work' && interval.round) block.textContent = String(interval.round);
    blocks.append(block);
    return block;
  });
}

/** Everything on screen derives from `audio.currentTime`; there is no separate timer. */
function render(): void {
  const time = audio.currentTime;
  const total = Number.isFinite(audio.duration) ? audio.duration : durationSec;
  // Tenths, so boundaries can be read off for corrections.
  $('clock').textContent = `${clock(time, true)} / ${clock(total)}`;
  playhead.style.left = `${total > 0 ? (time / total) * 100 : 0}%`;
  timeline.setAttribute('aria-valuenow', String(Math.round(time)));
  playButton.textContent = audio.paused ? '▶' : '❚❚';
  playButton.setAttribute('aria-label', audio.paused ? t('play') : t('pause'));
  const structure = shown();
  if (!structure) return;

  const position = positionAt(structure, time);
  blockElements.forEach((block, k) => {
    block.dataset.played = String((structure.intervals[k]?.endSec ?? 0) <= time);
  });
  const phase = $('phase');
  const interval = position.interval;
  phase.dataset.type = interval?.type ?? '';
  phase.textContent = interval ? typeLabel(interval.type) : '';
  $('countdown').textContent = interval ? String(Math.ceil(position.remainingSec)) : '';
  const parts: string[] = [];
  if (position.totalRounds > 0 && (interval?.type === 'work' || interval?.type === 'recovery')) {
    parts.push(t('round', { round: Math.max(1, position.round), total: position.totalRounds }));
  }
  if (interval?.type === 'cooldown' && position.completedRounds === position.totalRounds) parts.push(t('workoutDone'));
  // Round up like the big countdown, so both always show the same second.
  else if (position.next) parts.push(t('next', { type: typeLabel(position.next.type), time: clock(Math.ceil(position.remainingSec)) }));
  $('detail').textContent = parts.join(' · ');
  $<HTMLDivElement>('progress-fill').style.width = `${position.workoutProgress * 100}%`;
  if (draft) {
    const current = draft.findLastIndex((b) => b.atSec <= time);
    for (const [k, row] of [...boundaryList.children].entries()) row.setAttribute('aria-current', String(k === current));
  }
}

function loop(): void {
  render();
  requestAnimationFrame(loop);
}

// --- Corrections ---

function openEditor(): void {
  if (!workout) return;
  editor.hidden = false;
  editButton.setAttribute('aria-pressed', 'true');
  updateDraft(draftOf(workout.structure), false);
}

function closeEditor(): void {
  draft = null;
  dirty = false;
  editor.hidden = true;
  editButton.setAttribute('aria-pressed', 'false');
  renderBlocks();
}

function updateDraft(next: DraftBoundary[], changed = true): void {
  draft = next;
  dirty = changed;
  setStatus(dirty ? t('unsaved') : '');
  $<HTMLButtonElement>('save').disabled = !dirty;
  renderBlocks();
  renderBoundaryList();
}

function setStatus(text: string): void {
  $('editor-status').textContent = text;
}

function renderBoundaryList(): void {
  boundaryList.replaceChildren(
    ...(draft ?? []).map((boundary, index) => {
      const row = document.createElement('li');
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.dataset.type = boundary.type;
      const fixed = index === 0 && boundary.atSec === 0;

      const time = document.createElement('input');
      time.type = 'number';
      time.step = '0.1';
      time.min = '0';
      time.value = boundary.atSec.toFixed(2);
      time.disabled = fixed;
      time.addEventListener('change', () => {
        const value = Number(time.value);
        if (draft && Number.isFinite(value)) updateDraft(moveBoundary(draft, index, value));
      });

      const type = document.createElement('select');
      for (const option of TYPES) type.append(new Option(typeLabel(option), option, false, option === boundary.type));
      type.addEventListener('change', () => draft && updateDraft(retypeBoundary(draft, index, type.value as IntervalType)));

      const listen = document.createElement('button');
      listen.type = 'button';
      listen.textContent = '▶';
      listen.title = t('listen');
      listen.setAttribute('aria-label', t('listen'));
      listen.addEventListener('click', () => {
        audio.currentTime = Math.max(0, boundary.atSec - 3);
        void audio.play();
      });

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.title = t('remove');
      remove.setAttribute('aria-label', t('remove'));
      remove.disabled = fixed;
      remove.addEventListener('click', () => draft && updateDraft(removeBoundary(draft, index)));

      row.append(swatch, time, type, listen, remove);
      return row;
    }),
  );
}

async function sendCorrections(method: 'POST' | 'DELETE', correction?: Correction): Promise<void> {
  if (!track) return;
  try {
    const response = await fetch(`/api/tracks/${encodeURIComponent(track.variantId)}/corrections`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(correction ?? {}),
    });
    const body = (await response.json()) as WorkoutResponse;
    if (!response.ok) throw new Error(body.error ?? response.statusText);
    showWorkout(body);
    if (draft) updateDraft(draftOf(body.structure), false);
    setStatus(t('saved'));
    void loadLibrary();
  } catch (error) {
    setStatus(t('saveFailed', { error: (error as Error).message }));
  }
}

function mark(type?: IntervalType): void {
  if (!draft) return;
  const time = audio.currentTime;
  updateDraft(type ? placeMark(draft, time, type) : markChange(draft, time));
}

editButton.addEventListener('click', () => {
  if (!draft) openEditor();
  else if (!dirty || confirm(t('confirmDiscard'))) closeEditor();
});
for (const button of editor.querySelectorAll<HTMLButtonElement>('.mark')) {
  button.addEventListener('click', () => mark(button.dataset.mark as IntervalType));
}
$('save').addEventListener('click', () => {
  if (draft) void sendCorrections('POST', { action: 'set_boundaries', boundaries: finalizeDraft(draft) });
});
$('discard').addEventListener('click', () => {
  if (workout) updateDraft(draftOf(workout.structure), false);
});
$('reset').addEventListener('click', () => {
  if (confirm(t('confirmReset'))) void sendCorrections('DELETE');
});
$<HTMLFormElement>('grid').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = new FormData(event.target as HTMLFormElement);
  const value = (name: string) => Number(form.get(name));
  updateDraft(gridDraft(value('start'), value('work'), value('recovery'), Math.max(1, Math.round(value('rounds')))));
});

// --- Transport ---

function seekToPointer(event: PointerEvent): void {
  const rect = timeline.getBoundingClientRect();
  const total = Number.isFinite(audio.duration) ? audio.duration : durationSec;
  audio.currentTime = Math.min(total, Math.max(0, ((event.clientX - rect.left) / rect.width) * total));
}

function togglePlay(): void {
  if (audio.paused) void audio.play();
  else audio.pause();
}

playButton.addEventListener('click', togglePlay);
timeline.addEventListener('pointerdown', (event) => {
  if (!workout) return;
  timeline.setPointerCapture(event.pointerId);
  seekToPointer(event);
});
timeline.addEventListener('pointermove', (event) => {
  if (timeline.hasPointerCapture(event.pointerId)) seekToPointer(event);
});
timeline.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowRight') audio.currentTime += 5;
  if (event.key === 'ArrowLeft') audio.currentTime = Math.max(0, audio.currentTime - 5);
});
document.addEventListener('keydown', (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || event.metaKey || event.ctrlKey || event.altKey) return;
  if (playButton.disabled || event.repeat) return;
  const key = event.key.toLowerCase();
  if (event.code === 'Space') {
    event.preventDefault();
    // While correcting and playing, Space marks what is heard; otherwise it plays and pauses.
    if (draft && !audio.paused) mark();
    else togglePlay();
  } else if (draft && key === 'w') mark('work');
  else if (draft && key === 'r') mark('recovery');
  else if (draft && key === 'e') mark('cooldown');
  else if (key === 'p') togglePlay();
});
$<HTMLSelectElement>('speed').addEventListener('change', (event) => {
  audio.playbackRate = Number((event.target as HTMLSelectElement).value);
});
window.addEventListener('beforeunload', (event) => {
  if (dirty) event.preventDefault();
});

document.title = t('appTitle');
$('app-title').textContent = t('library');
$('speed-label').textContent = t('speed');
$('track-title').textContent = t('selectTrack');
editButton.textContent = t('correct');
const MARK_LABELS = { work: 'markWork', recovery: 'markRecovery', cooldown: 'markEnd' } as const;
for (const button of editor.querySelectorAll<HTMLButtonElement>('.mark')) {
  (button.firstElementChild as HTMLElement).textContent = t(MARK_LABELS[button.dataset.mark as keyof typeof MARK_LABELS]);
}
$('mark-hint').textContent = t('markHint');
$('grid-title').textContent = t('gridTitle');
$('grid-start').textContent = t('gridStart');
$('grid-work').textContent = t('gridWork');
$('grid-recovery').textContent = t('gridRecovery');
$('grid-rounds').textContent = t('gridRounds');
$('grid-apply').textContent = t('gridApply');
$('save').textContent = t('save');
$('discard').textContent = t('discard');
$('reset').textContent = t('resetAutomatic');
timeline.setAttribute('aria-label', t('timelineLabel'));
timeline.setAttribute('aria-valuemin', '0');
void loadLibrary();
loop();
