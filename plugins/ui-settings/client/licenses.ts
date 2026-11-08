// SPDX-License-Identifier: AGPL-3.0-or-later

/** What the licenses screen needs (ADR 0073); `texts` holds each distinct text once. */
export interface LicenseData {
  readonly appName: string;
  readonly appVersion: string;
  readonly appLicense: string;
  readonly appText: string;
  readonly components: readonly LicenseComponent[];
  readonly content: readonly LicenseContent[];
  readonly texts: Readonly<Record<string, string>>;
}

export interface LicenseComponent {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly purpose: string;
  /** Keys into `texts`. */
  readonly texts: readonly string[];
}

export interface LicenseContent {
  readonly name: string;
  readonly author: string;
  readonly origin: string;
  readonly license: string;
  readonly note: string;
  readonly texts: readonly string[];
}
