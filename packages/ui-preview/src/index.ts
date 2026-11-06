// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The clickable preview of the app's areas in the early alpha (ADR 0059): what the area plugins
 * share, so that none of them imports another.
 */
export {
  ActionButton,
  AreaPage,
  iconStyle,
  MenuEntry,
  PreviewLabel,
  reactComponent,
  TodayCard,
  Toggle,
  useBack,
  useShownScreen,
} from './parts.tsx';
export { PREVIEW_CSS } from './style.ts';
export { type UseUserDocument, userDocument } from './user-document.ts';
