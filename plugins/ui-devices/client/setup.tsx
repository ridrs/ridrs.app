// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type BleRoute,
  bridgeConnectRequestedEvent,
  bridgeForgetRequestedEvent,
  type ControllerButton,
  type DeviceCandidate,
  type DeviceStatus,
  deviceConnectRequestedEvent,
  deviceDiscoveryRequestedEvent,
  deviceForgetRequestedEvent,
  type TrainerControlChangedPayload,
  trainerControlChangedEvent,
} from '@ridrs/contracts';
import type { UiContext } from '@ridrs/ui-sdk';
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';
import {
  BUTTON_FACES,
  type BridgeStatus,
  byDevice,
  type CompanionRow,
  type DeviceRow,
  describeCompanion,
  describeDevices,
  HEART_RATE_THOUGHTS,
  inShownOrder,
  linkOf,
  overLinksInReach,
  type Readings,
  type RowKind,
  signalBars,
  summarize,
  type Tone,
} from './devices.ts';
import {
  ArrowIcon,
  BikeIcon,
  BoltIcon,
  BulbIcon,
  COLORS,
  DeviceStyles,
  FactIcon,
  type FactKind,
  KindIcon,
  LinkIcon,
  PhoneIcon,
  TrashIcon,
} from './theme.tsx';

/** Where Continue leads. */
const MAIN = 'main';

const TONE_COLOR: Record<Tone, string> = {
  ok: COLORS.lime,
  busy: COLORS.cyan,
  warn: COLORS.amber,
  none: COLORS.muted,
};

const BADGE = {
  minWidth: 22,
  height: 22,
  padding: '0 4px',
  boxSizing: 'border-box',
  borderRadius: 11,
  display: 'grid',
  placeItems: 'center',
  background: COLORS.lime,
  color: '#031',
  fontSize: 13,
  fontStyle: 'normal',
  fontWeight: 900,
} as const;

/** The d-pad buttons show an arrow icon, turned from "up" by these degrees. */
const ARROWS = { up: 0, right: 90, down: 180, left: 270 } as const;

/** Arrows and the power-up bolt are drawn, so they match in size and colour; the rest is text. */
function ButtonFace({ button }: { readonly button: ControllerButton }) {
  if (button in ARROWS) {
    return <ArrowIcon rotate={ARROWS[button as keyof typeof ARROWS]} />;
  }
  if (button === 'power-up-left' || button === 'power-up-right') {
    return <BoltIcon />;
  }
  return BUTTON_FACES[button].symbol;
}

/**
 * The "ok" badge: a check, or the buttons held down on the controller in its place, one badge
 * each (named for screen readers by `aria-label`).
 */
function OkBadges({ row }: { readonly row: Pick<DeviceRow, 'held'> }) {
  if (row.held && row.held.length > 0) {
    return row.held.map((button) => (
      <span
        key={button}
        role="img"
        data-testid="status-badge"
        data-button={button}
        data-symbol={BUTTON_FACES[button].symbol}
        aria-label={BUTTON_FACES[button].name}
        style={BADGE}
      >
        <ButtonFace button={button} />
      </span>
    ));
  }
  return (
    <span aria-hidden data-testid="status-badge" style={BADGE}>
      ✓
    </span>
  );
}

/** Smaller icons sit centred in a badge-wide slot, so every icon shares one centre line. */
const ICON_SLOT = { width: BADGE.minWidth, display: 'grid', placeItems: 'center' } as const;

/** What a status shows: text, tone and, on a connected controller, the buttons held down. */
type StatusView = Pick<DeviceRow, 'status' | 'tone' | 'held'>;

function Status({
  row,
  testId,
  warnIcon = true,
}: {
  readonly row: StatusView;
  readonly testId?: string;
  /** Off for the companion: not connected, it is no fault to warn about. */
  readonly warnIcon?: boolean;
}) {
  return (
    <span
      role="status"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        fontSize: 14,
        whiteSpace: 'nowrap',
        color: TONE_COLOR[row.tone],
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {/* Text first, icon last: right-aligned rows put every icon in one column. */}
      {testId ? <span data-testid={testId}>{row.status}</span> : row.status}
      {row.tone === 'ok' && <OkBadges row={row} />}
      {row.tone === 'busy' && (
        <span aria-hidden style={ICON_SLOT}>
          <span className="rd-spin" />
        </span>
      )}
      {(row.tone === 'none' || (row.tone === 'warn' && !warnIcon)) && (
        <span aria-hidden style={ICON_SLOT} />
      )}
      {row.tone === 'warn' && warnIcon && (
        <span aria-hidden style={ICON_SLOT}>
          ⚠
        </span>
      )}
    </span>
  );
}

const PANEL = {
  border: `1.5px solid ${COLORS.line}`,
  borderRadius: 18,
  background: COLORS.panel,
} as const;

/** A count in a pill, centred on the line it sits in; upright, whatever the text around it. */
const COUNT = {
  flex: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 22,
  height: 20,
  padding: '0 7px',
  boxSizing: 'border-box',
  borderRadius: 10,
  border: `1.5px solid ${COLORS.cyan}`,
  color: COLORS.cyan,
  fontSize: 12,
  fontStyle: 'normal',
  fontWeight: 700,
  lineHeight: 1,
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
} as const;

/** "+2": more devices of the kind were found; the details offer to connect one of them. */
function MoreFound({ count }: { readonly count: number }) {
  return (
    <span
      data-testid="more-found"
      role="img"
      aria-label={`${count} more found`}
      title={`${count} more found`}
      style={COUNT}
    >
      {`+${count}`}
    </span>
  );
}

/** "2 found": while the kind searches, the devices of the kind found, a forgotten one too. */
function FoundCount({ count }: { readonly count: number }) {
  return (
    <span data-testid="found-count" style={COUNT}>
      {`${count} found`}
    </span>
  );
}

/** A row of the setup: one box, the whole of it a button. */
const ROW = {
  ...PANEL,
  width: '100%',
  display: 'grid',
  gridTemplateColumns: '44px 1fr auto 12px',
  alignItems: 'center',
  gap: 10,
  padding: '12px 14px',
  color: 'inherit',
  font: 'inherit',
  textAlign: 'left',
} as const;

const ROW_TITLE = {
  fontSize: 18,
  lineHeight: 1.25,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const;

function Row({
  icon,
  title,
  detail,
  status,
  more = 0,
  found = 0,
  kind,
  warnIcon,
  onOpen,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly detail: string;
  readonly status: StatusView;
  readonly warnIcon?: boolean;
  readonly more?: number;
  readonly found?: number;
  readonly kind: string;
  readonly onOpen: () => void;
}) {
  return (
    <li data-testid="device-row" data-kind={kind}>
      <button
        type="button"
        className="rd-row"
        onClick={onOpen}
        style={ROW}
      >
        <span style={{ display: 'flex', justifyContent: 'center', color: COLORS.cyan }}>
          {icon}
        </span>
        <span style={{ minWidth: 0 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <b data-testid="device-title" style={ROW_TITLE}>
              {title}
            </b>
            {more > 0 && <MoreFound count={more} />}
          </span>
          <small
            data-testid="device-detail"
            style={{ display: 'block', color: COLORS.muted, fontSize: 13 }}
          >
            {detail}
          </small>
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          {found > 0 && <FoundCount count={found} />}
          <Status row={status} {...(warnIcon === undefined ? {} : { warnIcon })} />
        </span>
        <span aria-hidden style={{ color: COLORS.muted, fontStyle: 'normal' }}>
          ›
        </span>
      </button>
    </li>
  );
}

const BUTTON = {
  padding: '10px 16px',
  fontSize: 16,
  fontWeight: 700,
  fontStyle: 'italic',
  color: '#fff',
  background: '#0a2230',
  border: `1.5px solid ${COLORS.cyan}`,
  borderRadius: 12,
} as const;

/** One line of the details grid: the term and its value, with an icon. */
interface Fact {
  readonly icon: FactKind;
  readonly term: string;
  readonly value: ReactNode;
  readonly tone?: Tone;
}

/** At most two facts per line; a value too long for its half is cut, never wrapped. */
function Facts({ facts }: { readonly facts: readonly Fact[] }) {
  return (
    <dl
      data-testid="device-details"
      style={{
        margin: 0,
        display: 'grid',
        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        gap: '8px 16px',
        fontSize: 15,
      }}
    >
      {facts.map(({ icon, term, value, tone }) => (
        <div
          key={term}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            minWidth: 0,
            whiteSpace: 'nowrap',
          }}
        >
          <span style={{ display: 'flex', color: COLORS.muted }}>
            <FactIcon icon={icon} />
          </span>
          <dt style={{ color: COLORS.muted }}>{term}</dt>
          <dd
            style={{
              margin: 0,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              ...(tone ? { color: TONE_COLOR[tone] } : {}),
            }}
          >
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

const TONE_ICON: Record<Tone, ReactNode> = {
  ok: '✓',
  busy: <span className="rd-spin" />,
  warn: '⚠',
  none: '○',
};

/** The status in the details' top bar: a pill in the tone's colour. */
function StatusPill({ status, tone }: { readonly status: string; readonly tone: Tone }) {
  return (
    <span
      role="status"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 12px',
        borderRadius: 999,
        border: `1.5px solid ${TONE_COLOR[tone]}`,
        background: `${TONE_COLOR[tone]}1a`,
        color: TONE_COLOR[tone],
        fontSize: 14,
        whiteSpace: 'nowrap',
      }}
    >
      <span aria-hidden style={{ display: 'flex', fontStyle: 'normal' }}>
        {TONE_ICON[tone]}
      </span>
      <span data-testid="details-status">{status}</span>
    </span>
  );
}

function Tip({ tip }: { readonly tip: string }) {
  return (
    <aside style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <span style={{ color: COLORS.amber }}>
        <BulbIcon />
      </span>
      <span style={{ fontSize: 14 }}>
        <b style={{ display: 'block' }}>Tip</b>
        <span data-testid="details-tip" style={{ color: COLORS.muted }}>
          {tip}
        </span>
      </span>
    </aside>
  );
}

/** The card's top line: laid out like a device found, its status where the link's chevron is. */
const CARD_HEADER = {
  display: 'grid',
  gridTemplateColumns: ROW.gridTemplateColumns,
  alignItems: 'center',
  gap: ROW.gap,
  padding: ROW.padding,
} as const;

/**
 * A row's current device: one card in place of the rows, with no box inside; the page above it
 * names the kind. On top the device as a device found shows it: its icon and name, a line with
 * how it is linked, the link's icon and signal, and its status as its row has it, with the check
 * and the reading. Below, the facts the top does not show, a tip while there is something to do,
 * and the actions.
 */
function DetailsCard({
  icon,
  device,
  line,
  found,
  status,
  warnIcon = true,
  facts = [],
  tip,
  children,
}: {
  readonly icon: ReactNode;
  /** The device, or what kind of device would fit: the kind is the page's heading. */
  readonly device: string;
  readonly line?: string | undefined;
  /** The device as its link sees it: the link's icon and the signal. */
  readonly found?: DeviceCandidate | undefined;
  readonly status: StatusView;
  readonly warnIcon?: boolean;
  readonly facts?: readonly Fact[];
  readonly tip?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <section aria-label={device} data-testid="details-card" style={PANEL}>
      <header data-testid="card-header" style={CARD_HEADER}>
        <span style={{ display: 'flex', justifyContent: 'center', color: COLORS.cyan }}>
          {icon}
        </span>
        <span style={{ minWidth: 0 }}>
          <h2
            data-testid="details-device"
            style={{ ...ROW_TITLE, display: 'block', margin: 0, fontWeight: 700 }}
          >
            {device}
          </h2>
          {line && (
            <small
              data-testid="card-line"
              style={{ display: 'block', color: COLORS.muted, fontSize: 13 }}
            >
              {line}
            </small>
          )}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          {found && <LinksAndSignal found={found} />}
          <Status row={status} testId="card-status" warnIcon={warnIcon} />
        </span>
        <span aria-hidden />
      </header>
      <div style={{ display: 'grid', gap: 16, padding: '4px 14px 16px' }}>
        {facts.length > 0 && <Facts facts={facts} />}
        {tip && <Tip tip={tip} />}
        {children}
      </div>
    </section>
  );
}

const ACTIONS = { display: 'flex', flexWrap: 'wrap', gap: 8 } as const;

/** A button with an icon before its word. */
const ICON_BUTTON = { display: 'inline-flex', alignItems: 'center', gap: 8 } as const;

/** Remove, of a device or the companion: red, with a bin icon. */
const REMOVE = { ...BUTTON, ...ICON_BUTTON, borderColor: COLORS.red, color: COLORS.red } as const;

const LINK_NAMES: Record<BleRoute, string> = { local: 'Direct', companion: 'Companion' };

/** How the card's line names the link that carries the device. */
const OVER: Record<BleRoute, string> = { local: 'Bluetooth', companion: 'companion' };

/** The signal of a device found: four bars, as phones show them, the strong ones lit. */
function Signal({ rssi }: { readonly rssi: number }) {
  const bars = signalBars(rssi);
  const name = `Signal ${bars} of 4`;
  return (
    <span
      role="img"
      aria-label={name}
      title={name}
      data-testid="found-signal"
      style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 2, height: 14, flex: 'none' }}
    >
      {[1, 2, 3, 4].map((bar) => (
        <span
          key={bar}
          style={{
            width: 3,
            height: 3 + bar * 2.75,
            borderRadius: 1,
            background: bar <= bars ? COLORS.cyan : COLORS.line,
          }}
        />
      ))}
    </span>
  );
}

/** Every Connect names the link it uses. */
function connectWith(route: BleRoute): string {
  return route === 'local' ? 'with Bluetooth' : 'with companion';
}

/** The links shown and the signal of a device found, at the right of its row. */
function LinksAndSignal({ found }: { readonly found: DeviceCandidate }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: COLORS.muted }}>
      {found.routes.map((route) => (
        <LinkIcon key={route} route={route} label={LINK_NAMES[route]} />
      ))}
      {found.rssi !== undefined && <Signal rssi={found.rssi} />}
    </span>
  );
}

const CHEVRON = (
  <span aria-hidden style={{ color: COLORS.muted, fontStyle: 'normal' }}>
    ›
  </span>
);

/** A device found, over one link: its icon, its name and the link, as a row of the setup has. */
function FoundButton({
  kind,
  found,
  onConnect,
  className = 'rd-row',
  style = ROW,
}: {
  readonly kind: RowKind;
  readonly found: DeviceCandidate;
  readonly onConnect: () => void;
  readonly className?: string;
  readonly style?: CSSProperties;
}) {
  const name = found.deviceName || found.deviceId;
  const how = connectWith(linkOf(found));
  return (
    <button
      type="button"
      className={className}
      aria-label={`Connect ${name} ${how}`}
      onClick={onConnect}
      style={style}
    >
      <span style={{ display: 'flex', justifyContent: 'center', color: COLORS.cyan }}>
        <KindIcon kind={kind} />
      </span>
      <span style={{ minWidth: 0 }}>
        <b data-testid="found-name" style={{ ...ROW_TITLE, display: 'block' }}>
          {name}
        </b>
        <small style={{ display: 'block', color: COLORS.muted, fontSize: 13 }}>
          Connect {how}
        </small>
      </span>
      <LinksAndSignal found={found} />
      {CHEVRON}
    </button>
  );
}

/** Another device of the kind found, over one link: a row like those of the setup. */
function FoundRow({
  kind,
  found,
  onConnect,
}: {
  readonly kind: RowKind;
  readonly found: DeviceCandidate;
  readonly onConnect: () => void;
}) {
  return (
    <li>
      <FoundButton kind={kind} found={found} onConnect={onConnect} />
    </li>
  );
}

/** The line on top of a box: the row of a device of one link, the box drawing its border. */
const MAIN_LINE = {
  ...ROW,
  border: 'none',
  background: 'transparent',
  borderRadius: '16px 16px 0 0',
} as const;

/** A line below it: another way to connect, smaller and quieter than the line on top. */
const OTHER_LINE = {
  ...MAIN_LINE,
  borderTop: `1px solid ${COLORS.line}`,
  padding: '8px 14px 10px',
  color: COLORS.muted,
  fontSize: 14,
} as const;

/** This device's Bluetooth leads; the companion is the other way. */
const ROUTE_ORDER: Record<BleRoute, number> = { local: 0, companion: 1 };

const routeRank = (c: DeviceCandidate) => ROUTE_ORDER[linkOf(c)];

/**
 * A device found over both links: one box that names it once. On top the row a device of one
 * link has, over this device's Bluetooth; below it, a quieter line per other link.
 */
function FoundGroup({
  kind,
  links,
  onConnect,
}: {
  readonly kind: RowKind;
  readonly links: readonly DeviceCandidate[];
  readonly onConnect: (deviceId: string) => void;
}) {
  const [main, ...others] = [...links].sort((a, b) => routeRank(a) - routeRank(b));
  if (!main) return null;
  const name = main.deviceName || main.deviceId;
  return (
    <li style={PANEL}>
      <FoundButton
        kind={kind}
        found={main}
        onConnect={() => onConnect(main.deviceId)}
        className="rd-row rd-line"
        style={MAIN_LINE}
      />
      {others.map((link, i) => {
        const how = connectWith(linkOf(link));
        const last = i === others.length - 1;
        return (
          <button
            key={link.deviceId}
            type="button"
            className="rd-row rd-line"
            aria-label={`Connect ${name} ${how}`}
            onClick={() => onConnect(link.deviceId)}
            style={{ ...OTHER_LINE, borderRadius: last ? '0 0 16px 16px' : 0 }}
          >
            <span aria-hidden />
            <span>or connect {how}</span>
            <LinksAndSignal found={link} />
            {CHEVRON}
          </button>
        );
      })}
    </li>
  );
}

/** States in which the device is held or tried: Remove ends that. */
const HELD = new Set(['connecting', 'connected', 'reconnecting']);

/** How ridrs controls the trainer, in a word or two: facts only (ADR 0056). */
function controlFact(control: TrainerControlChangedPayload): Fact {
  const value =
    control.mode === 'erg'
      ? `ERG ${control.targetPower ?? ''} W`
      : control.control === 'granted'
        ? control.mode === 'simulation'
          ? 'simulation'
          : 'ready'
        : control.control === 'unsupported'
          ? 'not supported'
          : control.control;
  const tone: Tone =
    control.control === 'granted'
      ? 'ok'
      : control.control === 'requested'
        ? 'busy'
        : control.control === 'unsupported'
          ? 'none'
          : 'warn';
  return { icon: 'status', term: 'Control', value, tone };
}

/** The trainer's control state, as its device plugin published it last for the device. */
function useTrainerControl(
  ctx: UiContext,
  deviceId: string,
  kind: string,
): TrainerControlChangedPayload | undefined {
  const [control, setControl] = useState<TrainerControlChangedPayload>();
  useEffect(
    () =>
      kind === 'trainer'
        ? ctx.events.subscribe(trainerControlChangedEvent, ({ payload }) => setControl(payload))
        : undefined,
    [ctx, kind],
  );
  return control?.deviceId === deviceId ? control : undefined;
}

function DeviceDetails({
  ctx,
  row,
  companion,
  onClose,
}: {
  readonly ctx: UiContext;
  readonly row: DeviceRow;
  /** Whether ridrs is connected to the companion: nothing connects with it before. */
  readonly companion: boolean;
  /** Connect and Remove close the details: the row shows how it goes. */
  readonly onClose: () => void;
}) {
  const kind = row.deviceKind;
  const known = row.deviceId !== '';
  const route = row.route ?? 'local';
  const control = useTrainerControl(ctx, row.deviceId, kind);
  // The signal of the device itself, as the devices found show theirs.
  const signal = row.candidates.find((c) => c.deviceId === row.deviceId)?.rssi;
  const reconnect = row.state === 'disconnected' && (route === 'local' || companion);
  // The strongest first when the details open; then the rows stay where they are.
  const shown = useRef<string[]>([]);
  const others = inShownOrder(
    shown.current,
    row.candidates.filter((c) => c.deviceId !== row.deviceId),
  );
  shown.current = others.map((c) => c.deviceId);
  // The device itself, seen over another link: its card offers that link next to Remove.
  const itself = (c: DeviceCandidate) => known && c.sameDeviceAs === row.deviceId;
  const links = kind === 'controller' ? [] : others.filter(itself);
  const groups = kind === 'controller' ? [] : byDevice(others.filter((c) => !itself(c)));
  const connect = (deviceId: string) => {
    ctx.events.publish(deviceConnectRequestedEvent, { kind, deviceId });
    onClose();
  };
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {/* Without a current device there is no card: the devices found follow the heading. */}
      {known && (
        <DetailsCard
          icon={<KindIcon kind={row.kind} />}
          device={row.detail}
          // The power row shows the trainer: the page names the power meter, the line the trainer.
          line={row.kind !== kind ? `${row.type} over ${OVER[route]}` : `Over ${OVER[route]}`}
          found={{
            deviceId: row.deviceId,
            deviceName: row.deviceName,
            routes: [route],
            ...(signal === undefined ? {} : { rssi: signal }),
          }}
          status={row}
          facts={control && row.state === 'connected' ? [controlFact(control)] : []}
          tip={row.tip}
        >
          {(HELD.has(row.state) || reconnect || links.length > 0) && (
            <div style={ACTIONS}>
              {HELD.has(row.state) ? (
                <button
                  type="button"
                  style={REMOVE}
                  onClick={() => {
                    ctx.events.publish(deviceForgetRequestedEvent, { kind });
                    onClose();
                  }}
                >
                  <TrashIcon />
                  Remove
                </button>
              ) : (
                reconnect && (
                  <button type="button" style={BUTTON} onClick={() => connect(row.deviceId)}>
                    Connect {connectWith(route)}
                  </button>
                )
              )}
              {links.map((link) => {
                const via = linkOf(link);
                const name = `Switch to ${OVER[via]}`;
                return (
                  // The icon names itself: the label keeps the button's name short.
                  <button
                    key={link.deviceId}
                    type="button"
                    aria-label={name}
                    style={{ ...BUTTON, ...ICON_BUTTON }}
                    onClick={() => connect(link.deviceId)}
                  >
                    <LinkIcon route={via} label={LINK_NAMES[via]} />
                    {name}
                  </button>
                );
              })}
            </div>
          )}
        </DetailsCard>
      )}
      {/* A controller pair is one row for two devices: they are not swapped one by one. */}
      {groups.length > 0 && (
        <ul
          aria-label="Devices found"
          style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }}
        >
          {groups.map((group) =>
            group.length === 1 && group[0] ? (
              <FoundRow
                key={group[0].deviceId}
                kind={row.kind}
                found={group[0]}
                onConnect={() => connect(group[0]?.deviceId ?? '')}
              />
            ) : (
              <FoundGroup
                key={group[0]?.deviceId}
                kind={row.kind}
                links={group}
                onConnect={connect}
              />
            ),
          )}
        </ul>
      )}
    </div>
  );
}

/** Where the companion is paired (QR code, code fields): another plugin contributes it. */
const PAIRING_SLOT = 'setup/companion';

function CompanionDetails({
  ctx,
  companion,
  onClose,
}: {
  readonly ctx: UiContext;
  readonly companion: CompanionRow;
  /** Connect closes the details, as for a device. */
  readonly onClose: () => void;
}) {
  const pairing = useRef<HTMLDivElement>(null);
  useEffect(() => (pairing.current ? ctx.slot(PAIRING_SLOT, pairing.current) : undefined), [ctx]);
  const paired = companion.state !== 'unpaired' && companion.state !== 'rejected';
  const facts: Fact[] = companion.reason
    ? [{ icon: 'status', term: 'Reason', value: companion.reason, tone: companion.tone }]
    : [];
  const reconnect = companion.state === 'disconnected' || companion.state === 'unreachable';
  return (
    <DetailsCard
      icon={<PhoneIcon />}
      device={companion.detail}
      status={companion}
      warnIcon={false}
      facts={facts}
      tip={companion.tip}
    >
      <div ref={pairing} data-testid="slot-setup-companion" />
      {(reconnect || paired) && (
        <div style={ACTIONS}>
          {reconnect && (
            <button
              type="button"
              style={BUTTON}
              onClick={() => {
                ctx.events.publish(bridgeConnectRequestedEvent, {});
                onClose();
              }}
            >
              {companion.state === 'unreachable' ? 'Try again' : 'Connect'}
            </button>
          )}
          {paired && (
            // As a device's Remove; the details stay open and show the pairing again.
            <button
              type="button"
              style={REMOVE}
              onClick={() => ctx.events.publish(bridgeForgetRequestedEvent, {})}
            >
              <TrashIcon />
              Remove
            </button>
          )}
        </div>
      )}
    </DetailsCard>
  );
}

const TITLE = { textAlign: 'center', fontSize: 34, fontWeight: 800, margin: '14px 0 6px' } as const;

const SUBTITLE = {
  textAlign: 'center',
  color: COLORS.muted,
  fontSize: 15,
  margin: '0 0 18px',
} as const;

/** Which row's details are open: a kind of device, or the companion. */
type Open = RowKind | 'companion';

/**
 * Connect Your Devices: one row per kind, live; a connected device proves in its status that it
 * works. A click on a row shows its details instead of the rows; Back closes them. While the
 * setup is open, the device plugins keep looking for devices, so others of a kind show up as
 * "+1", and a kind that searches counts the devices found.
 * Continue (Done once everything is connected) leads back to the main screen; a ride never needs
 * a device, so nothing here blocks it.
 */
export function DeviceSetupView({
  ctx,
  devices,
  readings,
  bridge,
}: {
  readonly ctx: UiContext;
  readonly devices: readonly DeviceStatus[];
  readonly readings: Readings;
  /** The companion bridge, when its transport runs. */
  readonly bridge?: BridgeStatus;
}) {
  const [open, setOpen] = useState<Open>();
  // The row whose details were open last gets the focus back when they close.
  const opened = useRef<Open>(undefined);
  // A thought on the heart, another each time the details open; the UI only, never the ride.
  const [thought, setThought] = useState(0);
  const show = (row: Open) => {
    opened.current = row;
    setThought(Math.floor(Math.random() * HEART_RATE_THOUGHTS.length));
    setOpen(row);
  };
  const close = () => setOpen(undefined);
  useEffect(() => {
    ctx.events.publish(deviceDiscoveryRequestedEvent, { active: true });
    return () => ctx.events.publish(deviceDiscoveryRequestedEvent, { active: false });
  }, [ctx]);

  const summary = summarize(devices);
  const rows = describeDevices(overLinksInReach(devices, bridge?.state), readings);
  const companion = bridge ? describeCompanion(bridge) : undefined;
  const openRow = open === 'companion' ? undefined : rows.find((r) => r.kind === open);
  const details = (open === 'companion' && companion !== undefined) || openRow !== undefined;
  const heading =
    open === 'companion' && companion
      ? { icon: <PhoneIcon />, title: companion.title, about: companion.about }
      : openRow
        ? {
            icon: <KindIcon kind={openRow.kind} />,
            title: openRow.title,
            about:
              openRow.kind === 'heart-rate'
                ? (HEART_RATE_THOUGHTS[thought] ?? openRow.about)
                : openRow.about,
            // At the top right: whether ridrs looks for devices of the kind, over any link.
            searching: openRow.scanning.length > 0,
          }
        : undefined;
  const back = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    // The details are a short stop: Back has the focus; closed, the focus is on their row again.
    if (details) {
      back.current?.focus();
    } else if (opened.current) {
      list.current
        ?.querySelector<HTMLButtonElement>(`[data-kind="${opened.current}"] button`)
        ?.focus();
    }
  }, [details]);
  // Back closes the details, or leaves the setup.
  const leave = useRef(close);
  leave.current = details ? close : () => ctx.navigate(MAIN);
  useEffect(() => ctx.onBack(() => leave.current()), [ctx]);
  return (
    <main
      style={{
        boxSizing: 'border-box',
        minHeight: '100%',
        padding: '32px 16px',
        display: 'flex',
        justifyContent: 'center',
        background: 'radial-gradient(1200px 600px at 50% -10%, #0b2236, #03070d)',
        color: '#fff',
        fontFamily: 'system-ui, sans-serif',
        fontStyle: 'italic',
      }}
    >
      <DeviceStyles />
      <div
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: 600,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* The details' top bar: Back at the left, whether ridrs looks at the right. */}
        {heading && (
          <div
            data-testid="details-bar"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <button
              ref={back}
              type="button"
              aria-label="Back"
              className="rd-back"
              onClick={close}
              style={{
                width: 40,
                height: 40,
                display: 'grid',
                placeItems: 'center',
                borderRadius: '50%',
                border: `1.5px solid ${COLORS.line}`,
                background: COLORS.panel,
                color: '#fff',
                fontSize: 22,
                fontStyle: 'normal',
              }}
            >
              <span aria-hidden>‹</span>
            </button>
            {'searching' in heading && (
              <StatusPill
                status={heading.searching ? 'Searching…' : 'Not searching'}
                tone={heading.searching ? 'busy' : 'none'}
              />
            )}
          </div>
        )}
        {/* The details name the kind they show, the rows the setup. */}
        {heading ? (
          <>
            <div style={{ display: 'flex', justifyContent: 'center', color: COLORS.cyan }}>
              {heading.icon}
            </div>
            <h1 style={TITLE}>{heading.title}</h1>
            <p data-testid="details-about" style={SUBTITLE}>
              {heading.about}
            </p>
          </>
        ) : (
          <>
            <div style={{ display: 'flex', justifyContent: 'center', color: COLORS.cyan }}>
              <BikeIcon />
            </div>
            <h1 style={TITLE}>
              Connect Your{' '}
              <em
                style={{
                  background: `linear-gradient(90deg, ${COLORS.cyan}, ${COLORS.lime})`,
                  WebkitBackgroundClip: 'text',
                  backgroundClip: 'text',
                  color: 'transparent',
                }}
              >
                Devices
              </em>
            </h1>
            <p data-testid="device-summary" aria-live="polite" style={SUBTITLE}>
              {summary.text}
            </p>
          </>
        )}
        {open === 'companion' && companion ? (
          <CompanionDetails ctx={ctx} companion={companion} onClose={close} />
        ) : openRow ? (
          <DeviceDetails
            ctx={ctx}
            row={openRow}
            companion={bridge?.state === 'connected'}
            onClose={close}
          />
        ) : (
          <ul
            ref={list}
            aria-label="Devices"
            style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }}
          >
            {rows.map((row) => (
              <Row
                key={row.kind}
                kind={row.kind}
                icon={<KindIcon kind={row.kind} />}
                title={row.title}
                detail={row.detail}
                status={row}
                more={row.more}
                found={row.found}
                onOpen={() => show(row.kind)}
              />
            ))}
            {companion && (
              <Row
                kind="companion"
                icon={<PhoneIcon />}
                title={companion.title}
                detail={companion.detail}
                status={companion}
                warnIcon={false}
                onOpen={() => show('companion')}
              />
            )}
          </ul>
        )}
        {!details && (
          <button
            type="button"
            className="rd-continue"
            onClick={() => ctx.navigate(MAIN)}
            style={{
              marginTop: 22,
              padding: 18,
              fontSize: 26,
              fontWeight: 800,
              fontStyle: 'italic',
              color: '#fff',
              background: COLORS.panel,
              border: `1.5px solid ${COLORS.line}`,
              borderRadius: 14,
            }}
          >
            {summary.settled ? 'Done' : 'Continue'}{' '}
            <span aria-hidden style={{ color: COLORS.lime }}>
              »
            </span>
          </button>
        )}
      </div>
    </main>
  );
}
