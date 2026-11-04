// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type BleRoute,
  bridgeConnectRequestedEvent,
  bridgeForgetRequestedEvent,
  type ControllerButton,
  type DeviceStatus,
  deviceConnectRequestedEvent,
  deviceDisconnectRequestedEvent,
  deviceDiscoveryRequestedEvent,
  deviceRouteRequestedEvent,
} from '@ridrs/contracts';
import type { UiContext } from '@ridrs/ui-sdk';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import {
  BUTTON_FACES,
  type BridgeStatus,
  type CompanionRow,
  type DeviceRow,
  describeCompanion,
  describeDevices,
  type Readings,
  type RowKind,
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
  PhoneIcon,
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

/**
 * The "ok" badge: a check, or the buttons held down on the controller in its place, one badge
 * each (named for screen readers by `aria-label`).
 */
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

function Status({ row }: { readonly row: StatusView }) {
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
      {row.status}
      {row.tone === 'ok' && <OkBadges row={row} />}
      {row.tone === 'busy' && (
        <span aria-hidden style={ICON_SLOT}>
          <span className="rd-spin" />
        </span>
      )}
      {row.tone === 'none' && <span aria-hidden style={ICON_SLOT} />}
      {row.tone === 'warn' && (
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

/** "+2": more devices of the kind were found; the details offer to connect one of them. */
function MoreFound({ count }: { readonly count: number }) {
  return (
    <span
      data-testid="more-found"
      role="img"
      aria-label={`${count} more found`}
      title={`${count} more found`}
      style={{
        marginLeft: 8,
        padding: '1px 7px',
        borderRadius: 9,
        border: `1.5px solid ${COLORS.cyan}`,
        color: COLORS.cyan,
        fontSize: 12,
        fontStyle: 'normal',
        fontWeight: 700,
        verticalAlign: 'middle',
      }}
    >
      {`+${count}`}
    </span>
  );
}

function Row({
  icon,
  title,
  detail,
  status,
  more = 0,
  kind,
  onOpen,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly detail: string;
  readonly status: StatusView;
  readonly more?: number;
  readonly kind: string;
  readonly onOpen: () => void;
}) {
  return (
    <li data-testid="device-row" data-kind={kind}>
      <button
        type="button"
        className="rd-row"
        onClick={onOpen}
        style={{
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
        }}
      >
        <span style={{ display: 'flex', justifyContent: 'center', color: COLORS.cyan }}>
          {icon}
        </span>
        <span style={{ minWidth: 0 }}>
          <b data-testid="device-title" style={{ fontSize: 18 }}>
            {title}
          </b>
          {more > 0 && <MoreFound count={more} />}
          <small
            data-testid="device-detail"
            style={{ display: 'block', color: COLORS.muted, fontSize: 13 }}
          >
            {detail}
          </small>
        </span>
        <Status row={status} />
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

const CAPS = {
  margin: 0,
  color: COLORS.muted,
  fontSize: 12,
  fontStyle: 'normal',
  letterSpacing: 1.5,
  textTransform: 'uppercase',
} as const;

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

/** The status in the card's header: a pill in the tone's colour. */
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
      <span aria-hidden style={{ fontStyle: 'normal' }}>
        {TONE_ICON[tone]}
      </span>
      <span data-testid="details-status">{status}</span>
    </span>
  );
}

function Tip({ tip }: { readonly tip: string }) {
  return (
    <aside
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 14px',
        borderRadius: 12,
        border: `1px solid ${COLORS.line}`,
        background: '#0d1d2b',
      }}
    >
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

/**
 * A row's details: a short card in place of the rows. A header with the device and its status,
 * what it is for, the facts the header does not show, a tip while there is something to do, and
 * the actions.
 */
function DetailsCard({
  icon,
  title,
  subtitle,
  status,
  about,
  facts,
  tip,
  children,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly subtitle: string;
  readonly status: Pick<DeviceRow, 'status' | 'tone'>;
  readonly about: string;
  readonly facts: readonly Fact[];
  readonly tip?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      data-testid="details-card"
      style={{ ...PANEL, display: 'grid', gap: 16, padding: '18px 18px 20px' }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ color: COLORS.cyan }}>{icon}</span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 22 }}>{title}</h2>
          <small
            data-testid="details-subtitle"
            style={{ display: 'block', color: COLORS.muted, fontSize: 14, overflowWrap: 'anywhere' }}
          >
            {subtitle}
          </small>
        </span>
        <StatusPill status={status.status} tone={status.tone} />
      </header>
      <p style={{ margin: 0, color: COLORS.muted, fontSize: 15 }}>{about}</p>
      {facts.length > 0 && <Facts facts={facts} />}
      {tip && <Tip tip={tip} />}
      {children}
    </section>
  );
}

const ACTIONS = { display: 'flex', flexWrap: 'wrap', gap: 8 } as const;

const LINK_NAMES: Record<BleRoute, string> = { local: 'Direct', companion: 'Companion' };

/** Direct or through the companion: whose data is used. Nothing connects or disconnects. */
function LinkChoice({
  route,
  onChoose,
}: {
  readonly route: BleRoute;
  readonly onChoose: (route: BleRoute) => void;
}) {
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <h3 style={CAPS}>Use the data of</h3>
      <div role="radiogroup" aria-label="Link" style={{ display: 'flex', gap: 8 }}>
        {(Object.keys(LINK_NAMES) as BleRoute[]).map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={option === route}
            onClick={() => option !== route && onChoose(option)}
            style={{
              ...BUTTON,
              flex: 1,
              background: option === route ? COLORS.cyan : BUTTON.background,
              color: option === route ? '#031' : BUTTON.color,
            }}
          >
            {LINK_NAMES[option]}
          </button>
        ))}
      </div>
    </div>
  );
}

/** States in which the device is held or tried: Disconnect ends that. */
const HELD = new Set(['connecting', 'connected', 'reconnecting']);

function DeviceDetails({
  ctx,
  row,
  onClose,
}: {
  readonly ctx: UiContext;
  readonly row: DeviceRow;
  /** Connect and Disconnect close the details: the row shows how it goes. */
  readonly onClose: () => void;
}) {
  const kind = row.deviceKind;
  const known = row.deviceId !== '';
  const route = row.route ?? 'local';
  const others = row.candidates.filter((c) => c.deviceId !== row.deviceId);
  const bothLinks = row.connectedRoutes.length > 1;
  const connect = (deviceId: string) => {
    ctx.events.publish(deviceConnectRequestedEvent, { kind, deviceId });
    onClose();
  };
  return (
    <DetailsCard
      icon={<KindIcon kind={row.kind} />}
      title={row.title}
      subtitle={row.detail}
      status={row}
      about={row.about}
      facts={
        known
          ? [
              // The power row shows the trainer: the header names the power meter.
              ...(row.kind !== kind
                ? [{ icon: 'type', term: 'Source', value: row.type } as const]
                : []),
              { icon: 'link', term: 'Link', value: LINK_NAMES[route] },
            ]
          : []
      }
      tip={row.tip}
    >
      {known && bothLinks && (
        <LinkChoice
          route={route}
          onChoose={(link) => ctx.events.publish(deviceRouteRequestedEvent, { kind, route: link })}
        />
      )}
      {/* A controller pair is one row for two devices: they are not swapped one by one. */}
      {kind !== 'controller' && others.length > 0 && (
        <div style={{ display: 'grid', gap: 8 }}>
          <h3 style={CAPS}>Also found</h3>
          <ul
            aria-label="Also found"
            style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}
          >
            {others.map((other) => (
              <li
                key={other.deviceId}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  padding: '8px 12px',
                  borderRadius: 12,
                  border: `1px solid ${COLORS.line}`,
                }}
              >
                <span style={{ overflowWrap: 'anywhere' }}>
                  {other.deviceName || other.deviceId}
                </span>
                <button
                  type="button"
                  style={BUTTON}
                  aria-label={`Connect ${other.deviceName || other.deviceId}`}
                  onClick={() => connect(other.deviceId)}
                >
                  Connect
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {known && (HELD.has(row.state) || row.state === 'disconnected') && (
        <div style={ACTIONS}>
          {HELD.has(row.state) ? (
            <button
              type="button"
              style={BUTTON}
              onClick={() => {
                ctx.events.publish(deviceDisconnectRequestedEvent, { kind });
                onClose();
              }}
            >
              Disconnect
            </button>
          ) : (
            <button type="button" style={BUTTON} onClick={() => connect(row.deviceId)}>
              Connect
            </button>
          )}
        </div>
      )}
    </DetailsCard>
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
      title={companion.title}
      subtitle={companion.detail}
      status={companion}
      about={companion.about}
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
            <button
              type="button"
              style={{ ...BUTTON, borderColor: COLORS.line, color: COLORS.muted }}
              onClick={() => ctx.events.publish(bridgeForgetRequestedEvent, {})}
            >
              Forget companion
            </button>
          )}
        </div>
      )}
    </DetailsCard>
  );
}

/** Which row's details are open: a kind of device, or the companion. */
type Open = RowKind | 'companion';

/**
 * Connect Your Devices: one row per kind, live; a connected device proves in its status that it
 * works. A click on a row shows its details instead of the rows; Back closes them. While the setup is open, the
 * device plugins keep looking for devices, so others of a kind show up as "+1".
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
  const show = (row: Open) => {
    opened.current = row;
    setOpen(row);
  };
  const close = () => setOpen(undefined);
  useEffect(() => {
    ctx.events.publish(deviceDiscoveryRequestedEvent, { active: true });
    return () => ctx.events.publish(deviceDiscoveryRequestedEvent, { active: false });
  }, [ctx]);

  const summary = summarize(devices);
  const rows = describeDevices(devices, readings);
  const companion = bridge ? describeCompanion(bridge) : undefined;
  const openRow = open === 'companion' ? undefined : rows.find((r) => r.kind === open);
  const details = (open === 'companion' && companion !== undefined) || openRow !== undefined;
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
        {details && (
          <button
            ref={back}
            type="button"
            aria-label="Back"
            className="rd-back"
            onClick={close}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
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
        )}
        <div style={{ display: 'flex', justifyContent: 'center', color: COLORS.cyan }}>
          <BikeIcon />
        </div>
        <h1 style={{ textAlign: 'center', fontSize: 34, fontWeight: 800, margin: '14px 0 6px' }}>
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
        <p
          data-testid="device-summary"
          aria-live="polite"
          style={{ textAlign: 'center', color: COLORS.muted, fontSize: 15, margin: '0 0 18px' }}
        >
          {summary.text}
        </p>
        {open === 'companion' && companion ? (
          <CompanionDetails ctx={ctx} companion={companion} onClose={close} />
        ) : openRow ? (
          <DeviceDetails ctx={ctx} row={openRow} onClose={close} />
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
